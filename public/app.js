'use strict';
/* Registro de Horas — interfaz (sin frameworks) */

const state = { cfg: null, me: null, tz: 'UTC', currency: '$', offset: 0 };
const wk = { status: null, period: 'week', ref: null, range: null, list: null };
const ad = { tab: 'hours', period: 'week', ref: null, worker: '', workers: [], report: null, alerts: null, showInactive: false };

const $ = (s, el = document) => el.querySelector(s);
const app = () => $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

// ------------------------------------------------------------ API
async function api(method, url, body, { quiet401 = false } = {}) {
  let r;
  try {
    r = await fetch(url, {
      method, credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sin conexión. Revisa tu internet e inténtalo de nuevo.');
  }
  let data = null;
  try { data = await r.json(); } catch { /* sin cuerpo */ }
  if (!r.ok) {
    if (r.status === 401 && !quiet401 && state.me) { state.me = null; renderLogin(); }
    throw new Error(data?.error || 'Algo salió mal. Inténtalo de nuevo.');
  }
  return data;
}

// ------------------------------------------------------------ Avisos y ventanas
let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, isErr ? 4500 : 3000);
}

function openModal({ title, body, submitLabel = 'Guardar', onSubmit, onOpen }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><form class="modal" novalidate>
    <h2>${esc(title)}</h2>${body}
    <div class="error" role="alert" hidden></div>
    <div class="foot"><button type="button" class="btn btn-light" data-close>Cancelar</button>
    <button type="submit" class="btn">${esc(submitLabel)}</button></div></form></div>`;
  const form = $('form', root);
  const errEl = $('.error', form);
  const submit = $('button[type=submit]', form);
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('[data-close]', form).onclick = close;
  $('.backdrop', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('backdrop')) close(); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    submit.disabled = true;
    try { await onSubmit(Object.fromEntries(new FormData(form)), form); close(); }
    catch (err) { errEl.textContent = err.message; errEl.hidden = false; }
    finally { submit.disabled = false; }
  };
  if (onOpen) onOpen(form);
  const first = $('input:not([type=hidden]), select', form);
  if (first && window.matchMedia('(min-width: 640px)').matches) first.focus();
}

// ------------------------------------------------------------ Fechas y formatos (zona horaria del negocio)
const nowServer = () => Date.now() + state.offset;
const syncTime = (serverNow) => { if (serverNow) state.offset = serverNow - Date.now(); };
let partsFmt;
function tzParts(ts) {
  if (!partsFmt) {
    partsFmt = new Intl.DateTimeFormat('en-CA', { timeZone: state.tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  const o = {};
  for (const p of partsFmt.formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}
const localDate = (ts) => { const p = tzParts(ts); return `${p.year}-${p.month}-${p.day}`; };
const localTime = (ts, sec = false) => { const p = tzParts(ts); return `${p.hour}:${p.minute}${sec ? ':' + p.second : ''}`; };
const dUTC = (date) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (date, n) => { const x = dUTC(date); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const addMonths = (date, n) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10); };
const weekStart = (date) => addDays(date, -((dUTC(date).getUTCDay() + 6) % 7));
const monthStart = (date) => date.slice(0, 8) + '01';
const monthEnd = (date) => { const [y, m] = date.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const fmtD = (date, opts) => new Intl.DateTimeFormat('es', { timeZone: 'UTC', ...opts }).format(dUTC(date));
const longDate = (date) => cap(fmtD(date, { weekday: 'long', day: 'numeric', month: 'long' }));
const shortDate = (date) => fmtD(date, { day: 'numeric', month: 'short' });
const dayShort = (date) => cap(fmtD(date, { weekday: 'short', day: 'numeric' }));
const monthName = (date) => cap(fmtD(date, { month: 'long', year: 'numeric' }));
const daysBetween = (a, b) => Math.round((dUTC(b) - dUTC(a)) / 86400e3) + 1;

function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}
const fmtHM = (min) => { min = Math.round(min); return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`; };
const fmtMoney = (n) => (n == null ? '—' : `${state.currency} ${Number(n).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const SOURCE = { clock: ['Reloj', 'green'], manual: ['Manual', 'amber'], admin: ['Admin', 'blue'] };
const srcBadge = (s) => { const [l, c] = SOURCE[s] || [s, '']; return `<span class="badge ${c}">${l}</span>`; };

function periodRange(kind, ref) {
  if (kind === 'day') return { from: ref, to: ref, label: longDate(ref) };
  if (kind === 'week') { const f = weekStart(ref), t = addDays(f, 6); return { from: f, to: t, label: `${shortDate(f)} – ${shortDate(t)}` }; }
  if (kind === 'fortnight') {
    const first = Number(ref.slice(8)) <= 15;
    return first
      ? { from: monthStart(ref), to: ref.slice(0, 8) + '15', label: `1ª quincena · ${monthName(ref)}` }
      : { from: ref.slice(0, 8) + '16', to: monthEnd(ref), label: `2ª quincena · ${monthName(ref)}` };
  }
  return { from: monthStart(ref), to: monthEnd(ref), label: monthName(ref) };
}
function shiftRef(kind, ref, dir) {
  if (kind === 'day') return addDays(ref, dir);
  if (kind === 'week') return addDays(ref, 7 * dir);
  if (kind === 'month') return addMonths(ref, dir);
  const first = Number(ref.slice(8)) <= 15;
  if (first) return dir > 0 ? ref.slice(0, 8) + '16' : addMonths(ref, -1).slice(0, 8) + '16';
  return dir > 0 ? addMonths(ref, 1) : ref.slice(0, 8) + '01';
}
const PERIOD_NAMES = { day: 'Día', week: 'Semana', fortnight: 'Quincena', month: 'Mes' };
function periodSeg(kinds, current, action) {
  return `<div class="seg ${kinds.length === 4 ? 'four' : ''}" style="grid-template-columns:repeat(${kinds.length},1fr)">` +
    kinds.map((k) => `<button type="button" class="${k === current ? 'on' : ''}" data-action="${action}" data-v="${k}">${PERIOD_NAMES[k]}</button>`).join('') + '</div>';
}
function periodNav(label, action, isCurrent) {
  return `<div class="nav"><button type="button" class="btn btn-light" data-action="${action}" data-v="-1" aria-label="Anterior">‹</button>
    <div class="label">${esc(label)}</div>
    <button type="button" class="btn btn-light" data-action="${action}" data-v="1" aria-label="Siguiente">›</button>
    ${isCurrent ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-action="${action}" data-v="0">Hoy</button>`}</div>`;
}

// ------------------------------------------------------------ Arranque
async function boot() {
  try {
    state.cfg = await api('GET', '/api/config');
  } catch (e) {
    app().innerHTML = `<div class="wrap narrow"><div class="card"><h2>No se pudo conectar</h2><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reintentar</button></div></div>`;
    return;
  }
  state.tz = state.cfg.tz; state.currency = state.cfg.currency; partsFmt = null;
  syncTime(state.cfg.serverNow);
  document.title = state.cfg.business;
  if (state.cfg.needsSetup) return renderSetup();
  try {
    const { user } = await api('GET', '/api/me', undefined, { quiet401: true });
    state.me = user;
    route();
  } catch { renderLogin(); }
}
function route() {
  if (!state.me) return renderLogin();
  if (state.me.role === 'admin') return loadAdmin();
  return loadWorker();
}

const markSvg = (size = 18) => `<span class="mark"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg></span>`;
const logoHtml = () => `<div class="logo">${markSvg()}<h1>${esc(state.cfg.business)}</h1></div>`;

// ------------------------------------------------------------ Instalación inicial
function renderSetup() {
  app().innerHTML = `<div class="wrap narrow login">${logoHtml()}
    <form class="card" id="setup-form">
      <h2>Crear cuenta de administrador</h2>
      <p class="muted small">Es la primera vez que se abre la aplicación. Crea tu cuenta para empezar.</p>
      <label for="s-name">Tu nombre</label><input id="s-name" name="name" autocomplete="name" required>
      <label for="s-email">Correo</label><input id="s-email" name="email" type="email" autocomplete="email" required>
      <label for="s-pass">Contraseña (mínimo 8 caracteres)</label>${passField("s-pass", "password", "new-password")}
      <label for="s-pass2">Repite la contraseña</label>${passField("s-pass2", "password2", "new-password")}
      ${state.cfg.setupCodeRequired ? '<label for="s-code">Código de instalación</label><input id="s-code" name="setupCode" required>' : ''}
      <div class="error" role="alert" hidden></div>
      <button class="btn wide" style="margin-top:16px">Crear cuenta</button>
    </form></div>`;
  const form = $('#setup-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const err = $('.error', form);
    if (d.password !== d.password2) { err.textContent = 'Las contraseñas no coinciden.'; err.hidden = false; return; }
    try {
      await api('POST', '/api/setup', d);
      state.cfg.needsSetup = false;
      state.me = (await api('GET', '/api/me')).user;
      toast('Cuenta creada. ¡Bienvenido!');
      route();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
}

// ------------------------------------------------------------ Inicio de sesión
let loginMode = store.get('loginMode') || 'worker';
function renderLogin() {
  const lastUser = store.get('lastUser') || '';
  app().innerHTML = `<div class="wrap narrow login">${logoHtml()}
    <div class="seg"><button type="button" class="${loginMode === 'worker' ? 'on' : ''}" data-action="login-mode" data-v="worker">Trabajador</button>
    <button type="button" class="${loginMode === 'admin' ? 'on' : ''}" data-action="login-mode" data-v="admin">Administrador</button></div>
    <form class="card" id="login-form">
    ${loginMode === 'worker' ? `
      <label for="l-user">Usuario</label>
      <input id="l-user" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(lastUser)}" required>
      <label for="l-pin">PIN (4 números)</label>
      <input id="l-pin" name="pin" class="pin-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="current-password" required>
    ` : `
      <label for="l-email">Correo</label>
      <input id="l-email" name="email" type="email" autocomplete="username" required>
      <label for="l-pass">Contraseña</label>
      ${passField("l-pass", "password", "current-password")}
    `}
      <div class="error" role="alert" hidden></div>
      <button class="btn wide" style="margin-top:18px;min-height:58px;font-size:1.1rem">Entrar</button>
    </form>${state.cfg.demo ? `<div class="demo-hint"><b>Versión de demostración</b><br>Trabajador: usuario <code>demo</code> · PIN <code>1234</code><br>Administrador: <code>admin@demo.test</code> · <code>demo1234</code></div>` : ''}</div>`;
  const form = $('#login-form');
  const pin = $('#l-pin');
  if (pin) {
    pin.addEventListener('input', () => {
      pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
      if (pin.value.length === 4 && $('#l-user').value.trim()) form.requestSubmit();
    });
    (lastUser ? pin : $('#l-user')).focus();
  }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const err = $('.error', form);
    const btn = $('button[type=submit], button:not([type])', form);
    btn.disabled = true;
    try {
      await api('POST', loginMode === 'worker' ? '/api/login/worker' : '/api/login/admin', d);
      if (loginMode === 'worker') store.set('lastUser', d.username.trim().toLowerCase());
      state.me = (await api('GET', '/api/me')).user;
      route();
    } catch (ex) {
      err.textContent = ex.message; err.hidden = false;
      if (pin) { pin.value = ''; pin.focus(); }
    } finally { btn.disabled = false; }
  };
}

async function logout() {
  try { await api('POST', '/api/logout', {}); } catch { /* da igual */ }
  state.me = null;
  renderLogin();
}

// ------------------------------------------------------------ Vista del trabajador
async function loadWorker() {
  try {
    const s = await api('GET', '/api/my/status');
    syncTime(s.serverNow);
    wk.status = s;
    if (!wk.ref) wk.ref = s.today;
    await loadMyEntries();
    renderWorker();
  } catch (e) { toast(e.message, true); }
}
async function loadMyEntries() {
  wk.range = periodRange(wk.period, wk.ref);
  wk.list = await api('GET', `/api/my/entries?from=${wk.range.from}&to=${wk.range.to}`);
}
function renderWorker() {
  const s = wk.status;
  const r = wk.range;
  const isCurrent = r.from <= s.today && s.today <= r.to;
  const items = wk.list.entries.map((e) => `<li>
      <div><div class="when">${esc(dayShort(e.date))}</div>
      <div class="muted small">${e.startTime} – ${e.endTime ?? '…'}${e.breakMin ? ` · descanso ${e.breakMin} min` : ''}</div></div>
      <div class="hrs">${e.end == null ? '—' : fmtDur(e.minutes)}</div></li>`).join('');
  const hasPay = s.month.pay != null;

  app().innerHTML = `
  <header class="top"><div class="inner">
    <div style="flex:1"><div class="hello">${esc(state.me.name)}</div>
    <div class="subtle">${longDate(s.today)}</div></div>
    <button class="btn btn-ghost" data-action="logout">Salir de la app</button>
  </div></header>
  <main class="wrap"><div class="worker-layout"><div>
    <section class="card earn-card">
      <div class="earn-l">${hasPay ? 'Ganado este mes' : 'Horas este mes'}</div>
      <div class="earn-n">${hasPay ? fmtMoney(s.month.pay) : fmtHM(s.month.minutes)}</div>
      <div class="muted small">Del ${shortDate(s.month.from)} a hoy · ${fmtHM(s.month.minutes)} h trabajadas${s.month.extraMinutes ? ` (${fmtHM(s.month.extraMinutes)} h extra)` : ''}</div>
    </section>
    <section class="totals">
      <div class="total"><div class="n">${fmtHM(s.totals.day)}</div><div class="l">Hoy</div></div>
      <div class="total"><div class="n">${fmtHM(s.totals.week)}</div><div class="l">Esta semana</div></div>
      <div class="total"><div class="n">${fmtHM(s.totals.month)}</div><div class="l">Este mes</div></div>
    </section>
    <p class="muted small" style="text-align:center;margin:0 0 16px">Tus horas las registra el administrador. Si ves algún error, avísale.</p>
  </div>
  <section class="card">
    <h2>Mis horas</h2>
    ${periodSeg(['week', 'fortnight', 'month'], wk.period, 'wk-period')}
    ${periodNav(r.label, 'wk-nav', isCurrent)}
    ${items ? `<ul class="list">${items}</ul>` : '<div class="empty">No hay horas registradas en este período.</div>'}
    <div class="row sum-row"><span>Total horas</span><span class="spacer"></span><span>${fmtDur(wk.list.totalMinutes)}</span></div>
    ${wk.list.extraMinutes ? `<div class="row sum-row sub"><span>De ellas, extra</span><span class="spacer"></span><span>${fmtDur(wk.list.extraMinutes)}</span></div>` : ''}
    ${wk.list.pay != null ? `<div class="row sum-row"><span>Ganado en este período</span><span class="spacer"></span><span>${fmtMoney(wk.list.pay)}</span></div>` : ''}
  </section></div></main>`;
}

// ------------------------------------------------------------ Vista del administrador
async function loadAdmin() {
  if (!ad.ref) ad.ref = localDate(nowServer());
  renderAdminShell();
  await Promise.all([loadWorkers(), loadAlerts()]);
  await showTab(ad.tab);
}
async function loadWorkers() { ad.workers = (await api('GET', '/api/admin/workers')).workers; }
async function loadAlerts() {
  ad.alerts = await api('GET', '/api/admin/alerts');
  syncTime(ad.alerts.serverNow);
  const c = $('#alert-count');
  if (c) { c.textContent = ad.alerts.alerts.length; c.hidden = !ad.alerts.alerts.length; }
}
function renderAdminShell() {
  app().innerHTML = `
  <header class="top"><div class="inner">
    <div style="flex:1"><div class="hello">${esc(state.cfg.business)}</div><div class="subtle">Administración · ${esc(state.me.name)}</div></div>
    <div class="clock admin-clock" id="clock" style="font-size:1.6rem">${localTime(nowServer())}</div>
    <button class="btn btn-ghost" data-action="logout">Cerrar sesión</button>
  </div></header>
  <nav class="tabs"><div class="inner">
    <button data-action="tab" data-v="hours">Horas</button>
    <button data-action="tab" data-v="workers">Trabajadores</button>
    <button data-action="tab" data-v="alerts">Alertas <span class="count" id="alert-count" hidden>0</span></button>
  </div></nav>
  <main class="wrap" id="admin-main"><div class="loading">Cargando…</div></main>`;
}
async function showTab(tab) {
  ad.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === tab));
  try {
    if (tab === 'hours') await loadReport();
    else if (tab === 'workers') renderWorkers();
    else { await loadAlerts(); renderAlerts(); }
  } catch (e) { toast(e.message, true); }
}

