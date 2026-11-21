'use strict';
// Registro de Horas — servidor sin dependencias externas (Node 22.5+).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const TZ = process.env.APP_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const CURRENCY = process.env.APP_CURRENCY || '₪';
// Jornada normal: las horas que pasen de esto en un día se pagan como horas extra.
const DAY_MIN = 8 * 60;
const OT_PCT = 50; // recargo de la hora extra (%) cuando el administrador no fija un precio
const BUSINESS = process.env.APP_NAME || 'Registro de Horas';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'horas.db');
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const SETUP_CODE = process.env.SETUP_CODE || '';
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- Base de datos
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('admin','worker')),
  name TEXT NOT NULL,
  username TEXT UNIQUE,
  email TEXT UNIQUE,
  phone TEXT,
  rate REAL,
  secret_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts INTEGER,
  break_min INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'clock',
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER,
  updated_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(work_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open ON entries(user_id) WHERE end_ts IS NULL;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL
);
`);
// Migración: precio de la hora extra (columna nueva).
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'ot_rate')) db.exec('ALTER TABLE users ADD COLUMN ot_rate REAL');

const q = (sql) => db.prepare(sql);

// ---------------------------------------------------------------- Utilidades
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(secret), salt, 32);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function checkSecret(secret, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(secret), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Zona horaria del negocio: toda fecha/hora "local" se calcula aquí, nunca en el celular.
const dtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
function parts(ts) { const o = {}; for (const p of dtf.formatToParts(new Date(ts))) o[p.type] = p.value; return o; }
function localDate(ts) { const p = parts(ts); return `${p.year}-${p.month}-${p.day}`; }
function localTime(ts) { const p = parts(ts); return `${p.hour}:${p.minute}`; }
function tzOffset(ts) {
  const p = parts(ts);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}
function zonedToEpoch(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - tzOffset(guess);
  const o2 = tzOffset(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}
function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function weekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // lunes = 0
  return addDays(date, -wd);
}
const monthStart = (date) => date.slice(0, 8) + '01';
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function entryMinutes(e) {
  if (e.end_ts == null) return 0;
  return Math.max(0, Math.round((e.end_ts - e.start_ts) / 60000) - (e.break_min || 0));
}
function publicEntry(e) {
  return {
    id: e.id, userId: e.user_id, name: e.name, date: e.work_date,
    start: e.start_ts, end: e.end_ts, startTime: localTime(e.start_ts),
    endTime: e.end_ts == null ? null : localTime(e.end_ts),
    endDate: e.end_ts == null ? null : localDate(e.end_ts),
    breakMin: e.break_min, minutes: entryMinutes(e), source: e.source, note: e.note || '',
  };
}

// Convierte fecha + horas (en la zona del negocio) a marcas de tiempo, validando.
function buildTimes(b, { requireEnd = false } = {}) {
  if (!isDate(b.date)) throw bad('La fecha no es válida.');
  if (!isTime(b.start)) throw bad('La hora de entrada no es válida.');
  const start = zonedToEpoch(b.date, b.start);
  let end = null;
  if (b.end) {
    if (!isTime(b.end)) throw bad('La hora de salida no es válida.');
    end = zonedToEpoch(b.date, b.end);
    if (end <= start) end = zonedToEpoch(addDays(b.date, 1), b.end); // turno que pasa la medianoche
    if (end - start > 24 * 3600e3) throw bad('Un turno no puede durar más de 24 horas.');
  } else if (requireEnd) throw bad('Indica la hora de salida.');
  const breakMin = parseInt(b.breakMin ?? 0, 10);
  if (!Number.isFinite(breakMin) || breakMin < 0 || breakMin > 600) throw bad('Los minutos de descanso no son válidos.');
  if (end != null && breakMin >= (end - start) / 60000) throw bad('El descanso no puede ser igual o mayor que el tiempo trabajado.');
  return { start, end, breakMin, date: b.date };
}

function assertNoOverlap(userId, start, end, exceptId = 0) {
  const now = Date.now();
  const row = q(`SELECT id, start_ts, end_ts FROM entries
    WHERE user_id = ? AND id != ? AND start_ts < ? AND COALESCE(end_ts, ?) > ? LIMIT 1`)
    .get(userId, exceptId, end ?? 8.64e15, now, start);
  if (row) {
    throw bad(`Se cruza con otro registro (${localDate(row.start_ts)} ${localTime(row.start_ts)}–${row.end_ts ? localTime(row.end_ts) : 'sin salida'}).`);
  }
}

// ---------------------------------------------------------------- Sesiones y límites
const fails = new Map();
function lockedMinutes(key) {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
function registerFail(key) {
  const f = fails.get(key) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 5) { f.until = Date.now() + 5 * 60e3; f.n = 0; }
  fails.set(key, f);
}
function checkLocks(keys) {
  for (const k of keys) {
    const m = lockedMinutes(k);
    if (m) throw new HttpError(429, `Demasiados intentos. Espera ${m} minuto(s) e inténtalo de nuevo.`);
  }
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  q('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  q('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha(token), userId, expires);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${SECURE_COOKIE ? '; Secure' : ''}`);
}
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  return q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires > ? AND u.active = 1`).get(sha(token), Date.now()) || null;
}
function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, username: u.username, email: u.email, phone: u.phone || '', rate: u.rate, otRate: u.ot_rate, otRateAuto: otRateOf({ rate: u.rate }), active: !!u.active };
}

// Precio de la hora extra: el que fije el administrador, o el valor de una hora normal (pago del día / 8) + 50 %.
function otRateOf(u) {
  if (u.ot_rate != null && u.ot_rate >= 0) return u.ot_rate;
  if (u.rate == null || !(u.rate > 0)) return null;
  return Math.round(u.rate / (DAY_MIN / 60) * (1 + OT_PCT / 100) * 100) / 100;
}

// ---------------------------------------------------------------- Informes
function report(from, to, workerId) {
  if (!isDate(from) || !isDate(to) || from > to) throw bad('Rango de fechas no válido.');
  const params = [from, to];
  let where = 'e.work_date BETWEEN ? AND ?';
  if (workerId) { where += ' AND e.user_id = ?'; params.push(workerId); }
  const rows = q(`SELECT e.*, u.name FROM entries e JOIN users u ON u.id = e.user_id
    WHERE ${where} ORDER BY e.work_date, u.name, e.start_ts`).all(...params);

  const workers = workerId
    ? q("SELECT * FROM users WHERE role = 'worker' AND id = ?").all(workerId)
    : q("SELECT * FROM users WHERE role = 'worker' AND (active = 1 OR id IN (SELECT user_id FROM entries WHERE work_date BETWEEN ? AND ?)) ORDER BY name COLLATE NOCASE").all(from, to);

  const byId = new Map(workers.map((w) => [w.id, {
    id: w.id, name: w.name, rate: w.rate, otRate: otRateOf(w), active: !!w.active, minutes: 0, extraMinutes: 0, basePay: null, extraPay: null, days: new Set(), byDate: {}, open: 0, pay: null,
  }]));
  for (const e of rows) {
    const w = byId.get(e.user_id);
    if (!w) continue;
    if (e.end_ts == null) { w.open += 1; continue; }
    const m = entryMinutes(e);
    w.minutes += m;
    w.days.add(e.work_date);
    w.byDate[e.work_date] = (w.byDate[e.work_date] || 0) + m;
  }
  // Pago: cada día se paga la jornada (8 h = pago del día; si trabaja menos, la parte proporcional)
  // y cada hora que pase de 8 ese día se paga al precio de la hora extra.
  let totalMin = 0, totalExtra = 0, totalPay = 0, anyPay = false;
  const summary = [...byId.values()].map((w) => {
    totalMin += w.minutes;
    let regular = 0, extra = 0;
    for (const m of Object.values(w.byDate)) { regular += Math.min(m, DAY_MIN); extra += Math.max(0, m - DAY_MIN); }
    w.extraMinutes = extra; totalExtra += extra;
    if (w.rate != null && w.rate > 0) {
      w.basePay = Math.round(w.rate * regular / DAY_MIN * 100) / 100;
      w.extraPay = Math.round((w.otRate || 0) * extra / 60 * 100) / 100;
      w.pay = Math.round((w.basePay + w.extraPay) * 100) / 100;
      totalPay += w.pay; anyPay = true;
    }
    return { ...w, days: w.days.size };
  });
  return {
    from, to, summary, entries: rows.map(publicEntry),
    total: { minutes: totalMin, extraMinutes: totalExtra, pay: anyPay ? Math.round(totalPay * 100) / 100 : null },
  };
}

// ---------------------------------------------------------------- Excel (.xlsx) sin librerías
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function colName(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function sheetXml(rows, widths) {
  const cols = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
  const body = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((c, ci) => {
    if (c == null || c === '') return '';
    const ref = colName(ci) + (ri + 1);
    const bold = typeof c === 'object';
    const v = bold ? c.v : c;
    const s = bold ? ' s="1"' : (typeof v === 'number' ? ' s="2"' : '');
    if (typeof v === 'number') return `<c r="${ref}"${s}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
  }).join('') + '</row>').join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function buildXlsx(rep) {
  const h2 = (m) => Math.round(m / 60 * 100) / 100;
  const B = (v) => ({ v });
  const summary = [
    [B(`${BUSINESS} — Resumen del ${rep.from} al ${rep.to}`)],
    [],
    [B('Trabajador'), B('Días trabajados'), B('Horas'), B('Horas extra'), B(`Pago por día (${CURRENCY})`), B(`Hora extra (${CURRENCY})`), B(`Pago jornadas (${CURRENCY})`), B(`Pago extras (${CURRENCY})`), B(`Pago total (${CURRENCY})`), B('Sin salida')],
    ...rep.summary.map((w) => [w.name, w.days, h2(w.minutes), h2(w.extraMinutes), w.rate ?? '', w.rate ? (w.otRate ?? '') : '', w.basePay ?? '', w.extraPay ?? '', w.pay ?? '', w.open || '']),
    [B('TOTAL'), '', B(h2(rep.total.minutes)), B(h2(rep.total.extraMinutes)), '', '', '', '', rep.total.pay == null ? '' : B(rep.total.pay), ''],
    [],
    ['Jornada normal: 8 horas al día. Las horas que pasan de 8 en un día se pagan como hora extra.'],
  ];
  const srcName = { clock: 'Reloj', manual: 'Manual (trabajador)', admin: 'Administrador' };
  const detail = [
    [B('Fecha'), B('Trabajador'), B('Entrada'), B('Salida'), B('Descanso (min)'), B('Horas'), B('Origen'), B('Nota')],
    ...rep.entries.map((e) => [e.date, e.name, e.startTime, e.endTime ?? 'SIN SALIDA', e.breakMin, e.end == null ? '' : h2(e.minutes), srcName[e.source] || e.source, e.note]),
  ];
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Resumen" sheetId="1" r:id="rId1"/><sheet name="Detalle" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml(summary, [30, 16, 12, 16, 20, 12]) },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml(detail, [12, 28, 10, 12, 15, 10, 20, 30]) },
  ];
  return zip(files);
}

