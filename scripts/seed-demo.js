// Carga datos de ejemplo en una instancia de DEMOSTRACIÓN recién creada.
// Uso: node scripts/seed-demo.js http://localhost:3001
let BASE = 'http://localhost:3001';
let cookie = '';

async function call(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${data.error || r.status}`);
  return data;
}

const DEMO_ADMIN = { name: 'Administrador Demo', email: 'admin@demo.test', password: 'demo1234' };
const WORKERS = [
  { name: 'Carlos Martínez', username: 'carlos', phone: '600 111 222', rate: 9.5, pin: '1111' },
  { name: 'Lucía Fernández', username: 'lucia', phone: '600 333 444', rate: 10, pin: '2222' },
  { name: 'Andrés Gómez', username: 'andres', phone: '600 555 666', rate: 8.75, pin: '3333' },
  { name: 'Sofía Ramírez', username: 'sofia', phone: '', rate: '', pin: '4444' },
  { name: 'Demo Trabajador', username: 'demo', phone: '', rate: 9, pin: '1234' },
];

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dow = (d) => new Date(d + 'T00:00:00Z').getUTCDay();

async function seedDemo(base) {
  BASE = base; cookie = '';
  const cfg = await call('GET', '/api/config');
  if (!cfg.needsSetup) throw new Error('Esta instancia ya tiene datos; usa una base de datos nueva para la demo.');
  await call('POST', '/api/setup', DEMO_ADMIN);
  for (const w of WORKERS) await call('POST', '/api/admin/workers', w);
  const { workers } = await call('GET', '/api/admin/workers');
  const { today } = await call('GET', '/api/time');

  const starts = ['07:55', '08:00', '08:05', '08:10', '07:50'];
  const ends = ['17:00', '16:30', '17:15', '15:00', '17:05'];
  for (let back = 13; back >= 1; back--) {
    const date = addDays(today, -back);
    if (dow(date) === 0) continue; // domingo libre
    workers.forEach((w, i) => {
      if (dow(date) === 6 && i % 2) return; // sábados, media plantilla
      if ((back + i) % 9 === 0) return; // algún día libre
      const isSat = dow(date) === 6;
      const entry = {
        userId: w.id, date,
        start: starts[(i + back) % starts.length],
        end: isSat ? '13:00' : ends[(i * 2 + back) % ends.length],
        breakMin: isSat ? 0 : [30, 45, 60][(i + back) % 3],
      };
      w._entries = (w._entries || []).concat(entry);
    });
  }
  for (const w of workers) for (const e of w._entries || []) await call('POST', '/api/admin/entries', e);

  // Una alerta: Andrés entró ayer y no marcó salida
  const andres = workers.find((w) => w.username === 'andres');
  const yesterday = addDays(today, -1);
  const prev = await call('GET', `/api/admin/report?from=${yesterday}&to=${yesterday}&worker=${andres.id}`);
  for (const e of prev.entries) await call('DELETE', `/api/admin/entries/${e.id}`);
  await call('POST', '/api/admin/entries', { userId: andres.id, date: yesterday, start: '08:00', note: 'Olvidó marcar la salida' });

  console.log('Demo lista.');
  console.log(`Administrador: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
  console.log('Trabajador:    demo / PIN 1234  (otros: carlos 1111, lucia 2222, andres 3333, sofia 4444)');
}

module.exports = { seedDemo };
if (require.main === module) {
  seedDemo(process.argv[2] || BASE).catch((e) => { console.error(e.message); process.exit(1); });
}
