// Arranca una copia de DEMOSTRACIÓN, con su propia base de datos (no toca tus datos reales).
// Si la base de datos está vacía, carga automáticamente trabajadores y horas de ejemplo.
// Uso: node demo.js   → http://localhost:3001
const path = require('node:path');
process.env.PORT = process.env.PORT || '3001';
process.env.DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'demo.db');
process.env.APP_NAME = process.env.APP_NAME || 'Registro de Horas · Demo';
process.env.APP_DEMO = '1';

const server = require('./server.js');
const { seedDemo } = require('./scripts/seed-demo.js');

server.on('listening', async () => {
  const base = `http://127.0.0.1:${process.env.PORT}`;
  try {
    const cfg = await (await fetch(base + '/api/config')).json();
    if (cfg.needsSetup) await seedDemo(base);
  } catch (e) {
    console.error('No se pudieron cargar los datos de ejemplo:', e.message);
  }
});
