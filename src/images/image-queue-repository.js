const { getPool } = require('../db/connection');
const { computeBackoffMs, isRetryableErrorType } = require('../net/backoff');

// The image work queue. Structurally the same lifecycle as
// crawl-queue-repository.js (pending/processing/succeeded/failed/
// retrying/dead_letter, FOR UPDATE SKIP LOCKED claiming, crash recovery),
// but a completely separate table and module — a slow or failed image
// fetch must never touch, block, or fail a product-page crawl job.

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemNumber: row.item_number,
    sourceName: row.source_name,
    imageUrl: row.image_url,
    refererUrl: row.referer_url,
    role: row.role,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    etag: row.etag,
    lastModified: row.last_modified,
    lastErrorType: row.last_error_type,
    lastErrorMessage: row.last_error_message
  };
}

async function enqueueImageJob({ itemNumber, sourceName, imageUrl, refererUrl = null, role = 'hero', maxAttempts = 5 }) {
  const pool = getPool();
  try {
    const result = await pool.query(
      `INSERT INTO image_jobs (item_number, source_name, image_url, referer_url, role, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [itemNumber, sourceName, imageUrl, refererUrl, role, maxAttempts]
    );
    return { ...fromRow(result.rows[0]), deduped: false };
  } catch (error) {
    if (error.code !== '23505') throw error;
    const existing = await pool.query(
      'SELECT * FROM image_jobs WHERE item_number = $1 AND image_url = $2;',
      [itemNumber, imageUrl]
    );
    return { ...fromRow(existing.rows[0]), deduped: true };
  }
}

async function claimNextImageJob({ workerId, now = new Date() }) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE image_jobs
     SET status = 'processing', locked_by = $1, locked_at = $2, updated_at = $2
     WHERE id = (
       SELECT id FROM image_jobs
       WHERE status IN ('pending', 'retrying') AND next_attempt_at <= $2
       ORDER BY next_attempt_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *;`,
    [workerId, now]
  );
  return fromRow(result.rows[0]);
}

async function markImageSucceeded(jobId, { etag = null, lastModified = null } = {}) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE image_jobs
     SET status = 'succeeded', locked_by = NULL, locked_at = NULL,
         etag = COALESCE($2, etag), last_modified = COALESCE($3, last_modified), updated_at = now()
     WHERE id = $1
     RETURNING *;`,
    [jobId, etag, lastModified]
  );
  return fromRow(result.rows[0]);
}

async function markImageFailed(jobId, { errorType, errorMessage, now = new Date() }) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const jobResult = await client.query('SELECT * FROM image_jobs WHERE id = $1 FOR UPDATE;', [jobId]);
    const job = fromRow(jobResult.rows[0]);
    if (!job) throw new Error(`No such image job: ${jobId}`);

    const attempts = job.attempts + 1;
    const retryable = isRetryableErrorType(errorType) && attempts < job.maxAttempts;

    if (retryable) {
      const delayMs = computeBackoffMs({ attempt: attempts, baseMs: 1000, maxMs: 60000 });
      const nextAttemptAt = new Date(now.getTime() + delayMs);
      const updated = await client.query(
        `UPDATE image_jobs
         SET status = 'retrying', attempts = $2, next_attempt_at = $3,
             last_error_type = $4, last_error_message = $5,
             locked_by = NULL, locked_at = NULL, updated_at = $6
         WHERE id = $1
         RETURNING *;`,
        [jobId, attempts, nextAttemptAt, errorType, errorMessage, now]
      );
      await client.query('COMMIT');
      return fromRow(updated.rows[0]);
    }

    const updated = await client.query(
      `UPDATE image_jobs
       SET status = 'dead_letter', attempts = $2,
           last_error_type = $3, last_error_message = $4,
           locked_by = NULL, locked_at = NULL, updated_at = $5
       WHERE id = $1
       RETURNING *;`,
      [jobId, attempts, errorType, errorMessage, now]
    );

    const reason = attempts >= job.maxAttempts
      ? `Exhausted ${job.maxAttempts} attempts. Last error (${errorType}): ${errorMessage}`
      : `Non-retryable error (${errorType}): ${errorMessage}`;

    await client.query(
      `INSERT INTO image_dead_letter (image_job_id, item_number, source_name, image_url, reason, attempts, failed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [jobId, job.itemNumber, job.sourceName, job.imageUrl, reason, attempts, now]
    );

    await client.query('COMMIT');
    return fromRow(updated.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reclaimStaleImageJobs({ leaseMs = 5 * 60 * 1000, now = new Date() } = {}) {
  const pool = getPool();
  const cutoff = new Date(now.getTime() - leaseMs);
  const result = await pool.query(
    `UPDATE image_jobs
     SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = $2
     WHERE status = 'processing' AND locked_at < $1
     RETURNING *;`,
    [cutoff, now]
  );
  return result.rows.map(fromRow);
}

async function countAllStatuses() {
  const pool = getPool();
  const result = await pool.query('SELECT status, COUNT(*)::int AS n FROM image_jobs GROUP BY status;');
  const counts = { pending: 0, processing: 0, retrying: 0, succeeded: 0, dead_letter: 0 };
  for (const row of result.rows) counts[row.status] = row.n;
  return counts;
}

async function getImageJobById(jobId) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM image_jobs WHERE id = $1;', [jobId]);
  return fromRow(result.rows[0]);
}

async function listImageDeadLetter({ itemNumber = null } = {}) {
  const pool = getPool();
  const result = itemNumber
    ? await pool.query('SELECT * FROM image_dead_letter WHERE item_number = $1 ORDER BY failed_at DESC;', [itemNumber])
    : await pool.query('SELECT * FROM image_dead_letter ORDER BY failed_at DESC;');
  return result.rows;
}

module.exports = {
  enqueueImageJob,
  claimNextImageJob,
  markImageSucceeded,
  markImageFailed,
  reclaimStaleImageJobs,
  getImageJobById,
  countAllStatuses,
  listImageDeadLetter
};
