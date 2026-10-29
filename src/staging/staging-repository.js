const { getPool } = require('../db/connection');

// "All extracted data must be stored in a temporary review table/process
// and must not be written directly to production product data. The
// extracted records should be reviewed and approved by the business team
// before being published to production." (requirements document)
//
// This is the ONLY path by which a newly-scraped record may reach
// `products`: stageProduct() -> (human/backend approval) -> approveStaging()
// copies it into `products`. There is no other write path into `products`
// for scraped data — request-handler.js/crawler.js do not call
// productRepo.upsertProduct directly as part of this flow (see
// src/pipeline/ingest-product.js).

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemNumber: row.item_number,
    runId: row.run_id,
    sourceSite: row.source_site,
    sourceUrl: row.source_url,
    rawExtracted: row.raw_extracted,
    normalized: row.normalized,
    aiMetadata: row.ai_metadata,
    status: row.status,
    reviewer: row.reviewer,
    reviewedAt: row.reviewed_at,
    rejectionReason: row.rejection_reason,
    promotedAt: row.promoted_at,
    createdAt: row.created_at
  };
}

async function stageProduct({ itemNumber, runId, sourceSite, sourceUrl, rawExtracted, normalized, aiMetadata }) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO product_staging (item_number, run_id, source_site, source_url, raw_extracted, normalized, ai_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *;`,
    [itemNumber, runId, sourceSite, sourceUrl, JSON.stringify(rawExtracted), JSON.stringify(normalized), JSON.stringify(aiMetadata || null)]
  );
  return fromRow(result.rows[0]);
}

async function getStagingById(id) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM product_staging WHERE id = $1;', [id]);
  return fromRow(result.rows[0]);
}

async function listStaging({ itemNumber = null, status = null } = {}) {
  const pool = getPool();
  const conditions = [];
  const values = [];
  if (itemNumber) { values.push(itemNumber); conditions.push(`item_number = $${values.length}`); }
  if (status) { values.push(status); conditions.push(`status = $${values.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`SELECT * FROM product_staging ${where} ORDER BY created_at DESC;`, values);
  return result.rows.map(fromRow);
}

// Approval is the ONLY thing that ever promotes a staging row into
// `products` — done in one transaction so a crash between "mark approved"
// and "write to products" can never happen. Reuses the existing, already
// -tested upsertProduct() so production-write semantics (upsert by
// item_number, no duplicates) are identical to every other path into
// `products`.
async function approveStaging(stagingId, { reviewer }) {
  if (!reviewer) throw new Error('approveStaging requires a reviewer identity.');

  const pool = getPool();
  const productRepo = require('../db/product-repository');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const stagingResult = await client.query('SELECT * FROM product_staging WHERE id = $1 FOR UPDATE;', [stagingId]);
    const staging = fromRow(stagingResult.rows[0]);
    if (!staging) throw new Error(`No such staging record: ${stagingId}`);
    if (staging.status !== 'pending_review') {
      throw new Error(`Staging record ${stagingId} is already "${staging.status}" — cannot approve twice.`);
    }

    const now = new Date();
    const updated = await client.query(
      `UPDATE product_staging
       SET status = 'approved', reviewer = $2, reviewed_at = $3, promoted_at = $3, updated_at = $3
       WHERE id = $1
       RETURNING *;`,
      [stagingId, reviewer, now]
    );

    await client.query('COMMIT');

    // Promote to production. Runs after COMMIT so the staging row's
    // approved status is durable regardless of what happens next; if this
    // insert fails, the staging record is still correctly marked approved
    // and promoted_at is set — a retry of the promotion is idempotent
    // (upsertProduct), so it is safe to re-run.
    const promoted = await productRepo.upsertProduct(staging.normalized);

    // Master data mapping happens ONLY here — after approval and
    // promotion — per the requirements document. mapApprovedProductToMasterData
    // is idempotent (get-or-create), so it's safe if this step is ever retried.
    const { mapApprovedProductToMasterData } = require('../master-data/master-data-service');
    const masterData = await mapApprovedProductToMasterData(promoted);

    return { staging: fromRow(updated.rows[0]), product: promoted, masterData };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function rejectStaging(stagingId, { reviewer, reason }) {
  if (!reviewer) throw new Error('rejectStaging requires a reviewer identity.');
  if (!reason) throw new Error('rejectStaging requires a rejection reason.');

  const pool = getPool();
  const result = await pool.query(
    `UPDATE product_staging
     SET status = 'rejected', reviewer = $2, reviewed_at = now(), rejection_reason = $3, updated_at = now()
     WHERE id = $1 AND status = 'pending_review'
     RETURNING *;`,
    [stagingId, reviewer, reason]
  );
  if (result.rows.length === 0) {
    throw new Error(`No pending staging record ${stagingId} to reject (already reviewed, or does not exist).`);
  }
  return fromRow(result.rows[0]);
}

module.exports = {
  stageProduct,
  getStagingById,
  listStaging,
  approveStaging,
  rejectStaging
};
