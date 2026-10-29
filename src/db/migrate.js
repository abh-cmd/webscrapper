#!/usr/bin/env node
// Applies db/schema.sql against DATABASE_URL. Safe to run repeatedly
// (schema.sql uses CREATE TABLE IF NOT EXISTS). This is the only supported
// way to initialize the database — no manual table creation required.

const fs = require('node:fs');
const path = require('node:path');
const { getPool, closePool } = require('./connection');

async function migrate() {
  const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  const pool = getPool();
  try {
    await pool.query(schemaSql);
    console.log('Database schema applied successfully.');
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error('Migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