// ---------------------------------------------------------------- Rutas
const routes = [];
const route = (method, pattern, auth, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, auth, handler });
};

route('GET', '/api/config', null, () => {
  const hasAdmin = !!q("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  return { needsSetup: !hasAdmin, setupCodeRequired: !!SETUP_CODE, demo: process.env.APP_DEMO === "1", tz: TZ, currency: CURRENCY, business: BUSINESS, serverNow: Date.now() };
});
route('GET', '/api/time', null, () => ({ serverNow: Date.now(), today: localDate(Date.now()) }));

route('POST', '/api/setup', null, ({ body, res }) => {
  if (q("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get()) throw new HttpError(403, 'El administrador ya existe.');
  if (SETUP_CODE && body.setupCode !== SETUP_CODE) throw new HttpError(403, 'Código de instalación incorrecto.');
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!name) throw bad('Escribe tu nombre.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw bad('El correo no es válido.');
  if (password.length < 8) throw bad('La contraseña debe tener al menos 8 caracteres.');
  const r = q("INSERT INTO users (role, name, email, secret_hash, created_at) VALUES ('admin', ?, ?, ?, ?)")
    .run(name, email, hashSecret(password), Date.now());
  createSession(res, Number(r.lastInsertRowid));
  return { ok: true };
});

route('POST', '/api/login/worker', null, ({ body, res, ip }) => {
  const username = String(body.username || '').trim().toLowerCase();
  const pin = String(body.pin || '');
  const keys = ['w:' + username, 'ip:' + ip];
  checkLocks(keys);
  const u = q("SELECT * FROM users WHERE role = 'worker' AND username = ?").get(username);
  if (!u || !/^\d{4}$/.test(pin) || !checkSecret(pin, u.secret_hash)) {
    keys.forEach(registerFail);
    throw new HttpError(401, 'Usuario o PIN incorrecto.');
  }
  if (!u.active) throw new HttpError(403, 'Tu cuenta está desactivada. Habla con el administrador.');
  keys.forEach((k) => fails.delete(k));
  createSession(res, u.id);
  return { ok: true };
});

route('POST', '/api/login/admin', null, ({ body, res, ip }) => {
  const email = String(body.email || '').trim().toLowerCase();
  const keys = ['a:' + email, 'ip:' + ip];
  checkLocks(keys);
  const u = q("SELECT * FROM users WHERE role = 'admin' AND email = ? AND active = 1").get(email);
  if (!u || !checkSecret(String(body.password || ''), u.secret_hash)) {
    keys.forEach(registerFail);
    throw new HttpError(401, 'Correo o contraseña incorrectos.');
  }
  keys.forEach((k) => fails.delete(k));
  createSession(res, u.id);
  return { ok: true };
});

route('POST', '/api/logout', null, ({ req, res }) => {
  const token = parseCookies(req).sid;
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return { ok: true };
});

route('GET', '/api/me', 'any', ({ user }) => ({ user: publicUser(user) }));

// ---- Trabajador
function myStatus(user) {
  const now = Date.now();
  const today = localDate(now);
  const ws = weekStart(today), ms = monthStart(today);
  const from = ws < ms ? ws : ms;
  const rows = q('SELECT * FROM entries WHERE user_id = ? AND work_date BETWEEN ? AND ?').all(user.id, from, today);
  const totals = { day: 0, week: 0, month: 0 };
  for (const e of rows) {
    const m = entryMinutes(e);
    if (e.work_date === today) totals.day += m;
    if (e.work_date >= ws) totals.week += m;
    if (e.work_date >= ms) totals.month += m;
  }
  const m = report(ms, today, user.id).summary[0] || {};
  return { serverNow: now, today, totals, month: { from: ms, to: today, minutes: m.minutes || 0, extraMinutes: m.extraMinutes || 0, pay: m.pay ?? null } };
}
route('GET', '/api/my/status', 'worker', ({ user }) => myStatus(user));

// Los trabajadores solo CONSULTAN sus horas y lo que han ganado. Las horas y los precios los pone el administrador.

route('GET', '/api/my/entries', 'worker', ({ user, query }) => {
  const { from, to } = query;
  if (!isDate(from) || !isDate(to) || from > to) throw bad('Rango de fechas no válido.');
  const rows = q('SELECT * FROM entries WHERE user_id = ? AND work_date BETWEEN ? AND ? ORDER BY start_ts DESC').all(user.id, from, to);
  const entries = rows.map(publicEntry);
  const m = report(from, to, user.id).summary[0] || {};
  return { entries, totalMinutes: entries.reduce((s, e) => s + e.minutes, 0), extraMinutes: m.extraMinutes || 0, pay: m.pay ?? null };
});

// ---- Administrador
function readWorker(body, existing) {
  const name = String(body.name ?? existing?.name ?? '').trim();
  const username = String(body.username ?? existing?.username ?? '').trim().toLowerCase();
  const phone = String(body.phone ?? '').trim().slice(0, 40);
  const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')));
  const rate = num(body.rate);
  const otRate = num(body.otRate);
  if (!name) throw bad('Escribe el nombre del trabajador.');
  if (!/^[a-z0-9._-]{2,30}$/.test(username)) throw bad('El usuario debe tener de 2 a 30 caracteres: letras sin acentos, números, punto o guion.');
  if (rate != null && (!Number.isFinite(rate) || rate < 0)) throw bad('El pago por día no es válido.');
  if (otRate != null && (!Number.isFinite(otRate) || otRate < 0)) throw bad('El precio de la hora extra no es válido.');
  const pin = String(body.pin ?? '');
  if (pin && !/^\d{4}$/.test(pin)) throw bad('El PIN debe tener exactamente 4 números.');
  if (!existing && !pin) throw bad('Asigna un PIN de 4 números.');
  const dup = q('SELECT id FROM users WHERE username = ? AND id != ?').get(username, existing?.id ?? 0);
  if (dup) throw bad('Ese usuario ya existe. Elige otro.');
  return { name, username, phone, rate, otRate, pin };
}
route('GET', '/api/admin/workers', 'admin', () => ({
  workers: q("SELECT * FROM users WHERE role = 'worker' ORDER BY active DESC, name COLLATE NOCASE").all().map(publicUser),
}));
route('POST', '/api/admin/workers', 'admin', ({ body }) => {
  const w = readWorker(body, null);
  q("INSERT INTO users (role, name, username, phone, rate, ot_rate, secret_hash, created_at) VALUES ('worker', ?, ?, ?, ?, ?, ?, ?)")
    .run(w.name, w.username, w.phone, w.rate, w.otRate, hashSecret(w.pin), Date.now());
  return { ok: true };
});
route('PUT', '/api/admin/workers/:id', 'admin', ({ body, params }) => {
  const existing = q("SELECT * FROM users WHERE role = 'worker' AND id = ?").get(Number(params.id));
  if (!existing) throw new HttpError(404, 'Trabajador no encontrado.');
  const w = readWorker(body, existing);
  const active = body.active === undefined ? existing.active : (body.active ? 1 : 0);
  q('UPDATE users SET name = ?, username = ?, phone = ?, rate = ?, ot_rate = ?, active = ? WHERE id = ?')
    .run(w.name, w.username, w.phone, w.rate, w.otRate, active, existing.id);
  if (w.pin) q('UPDATE users SET secret_hash = ? WHERE id = ?').run(hashSecret(w.pin), existing.id);
  if (!active || w.pin) q('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
  return { ok: true };
});

route('GET', '/api/admin/report', 'admin', ({ query }) => report(query.from, query.to, Number(query.worker) || 0));

route('GET', '/api/admin/export.xlsx', 'admin', ({ query, res }) => {
  const rep = report(query.from, query.to, Number(query.worker) || 0);
  const buf = buildXlsx(rep);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="horas_${rep.from}_a_${rep.to}.xlsx"`,
    'Content-Length': buf.length,
  });
  res.end(buf);
  return undefined;
});

// ---- Asistencia de hoy: el administrador marca entrada / salida (uno o varios a la vez) con la hora del servidor
function todayBoard() {
  const now = Date.now();
  const today = localDate(now);
  const workers = q("SELECT id, name FROM users WHERE role = 'worker' AND active = 1 ORDER BY name COLLATE NOCASE").all();
  const open = new Map(q('SELECT * FROM entries WHERE end_ts IS NULL').all().map((e) => [e.user_id, e]));
  const todays = q('SELECT * FROM entries WHERE work_date = ? ORDER BY start_ts').all(today);
  return {
    today, serverNow: now,
    workers: workers.map((w) => {
      const mine = todays.filter((e) => e.user_id === w.id);
      const o = open.get(w.id);
      const last = [...mine].reverse().find((e) => e.end_ts != null);
      return {
        id: w.id, name: w.name,
        open: o ? { id: o.id, start: o.start_ts, startTime: localTime(o.start_ts), date: o.work_date } : null,
        minutes: mine.reduce((t, e) => t + entryMinutes(e), 0),
        lastOut: last ? localTime(last.end_ts) : null,
      };
    }),
  };
}
function readIds(body) {
  const ids = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw bad('Elige al menos un trabajador.');
  return ids;
}
route('GET', '/api/admin/today', 'admin', () => todayBoard());
route('POST', '/api/admin/clock-in', 'admin', ({ user, body }) => {
  const now = Date.now();
  const done = [], skipped = [];
  for (const id of readIds(body)) {
    const w = q("SELECT id, name FROM users WHERE role = 'worker' AND active = 1 AND id = ?").get(id);
    if (!w) continue;
    if (q('SELECT 1 FROM entries WHERE user_id = ? AND end_ts IS NULL').get(id)) { skipped.push(w.name + ' (ya está trabajando)'); continue; }
    try { assertNoOverlap(id, now, null); } catch (e) { skipped.push(w.name); continue; }
    q("INSERT INTO entries (user_id, work_date, start_ts, source, created_at, updated_by) VALUES (?, ?, ?, 'clock', ?, ?)")
      .run(id, localDate(now), now, now, user.id);
    done.push(w.name);
  }
  return { done, skipped, board: todayBoard() };
});
route('POST', '/api/admin/clock-out', 'admin', ({ user, body }) => {
  const now = Date.now();
  const breakMin = parseInt(body.breakMin ?? 0, 10);
  if (!Number.isFinite(breakMin) || breakMin < 0 || breakMin > 600) throw bad('Los minutos de descanso no son válidos.');
  const done = [], skipped = [];
  for (const id of readIds(body)) {
    const o = q('SELECT e.*, u.name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.user_id = ? AND e.end_ts IS NULL').get(id);
    if (!o) continue;
    const worked = (now - o.start_ts) / 60000;
    const b = breakMin < worked ? breakMin : 0; // si el descanso no cabe, no se descuenta
    q('UPDATE entries SET end_ts = ?, break_min = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(now, b, now, user.id, o.id);
    done.push(o.name);
  }
  return { done, skipped, board: todayBoard() };
});

route('GET', '/api/admin/alerts', 'admin', () => {
  const now = Date.now();
  const today = localDate(now);
  const rows = q('SELECT e.*, u.name FROM entries e JOIN users u ON u.id = e.user_id WHERE e.end_ts IS NULL ORDER BY e.start_ts').all();
  const alerts = [], working = [];
  for (const e of rows) {
    const pe = publicEntry(e);
    pe.hoursOpen = Math.floor((now - e.start_ts) / 3600e3);
    (e.work_date < today || now - e.start_ts > 12 * 3600e3 ? alerts : working).push(pe);
  }
  return { alerts, working, serverNow: now };
});

function readEntryBody(body, existing) {
  const userId = existing ? existing.user_id : Number(body.userId);
  const worker = q("SELECT id FROM users WHERE role = 'worker' AND id = ?").get(userId);
  if (!worker) throw bad('Elige un trabajador.');
  const t = buildTimes(body);
  if (t.start > Date.now() + 60e3) throw bad('La hora de entrada está en el futuro.');
  if (t.end == null && q('SELECT 1 FROM entries WHERE user_id = ? AND end_ts IS NULL AND id != ?').get(userId, existing?.id ?? 0)) {
    throw bad('Este trabajador ya tiene una entrada sin salida. Indica la hora de salida.');
  }
  assertNoOverlap(userId, t.start, t.end, existing?.id ?? 0);
  return { userId, ...t, note: String(body.note || '').slice(0, 300) };
}
route('POST', '/api/admin/entries', 'admin', ({ body, user }) => {
  const e = readEntryBody(body, null);
  const now = Date.now();
  q("INSERT INTO entries (user_id, work_date, start_ts, end_ts, break_min, source, note, created_at, updated_by) VALUES (?, ?, ?, ?, ?, 'admin', ?, ?, ?)")
    .run(e.userId, e.date, e.start, e.end, e.breakMin, e.note, now, user.id);
  return { ok: true };
});
route('PUT', '/api/admin/entries/:id', 'admin', ({ body, params, user }) => {
  const existing = q('SELECT * FROM entries WHERE id = ?').get(Number(params.id));
  if (!existing) throw new HttpError(404, 'Registro no encontrado.');
  const e = readEntryBody(body, existing);
  q('UPDATE entries SET work_date = ?, start_ts = ?, end_ts = ?, break_min = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(e.date, e.start, e.end, e.breakMin, e.note, Date.now(), user.id, existing.id);
  return { ok: true };
});
route('DELETE', '/api/admin/entries/:id', 'admin', ({ params }) => {
  const r = q('DELETE FROM entries WHERE id = ?').run(Number(params.id));
  if (!r.changes) throw new HttpError(404, 'Registro no encontrado.');
  return { ok: true };
});

// ---------------------------------------------------------------- Servidor HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100_000) { reject(new HttpError(413, 'Petición demasiado grande.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('Datos no válidos.')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Ruta no encontrada.');
    const params = {};
    const m = url.pathname.match(r.re);
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    let body = {};
    if (req.method !== 'GET') {
      // Protección CSRF: solo se aceptan peticiones JSON (los formularios de otros sitios no pueden enviarlas sin CORS).
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Tipo de contenido no admitido.');
      body = await readBody(req);
    }
    let user = null;
    if (r.auth) {
      user = currentUser(req);
      if (!user) throw new HttpError(401, 'Tu sesión ha terminado. Vuelve a entrar.');
      if (r.auth !== 'any' && user.role !== r.auth) throw new HttpError(403, 'No tienes permiso para esto.');
    }
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const out = await r.handler({ req, res, body, params, query: Object.fromEntries(url.searchParams), user, ip });
    if (out !== undefined && !res.headersSent) send(200, out);
  } catch (err) {
    if (err instanceof HttpError) return send(err.status, { error: err.message });
    if (String(err.message).includes('UNIQUE constraint failed: entries.user_id')) return send(400, { error: 'Ya hay una entrada abierta para este trabajador.' });
    console.error(err);
    send(500, { error: 'Error interno del servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`${BUSINESS} escuchando en http://localhost:${PORT}  (zona horaria: ${TZ}, base de datos: ${DB_PATH})`);
});

module.exports = server;