// ---- Horas
async function loadReport() {
  const r = periodRange(ad.period, ad.ref);
  ad.range = r;
  ad.report = await api('GET', `/api/admin/report?from=${r.from}&to=${r.to}&worker=${ad.worker}`);
  renderReport();
}
function renderReport() {
  const r = ad.range, rep = ad.report;
  const today = localDate(nowServer());
  const isCurrent = r.from <= today && today <= r.to;
  const toolbar = (extra) => `<div class="card no-print"><div class="toolbar">
    ${periodSeg(['day', 'week', 'fortnight', 'month'], ad.period, 'ad-period')}
    ${periodNav(r.label, 'ad-nav', isCurrent)}
  </div>
  <div class="row" style="margin-top:10px">${extra}
    <span class="spacer"></span>
    <button class="btn btn-light" data-action="export">Excel</button>
    <button class="btn btn-light" data-action="print">Imprimir / PDF</button>
  </div></div>`;
  if (ad.worker) return renderWorkerDetail(r, rep, toolbar);

  const hasRates = rep.summary.some((w) => w.rate);
  const lines = rep.summary.map((w) => `<button class="worker-line ${w.active ? '' : 'inactive'}" data-action="open-worker" data-id="${w.id}">
      <span class="wl-name">${esc(w.name)}${w.open ? ` <span class="badge red">${w.open} sin salida</span>` : ''}</span>
      <span class="wl-hours">${fmtHM(w.minutes)} h</span>
      <span class="wl-pay">${w.rate ? fmtMoney(w.pay) : '<span class="muted small">sin tarifa</span>'}</span>
      <svg class="wl-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>`).join('');
  const printRows = rep.summary.map((w) => `<tr><td>${esc(w.name)}</td><td class="num">${w.days}</td><td class="num">${fmtHM(w.minutes)}</td><td class="num">${fmtHM(w.extraMinutes)}</td>${hasRates ? `<td class="num">${fmtMoney(w.pay)}</td>` : ''}<td class="sign"></td></tr>`).join('');

  $('#admin-main').innerHTML = `
  ${toolbar('<button class="btn" data-action="new-entry">Añadir horas</button>')}
  <div class="card no-print list-card">
    ${rep.summary.length ? `<div class="worker-head"><span>Trabajador</span><span>Horas</span><span>Total a pagar</span><span></span></div>
    ${lines}
    <div class="worker-line total-line"><span class="wl-name">Total</span><span class="wl-hours">${fmtHM(rep.total.minutes)} h</span><span class="wl-pay">${rep.total.pay != null ? fmtMoney(rep.total.pay) : '—'}</span><span class="wl-chev"></span></div>`
    : '<div class="empty">Aún no hay trabajadores. Añádelos en la pestaña «Trabajadores».</div>'}
  </div>
  <div class="print-only"><h1>${esc(state.cfg.business)} — Resumen de horas para nómina</h1>
    <p>Período: <b>${esc(r.label)}</b> (${r.from} al ${r.to}) · Jornada normal: 8 h al día; lo que pasa de 8 h se paga como hora extra.</p>
    <table><thead><tr><th>Trabajador</th><th class="num">Días</th><th class="num">Horas</th><th class="num">Extras</th>${hasRates ? '<th class="num">Total a pagar</th>' : ''}<th>Firma</th></tr></thead>
    <tbody>${printRows}</tbody>
    <tfoot><tr><td>TOTAL</td><td></td><td class="num">${fmtHM(rep.total.minutes)}</td><td class="num">${fmtHM(rep.total.extraMinutes)}</td>${hasRates ? `<td class="num">${fmtMoney(rep.total.pay)}</td>` : ''}<td></td></tr></tfoot></table></div>`;
}

