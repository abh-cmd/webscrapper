const { getPool } = require('../db/connection');
const { createEmptyProductRecord } = require('../schema/product-schema');

const TRACKED_FIELDS = Object.keys(createEmptyProductRecord()).filter(
  (field) => !['item_number', 'scraped_at'].includes(field)
);

function serialize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  return String(value);
}

// Diffs the previous and new normalized record and writes one history row
// per field that actually changed — not a row per field per crawl. Does
// not touch the canonical `products` row; this is a pure, additive audit
// trail. previousProduct may be null (first time this product is ever seen).
async function recordFieldChanges({ itemNumber, previousProduct, newProduct, sourceSite, runId }) {
  const pool = getPool();
  const changes = [];

  for (const field of TRACKED_FIELDS) {
    const oldValue = serialize(previousProduct ? previousProduct[field] : null);
    const newValue = serialize(newProduct[field]);
    if (oldValue !== newValue) {
      changes.push({ field, oldValue, newValue });
    }
  }

  if (changes.length === 0) return [];

  const values = [];
  const placeholders = changes.map((change, index) => {
    const base = index * 6;
    values.push(itemNumber, change.field, change.oldValue, change.newValue, sourceSite, runId);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });

  const result = await pool.query(
    `INSERT INTO product_field_history (item_number, field_name, old_value, new_value, source_site, run_id)
     VALUES ${placeholders.join(', ')}
     RETURNING *;`,
    values
  );

  return result.rows;
}

async function getFieldHistory(itemNumber, fieldName) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM product_field_history
     WHERE item_number = $1 AND field_name = $2
     ORDER BY changed_at ASC;`,
    [itemNumber, fieldName]
  );
  return result.rows;
}

module.exports = { recordFieldChanges, getFieldHistory, TRACKED_FIELDS };
