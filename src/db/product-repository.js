const { getPool } = require('./connection');
const { createEmptyProductRecord, normalizeProductRecord } = require('../schema/product-schema');

const COLUMNS = Object.keys(createEmptyProductRecord());

// Normalized JS record -> ordered array of DB-ready values (COLUMNS order).
// Pure function, no DB access — independently unit-testable.
function toRow(product) {
  const record = normalizeProductRecord(product);
  return COLUMNS.map((field) => {
    const value = record[field];
    if (field === 'professional_ratings' || field === 'image_urls') {
      return JSON.stringify(Array.isArray(value) ? value : []);
    }
    return value;
  });
}

// DB row (as returned by `pg`) -> normalized JS record. Pure function.
function fromRow(row) {
  if (!row) return null;

  const record = createEmptyProductRecord();
  for (const field of COLUMNS) {
    if (field === 'professional_ratings' || field === 'image_urls') {
      const raw = row[field];
      // node-postgres returns JSONB columns already parsed into JS
      // values, but tolerate a raw string too (e.g. a driver mock in tests).
      record[field] = Array.isArray(raw) ? raw : (typeof raw === 'string' ? JSON.parse(raw) : []);
      continue;
    }
    if (field === 'scraped_at' && row[field] instanceof Date) {
      record[field] = row[field].toISOString();
      continue;
    }
    record[field] = row[field] === undefined ? null : row[field];
  }
  return record;
}

// INSERT ... ON CONFLICT (item_number) DO UPDATE — the Wine Outlet item
// number is the canonical identity; re-crawling the same product never
// creates a duplicate row, it updates the existing one in place.
async function upsertProduct(product) {
  const pool = getPool();
  const values = toRow(product);

  const columnList = COLUMNS.join(', ');
  const placeholders = COLUMNS.map((_, index) => `$${index + 1}`).join(', ');
  const updateAssignments = COLUMNS
    .filter((field) => field !== 'item_number')
    .map((field) => `${field} = EXCLUDED.${field}`)
    .join(', ');

  const sql = `
    INSERT INTO products (${columnList})
    VALUES (${placeholders})
    ON CONFLICT (item_number) DO UPDATE SET
      ${updateAssignments},
      updated_at = now()
    RETURNING *;
  `;

  const result = await pool.query(sql, values);
  return fromRow(result.rows[0]);
}

async function getProductByItemNumber(itemNumber) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM products WHERE item_number = $1;', [itemNumber]);
  return fromRow(result.rows[0]);
}

async function deleteProductByItemNumber(itemNumber) {
  const pool = getPool();
  await pool.query('DELETE FROM products WHERE item_number = $1;', [itemNumber]);
}

async function countProducts() {
  const pool = getPool();
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM products;');
  return result.rows[0].count;
}

// Search/pagination for the frontend product list (final pass). `search`
// matches item_number/product_name/producer/varietal case-insensitively;
// left empty, it lists everything. Ordered newest-updated-first so the
// most recently crawled/edited products surface at the top.
async function listProducts({ search = null, limit = 25, offset = 0 } = {}) {
  const pool = getPool();
  const boundedLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const boundedOffset = Math.max(Number(offset) || 0, 0);

  const conditions = [];
  const values = [];
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(item_number ILIKE $${values.length} OR product_name ILIKE $${values.length} OR producer ILIKE $${values.length} OR varietal ILIKE $${values.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  values.push(boundedLimit, boundedOffset);
  const result = await pool.query(
    `SELECT * FROM products ${where} ORDER BY updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length};`,
    values
  );

  const countResult = await pool.query(`SELECT COUNT(*)::int AS n FROM products ${where};`, values.slice(0, conditions.length));

  return { products: result.rows.map(fromRow), total: countResult.rows[0].n, limit: boundedLimit, offset: boundedOffset };
}

// Additive convenience wrapper (Block 2): upserts exactly as upsertProduct
// always has, then records field-level history for whatever changed. Does
// not alter upsertProduct's own behavior or the products table — callers
// that don't need history keep calling upsertProduct() directly.
async function upsertProductWithHistory(product, { sourceSite, runId } = {}) {
  const { recordFieldChanges } = require('../history/field-history-repository');

  const previous = await getProductByItemNumber(product.item_number);
  const saved = await upsertProduct(product);
  await recordFieldChanges({
    itemNumber: product.item_number,
    previousProduct: previous,
    newProduct: saved,
    sourceSite: sourceSite || saved.source_site,
    runId
  });
  return saved;
}

module.exports = {
  COLUMNS,
  toRow,
  fromRow,
  upsertProduct,
  upsertProductWithHistory,
  getProductByItemNumber,
  deleteProductByItemNumber,
  countProducts,
  listProducts
};
