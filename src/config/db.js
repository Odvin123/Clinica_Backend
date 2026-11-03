require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
  console.log('✅ Conectado a PostgreSQL (Clinica Urbina)');
});

pool.on('error', (err) => {
  console.error('❌ Error inesperado en la base de datos:', err);
});

const query = (text, params) => pool.query(text, params);

module.exports = {
  query,
  pool
};