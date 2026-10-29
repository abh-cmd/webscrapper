const { getPool } = require('../db/connection');

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemNumber: row.item_number,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    runId: row.run_id,
    contentType: row.content_type,
    rawContent: row.raw_content,
    fetchedAt: row.fetched_at
  };
}

async function saveSnapshot({ itemNumber, sourceName, sourceUrl, runId, rawContent, contentType = 'text/html' }) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO raw_snapshots (item_number, source_name, source_url, run_id, content_type, raw_content)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *;`,
    [itemNumber, sourceName, sourceUrl, runId, contentType, rawContent]
  );
  return fromRow(result.rows[0]);
}

async function getLatestSnapshot(itemNumber) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM raw_snapshots WHERE item_number = $1 ORDER BY fetched_at DESC LIMIT 1;`,
    [itemNumber]
  );
  return fromRow(result.rows[0]);
}

async function listSnapshots(itemNumber) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM raw_snapshots WHERE item_number = $1 ORDER BY fetched_at DESC;`,
    [itemNumber]
  );
  return result.rows.map(fromRow);
}

module.exports = { saveSnapshot, getLatestSnapshot, listSnapshots };