function renderWorkerDetail(r, rep, toolbar) {
  const w = rep.summary[0] || ad.workers.find((x) => String(x.id) === String(ad.worker)) || { name: '' };
  // Horas por día, para marcar las extras en la primera fila de cada día
  const firstOfDay = new Set();
  const seen = new Set();
  for (const e of [...rep.entries].sort((a, b) => a.start - b.start)) if (!seen.has(e.date)) { seen.add(e.date); firstOfDay.add(e.id); }
  const rows = [...rep.entries].sort((a, b) => b.start - a.start).map((e) => {
    const dayMin = (w.byDate || {})[e.date] || 0;
    const extra = firstOfDay.has(e.id) ? Math.max(0, dayMin - 480) : 0;
    return `<tr>
      <td>${esc(dayShort(e.date))}</td>
      <td class="num">${e.startTime}</td>
      <td class="num">${e.endTime ? e.endTime + (e.endDate !== e.date ? ' <span class="badge">+1 día</span>' : '') : '<span class="badge red">Sin salida</span>'}</td>
      <td class="num">${e.breakMin ? e.breakMin + ' min' : '—'}</td>
      <td class="num"><b>${e.end == null ? '—' : fmtHM(e.minutes)}</b></td>
      <td class="num">${extra ? `<span class="badge amber">+${fmtHM(extra)}</span>` : '—'}</td>
      <td>${srcBadge(e.source)}${e.note ? ` <span class="note" title="${esc(e.note)}">· ${esc(e.note.length > 24 ? e.note.slice(0, 24) + '…' : e.note)}</span>` : ''}</td>
      <td class="no-print nowrap"><button class="btn btn-light btn-sm" data-action="edit-entry" data-id="${e.id}">Editar</button>
      <button class="btn btn-danger btn-sm" data-action="del-entry" data-id="${e.id}">Borrar</button></td></tr>`;
  }).join('');
  const pay = w.rate ? `<div class="card pay-card">
      <div class="pay-row"><span>Jornadas (${fmtMoney(w.rate)} por día de 8 h)</span><b>${fmtMoney(w.basePay)}</b></div>
      <div class="pay-row"><span>Horas extra: ${fmtHM(w.extraMinutes)} h × ${fmtMoney(w.otRate)}</span><b>${fmtMoney(w.extraPay)}</b></div>
      <div class="pay-row pay-total"><span>Total a pagar</span><b>${fmtMoney(w.pay)}</b></div>
    </div>` : '<div class="card muted small">Este trabajador no tiene pago por día. Ponlo en «Trabajadores» → Editar.</div>';

  $('#admin-main').innerHTML = `
  <div class="row no-print" style="margin-bottom:12px"><button class="btn btn-ghost" data-action="back-list">‹ Todos los trabajadores</button></div>
  ${toolbar('<button class="btn" data-action="new-entry">Añadir horas</button>')}
  <div class="print-only"><h1>${esc(state.cfg.business)} — Detalle de horas</h1><p>Período: <b>${esc(r.label)}</b> (${r.from} al ${r.to})</p></div>
  <h2 class="detail-name">${esc(w.name)}</h2>
  <div class="kpis">
    <div class="total"><div class="n">${fmtHM(w.minutes || 0)}</div><div class="l">Horas</div></div>
    <div class="total"><div class="n">${fmtHM(w.extraMinutes || 0)}</div><div class="l">Horas extra</div></div>
    <div class="total"><div class="n">${w.days || 0}</div><div class="l">Días trabajados</div></div>
    ${w.rate ? `<div class="total"><div class="n">${fmtMoney(w.pay)}</div><div class="l">Total a pagar</div></div>` : ''}
  </div>
  ${pay}
  <div class="card"><h2>Registros</h2>
  ${rep.entries.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Fecha</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Descanso</th><th class="num">Horas</th><th class="num">Extra</th><th>Origen</th><th class="no-print"></th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : '<div class="empty">No hay registros en este período.</div>'}
  </div>
  <p class="print-only" style="margin-top:40px">Firma del trabajador: ______________________________</p>`;
}

