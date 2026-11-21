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
  { name: 'Carlos Martínez', username: 'carlos', phone: '600 111 222', rate: 350, pin: '1111' },
  { name: 'Demo Trabajador', username: 'demo', phone: '', rate: 300, pin: '1234' },
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
  const ends = ['17:00', '16:30', '18:15', '15:00', '17:45'];
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

  console.log('Demo lista.');
  console.log(`Administrador: ${DEMO_ADMIN.email} / ${DEMO_ADMIN.password}`);
  console.log('Trabajador:    demo / PIN 1234  (otro: carlos 1111)');
}

module.exports = { seedDemo };
if (require.main === module) {
  seedDemo(process.argv[2] || BASE).catch((e) => { console.error(e.message); process.exit(1); });
}
