require('dotenv').config();
const { Pool } = require('pg');

// Single shared, lazily-created connection pool — callers should never
// construct their own `new Pool()` or `new Client()`. This is the only
// place database connection concerns live; everything else (crawling,
// adapters, selection) stays completely unaware of persistence.

let pool = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL environment variable is not set. See .env.example.');
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

module.exports = {
  getPool,
  closePool,
  isDatabaseConfigured
};
