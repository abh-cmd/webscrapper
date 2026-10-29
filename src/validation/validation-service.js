const { getPool } = require('../db/connection');
const { getAiProvider } = require('../ai/provider-factory');
const { validateAnalysisResult } = require('../ai/response-validator');

// Objective 1: "Reading all existing product records from the database.
// Analyzing product descriptions and associated attributes... Generating:
// Recommended corrections, Alternative attribute values, Confidence
// scores... Producing an exception report for human review and approval."
//
// This operates on records ALREADY in `products` — distinct from staging
// (which gates NEW scraped records before they ever reach `products`).
// Findings never auto-apply; approveException() is the only thing that
// ever changes a `products` row here, and only for the single field named
// in that finding.

function findingFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemNumber: row.item_number,
    fieldName: row.field_name,
    currentValue: row.current_value,
    suggestedValue: row.suggested_value,
    confidence: Number(row.confidence),
    reason: row.reason,
    provider: row.provider,
    status: row.status,
    reviewer: row.reviewer,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at
  };
}

// Runs the AI/rule-based validator against every product in `products`
// (or a specific list of item numbers), and records each new finding as a
// pending_review exception. Does not re-insert a finding that already has
// a pending_review row for the same item_number/field/suggestedValue, so
// repeated runs don't pile up duplicate noise.
// onRaw(itemNumber, {rawFindings, filteredFindings, rejectionReason}) is a
// purely observational side-channel (optional, default no-op) — it never
// changes what gets inserted or how validation decisions are made. It lets
// a caller (the live-pipeline UI) show the model's actual, unfiltered
// findings next to the application's own accept/drop decision.
async function runValidation({ itemNumbers = null, provider = null, onRaw = null } = {}) {
  const pool = getPool();
  const aiProvider = provider || getAiProvider();
  const rawCallback = onRaw || (() => {});

  const productsResult = itemNumbers
    ? await pool.query('SELECT * FROM products WHERE item_number = ANY($1::text[]);', [itemNumbers])
    : await pool.query('SELECT * FROM products;');

  const productRepo = require('../db/product-repository');
  const created = [];
  // A provider failure (network error, timeout, malformed response — the
  // real HTTP provider's actual failure modes) on one product must never
  // abort analysis of every other product in the batch, and must never
  // corrupt that product's own row — it just means no new finding is
  // recorded for it this run. `created` stays a plain array — deep-equal
  // to a plain [] whenever nothing was created, exactly as every existing
  // caller/test already expects — with the failure list attached as a
  // NON-enumerable property, so assert.deepStrictEqual(created, []) still
  // passes untouched while `created.failed` remains available to any
  // caller that wants to inspect it.
  const failed = [];
  Object.defineProperty(created, 'failed', { value: failed, enumerable: false });

  for (const row of productsResult.rows) {
    const product = productRepo.fromRow(row);

    let rawResult;
    try {
      rawResult = await aiProvider.analyzeProduct(product);
    } catch (error) {
      console.warn(`[validation-service] AI provider failed for ${product.item_number} (${error.type || error.name || 'error'}): ${error.message}`);
      failed.push({ itemNumber: product.item_number, errorType: error.type || error.name || 'AI_PROVIDER_ERROR', errorMessage: error.message });
      rawCallback(product.item_number, { ok: false, error: { type: error.type || error.name || 'AI_PROVIDER_ERROR', message: error.message } });
      continue;
    }

    // Safety net: a malformed finding (unknown field, an attempt to
    // "correct" a not-correctable identity field, an out-of-range
    // confidence) is dropped here, before it ever reaches the exception
    // table — never trusted just because a provider returned it.
    const { filteredFindings: findings, reason: validationRejectionReason } = validateAnalysisResult(rawResult);
    if (validationRejectionReason) {
      console.warn(`[validation-service] dropped malformed finding(s) for ${product.item_number}: ${validationRejectionReason}`);
    }
    const providerName = rawResult.provider;
    rawCallback(product.item_number, {
      ok: true,
      rawFindings: rawResult.findings,
      filteredFindings: findings,
      rejectionReason: validationRejectionReason || null,
      provider: rawResult.provider,
      model: rawResult.model
    });

    for (const finding of findings) {
      const existing = await pool.query(
        `SELECT id FROM product_validation_exceptions
         WHERE item_number = $1 AND field_name = $2 AND status = 'pending_review'
           AND suggested_value IS NOT DISTINCT FROM $3;`,
        [product.item_number, finding.field, finding.suggestedValue]
      );
      if (existing.rows.length > 0) continue;

      const inserted = await pool.query(
        `INSERT INTO product_validation_exceptions
           (item_number, field_name, current_value, suggested_value, confidence, reason, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *;`,
        [product.item_number, finding.field, finding.currentValue, finding.suggestedValue, finding.confidence, finding.reason, providerName]
      );
      created.push(findingFromRow(inserted.rows[0]));
    }
  }

  return created;
}

async function listExceptions({ itemNumber = null, status = null } = {}) {
  const pool = getPool();
  const conditions = [];
  const values = [];
  if (itemNumber) { values.push(itemNumber); conditions.push(`item_number = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM product_validation_exceptions ${where} ORDER BY created_at DESC;`, values);
  return result.rows.map(findingFromRow);
}

// Approving a finding is the only thing that ever changes `products` here
// — and it changes exactly the one named field, to exactly the suggested
// value, nothing else.
async function approveException(exceptionId, { reviewer }) {
  if (!reviewer) throw new Error('approveException requires a reviewer identity.');

  // item_number is the primary key and source_* / scraped_at describe
  // provenance, not a correctable product attribute — a finding must never
  // be able to rewrite any of those, regardless of what field_name it names.
  const NOT_CORRECTABLE = new Set(['item_number', 'source_site', 'source_url', 'scraped_at']);
  const ALLOWED_FIELDS = new Set(
    Object.keys(require('../schema/product-schema').createEmptyProductRecord())
      .filter((field) => !NOT_CORRECTABLE.has(field))
  );

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const findingResult = await client.query('SELECT * FROM product_validation_exceptions WHERE id = $1 FOR UPDATE;', [exceptionId]);
    const finding = findingFromRow(findingResult.rows[0]);
    if (!finding) throw new Error(`No such validation exception: ${exceptionId}`);
    if (finding.status !== 'pending_review') throw new Error(`Exception ${exceptionId} is already "${finding.status}".`);
    if (!ALLOWED_FIELDS.has(finding.fieldName)) throw new Error(`Refusing to apply a finding for unknown field "${finding.fieldName}".`);

    await client.query(
      `UPDATE products SET ${finding.fieldName} = $2, updated_at = now() WHERE item_number = $1;`,
      [finding.itemNumber, finding.suggestedValue]
    );

    const updated = await client.query(
      `UPDATE product_validation_exceptions
       SET status = 'approved', reviewer = $2, reviewed_at = now()
       WHERE id = $1
       RETURNING *;`,
      [exceptionId, reviewer]
    );

    await client.query('COMMIT');
    return findingFromRow(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectException(exceptionId, { reviewer }) {
  if (!reviewer) throw new Error('rejectException requires a reviewer identity.');
  const pool = getPool();
  const result = await pool.query(
    `UPDATE product_validation_exceptions
     SET status = 'rejected', reviewer = $2, reviewed_at = now()
     WHERE id = $1 AND status = 'pending_review'
     RETURNING *;`,
    [exceptionId, reviewer]
  );
  if (result.rows.length === 0) throw new Error(`No pending exception ${exceptionId} to reject.`);
  return findingFromRow(result.rows[0]);
}

module.exports = { runValidation, listExceptions, approveException, rejectException };