function entryModal(entry) {
  const isNew = !entry;
  const active = ad.workers.filter((w) => w.active);
  const today = localDate(nowServer());
  const defDate = entry?.date || (ad.range && ad.range.from <= today && today <= ad.range.to ? today : ad.range?.from || today);
  openModal({
    title: isNew ? 'Añadir horas' : `Editar horas · ${entry.name}`,
    body: `${isNew ? `<label for="e-user">Trabajador</label><select id="e-user" name="userId" required><option value="">Elige…</option>
        ${active.map((w) => `<option value="${w.id}" ${String(w.id) === String(ad.worker) ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>` : ''}
      <label for="e-date">Fecha (día de la entrada)</label><input id="e-date" name="date" type="date" value="${defDate}" required>
      <div class="grid2"><div><label for="e-start">Entrada</label><input id="e-start" name="start" type="time" value="${entry?.startTime || ''}" required></div>
      <div><label for="e-end">Salida</label><input id="e-end" name="end" type="time" value="${entry?.endTime || ''}"></div></div>
      <p class="muted small" style="margin:6px 0 0">Si la salida es menor que la entrada, se entiende que terminó al día siguiente. Deja la salida vacía si sigue trabajando.</p>
      <label for="e-break">Minutos de descanso</label><input id="e-break" name="breakMin" type="number" inputmode="numeric" min="0" max="600" value="${entry?.breakMin ?? 0}">
      <label for="e-note">Nota (opcional)</label><input id="e-note" name="note" maxlength="300" value="${esc(entry?.note || '')}" placeholder="Ej.: corregido, olvidó fichar">`,
    async onSubmit(d) {
      if (isNew) await api('POST', '/api/admin/entries', d);
      else await api('PUT', `/api/admin/entries/${entry.id}`, d);
      toast(isNew ? 'Horas añadidas' : 'Cambios guardados');
      await loadAlerts();
      await showTab(ad.tab);
    },
  });
}
async function deleteEntry(id) {
  const e = ad.report.entries.find((x) => String(x.id) === String(id));
  if (!e || !confirm(`¿Borrar el registro de ${e.name} del ${shortDate(e.date)} (${e.startTime}–${e.endTime ?? 'sin salida'})?\nEsta acción no se puede deshacer.`)) return;
  try {
    await api('DELETE', `/api/admin/entries/${id}`);
    toast('Registro borrado');
    await loadAlerts(); await loadReport();
  } catch (x) { toast(x.message, true); }
}

// ---- Trabajadores
function renderWorkers() {
  const list = ad.workers.filter((w) => ad.showInactive || w.active);
  const inactiveCount = ad.workers.filter((w) => !w.active).length;
  $('#admin-main').innerHTML = `<div class="card">
    <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Trabajadores (${ad.workers.filter((w) => w.active).length} activos)</h2><span class="spacer"></span>
    <button class="btn" data-action="new-worker">Añadir trabajador</button></div>
    ${inactiveCount ? `<label class="check"><input type="checkbox" id="show-inactive" ${ad.showInactive ? 'checked' : ''}> Mostrar desactivados (${inactiveCount})</label>` : ''}
    ${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Nombre</th><th>Usuario</th><th>Teléfono</th><th class="num">Pago por día</th><th class="num">Hora extra</th><th>Estado</th><th></th></tr></thead>
      <tbody>${list.map((w) => `<tr class="${w.active ? '' : 'inactive'}">
        <td><b>${esc(w.name)}</b></td><td>${esc(w.username)}</td>
        <td>${w.phone ? `<a href="tel:${esc(w.phone)}">${esc(w.phone)}</a>` : '—'}</td>
        <td class="num">${w.rate ? fmtMoney(w.rate) : '—'}</td>
        <td class="num">${w.rate ? fmtMoney(w.otRate ?? w.otRateAuto) : '—'}</td>
        <td>${w.active ? '<span class="badge green">Activo</span>' : '<span class="badge">Desactivado</span>'}</td>
        <td><button class="btn btn-light btn-sm" data-action="edit-worker" data-id="${w.id}">Editar</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">Todavía no hay trabajadores. Pulsa «Añadir trabajador» para empezar.</div>'}
  </div>`;
  const cb = $('#show-inactive');
  if (cb) cb.onchange = () => { ad.showInactive = cb.checked; renderWorkers(); };
}
const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').slice(0, 30);
function workerModal(w) {
  const isNew = !w;
  openModal({
    title: isNew ? 'Nuevo trabajador' : `Editar · ${w.name}`,
    body: `<label for="w-name">Nombre completo</label><input id="w-name" name="name" value="${esc(w?.name || '')}" required>
      <label for="w-user">Usuario para entrar</label><input id="w-user" name="username" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(w?.username || '')}" required>
      <label for="w-phone">Teléfono (opcional)</label><input id="w-phone" name="phone" type="tel" value="${esc(w?.phone || '')}">
      <label for="w-rate">Pago por día (jornada de 8 horas)</label><input id="w-rate" name="rate" type="number" inputmode="decimal" min="0" step="0.01" value="${w?.rate ?? ''}" placeholder="Ej.: 350">
      <label for="w-ot">Precio de cada hora extra (después de 8 h)</label><input id="w-ot" name="otRate" type="number" inputmode="decimal" min="0" step="0.01" value="${w?.otRate ?? ''}">
      <p class="muted small" id="w-ot-hint" style="margin-top:4px"></p>
      <label for="w-pin">${isNew ? 'PIN de 4 números' : 'Nuevo PIN (déjalo vacío para no cambiarlo)'}</label>
      <input id="w-pin" name="pin" class="pin-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" ${isNew ? 'required' : ''}>
      ${isNew ? '' : `<label class="check"><input type="checkbox" name="active" ${w.active ? 'checked' : ''}> Activo (puede entrar y fichar)</label>`}
      <p class="muted small">Entrega al trabajador su <b>usuario</b> y su <b>PIN</b> para que pueda entrar desde su celular.</p>`,
    onOpen(form) {
      const name = $('#w-name', form), user = $('#w-user', form), pin = $('#w-pin', form);
      const rate = $('#w-rate', form), ot = $('#w-ot', form), hint = $('#w-ot-hint', form);
      const upd = () => {
        const r = Number(String(rate.value).replace(',', '.'));
        const auto = r > 0 ? Math.round(r / 8 * 1.5 * 100) / 100 : null;
        ot.placeholder = auto ? String(auto) : '';
        hint.textContent = auto ? (ot.value ? 'Precio fijado por ti.' : `Si lo dejas vacío: ${fmtMoney(auto)} (hora normal + 50 %).`) : 'Si lo dejas vacío se calcula solo: hora normal + 50 %.';
      };
      rate.addEventListener('input', upd); ot.addEventListener('input', upd); upd();
      let touched = !isNew;
      user.addEventListener('input', () => { touched = true; });
      name.addEventListener('input', () => { if (!touched) user.value = slug(name.value); });
      pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 4); });
    },
    async onSubmit(d) {
      if (!isNew) d.active = !!d.active;
      if (isNew) await api('POST', '/api/admin/workers', d);
      else await api('PUT', `/api/admin/workers/${w.id}`, d);
      toast(isNew ? `${d.name} añadido. Usuario: ${d.username}` : 'Cambios guardados');
      await loadWorkers();
      renderWorkers();
    },
  });
}

// ---- Alertas
function renderAlerts() {
  const { alerts, working } = ad.alerts;
  const card = (e, cls) => `<div class="card ${cls}"><div class="row">
      <div style="flex:1;min-width:200px"><b>${esc(e.name)}</b><div class="muted">Entró el ${esc(longDate(e.date))} a las ${e.startTime} · hace ${fmtDur(e.hoursOpen * 60)}</div></div>
      <button class="btn ${cls === 'alert-card' ? '' : 'btn-light'}" data-action="fix-open" data-id="${e.id}">Registrar salida</button></div></div>`;
  $('#admin-main').innerHTML = `
    <h2>Entraron pero no registraron salida</h2>
    <p class="muted small">Entradas de días anteriores o con más de 12 horas abiertas.</p>
    ${alerts.length ? alerts.map((e) => card(e, 'alert-card')).join('') : '<div class="card empty">No hay alertas.</div>'}
    <h2 style="margin-top:28px">Trabajando ahora (${working.length})</h2>
    ${working.length ? working.map((e) => card(e, 'working-card')).join('') : '<div class="card empty">Nadie está trabajando en este momento.</div>'}`;
}

// ------------------------------------------------------------ Eventos
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const { action, v, id } = el.dataset;
  switch (action) {
    case 'login-mode': loginMode = v; store.set('loginMode', v); renderLogin(); break;
    case 'logout': logout(); break;
    case 'wk-period': wk.period = v; wk.ref = wk.status.today; await loadMyEntries().catch((e) => toast(e.message, true)); renderWorker(); break;
    case 'wk-nav': wk.ref = v === '0' ? wk.status.today : shiftRef(wk.period, wk.ref, Number(v)); await loadMyEntries().catch((e) => toast(e.message, true)); renderWorker(); break;
    case 'tab': if (v === 'hours') ad.worker = ''; showTab(v); break;
    case 'open-worker': ad.worker = id; window.scrollTo(0, 0); loadReport().catch((e) => toast(e.message, true)); break;
    case 'back-list': ad.worker = ''; loadReport().catch((e) => toast(e.message, true)); break;
    case 'ad-period': ad.period = v; ad.ref = localDate(nowServer()); loadReport().catch((e) => toast(e.message, true)); break;
    case 'ad-nav': ad.ref = v === '0' ? localDate(nowServer()) : shiftRef(ad.period, ad.ref, Number(v)); loadReport().catch((e) => toast(e.message, true)); break;
    case 'new-entry': entryModal(null); break;
    case 'edit-entry': entryModal(ad.report.entries.find((x) => String(x.id) === id)); break;
    case 'del-entry': deleteEntry(id); break;
    case 'fix-open': {
      const e = [...ad.alerts.alerts, ...ad.alerts.working].find((x) => String(x.id) === id);
      if (e) entryModal(e);
      break;
    }
    case 'export': {
      const r = ad.range;
      window.location.href = `/api/admin/export.xlsx?from=${r.from}&to=${r.to}&worker=${ad.worker}`;
      break;
    }
    case 'print': window.print(); break;
    case 'new-worker': workerModal(null); break;
    case 'edit-worker': workerModal(ad.workers.find((w) => String(w.id) === id)); break;
    default: break;
  }
});

// Reloj en pantalla (hora del servidor) y tiempo trabajado en vivo
function tick() {
  const c = $('#clock');
  if (c) c.textContent = localTime(nowServer());
}
setInterval(tick, 1000);

// Al volver a la app (p. ej. desbloquear el celular) refrescamos los datos
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me || $('#modal-root').innerHTML) return;
  if (state.me.role === 'worker') loadWorker();
  else loadAlerts().catch(() => {});
});

boot();

// Campo de contraseña con botón Mostrar / Ocultar
function passField(id, name, autocomplete) {
  return `<div class="pass-wrap"><input id="${id}" name="${name}" type="password" autocomplete="${autocomplete}" required>` +
    `<button type="button" class="pass-toggle" data-action="toggle-pass" aria-controls="${id}" aria-pressed="false">Mostrar</button></div>`;
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-action="toggle-pass"]');
  if (!b) return;
  const input = document.getElementById(b.getAttribute('aria-controls'));
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  b.textContent = show ? 'Ocultar' : 'Mostrar';
  b.setAttribute('aria-pressed', String(show));
});
