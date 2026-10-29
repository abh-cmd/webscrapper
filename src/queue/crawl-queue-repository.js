const { getPool } = require('../db/connection');
const { canonicalizeUrl } = require('./url-canonicalizer');
const { computeBackoffMs, isRetryableErrorType } = require('../net/backoff');

function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemNumber: row.item_number,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    canonicalUrl: row.canonical_url,
    productHash: row.product_hash,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lastErrorType: row.last_error_type,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Enqueues one crawl work item. If a job already exists for the same
// canonical URL, or for the same product-identity hash (a different URL
// for what is identity-wise the same physical product), the existing job
// is returned unchanged instead of creating a duplicate — this is what
// satisfies both "canonical URL deduplication" and "UPC/SKU + size
// deduplication" without a racy check-then-insert: the database's own
// UNIQUE constraints are the source of truth, and a unique-violation is
// caught and resolved to a lookup, which is safe under concurrent enqueues.
async function enqueueJob({ itemNumber, sourceName, sourceUrl, productHash = null, maxAttempts = 5 }) {
  const pool = getPool();
  const canonicalUrl = canonicalizeUrl(sourceUrl);

  try {
    const result = await pool.query(
      `INSERT INTO crawl_jobs (item_number, source_name, source_url, canonical_url, product_hash, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *;`,
      [itemNumber, sourceName, sourceUrl, canonicalUrl, productHash, maxAttempts]
    );
    return { ...fromRow(result.rows[0]), deduped: false };
  } catch (error) {
    if (error.code !== '23505') throw error; // not a unique-violation -> a real error

    const existing = await pool.query(
      `SELECT * FROM crawl_jobs
       WHERE canonical_url = $1 OR (product_hash IS NOT NULL AND product_hash = $2)
       ORDER BY id ASC
       LIMIT 1;`,
      [canonicalUrl, productHash]
    );
    return { ...fromRow(existing.rows[0]), deduped: true };
  }
}

// Concurrency-safe claim: FOR UPDATE SKIP LOCKED means two workers calling
// this simultaneously will never claim the same row, and neither blocks
// waiting on the other — the second worker just gets the next available
// row (or null if there isn't one).
async function claimNextJob({ workerId, now = new Date() }) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE crawl_jobs
     SET status = 'processing', locked_by = $1, locked_at = $2, updated_at = $2
     WHERE id = (
       SELECT id FROM crawl_jobs
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

async function markSucceeded(jobId) {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE crawl_jobs
     SET status = 'succeeded', locked_by = NULL, locked_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *;`,
    [jobId]
  );
  return fromRow(result.rows[0]);
}

// Classifies the failure, applies exponential backoff with jitter for a
// retryable failure (up to max_attempts), or moves the job to dead_letter
// (writing a readable reason to dead_letter_jobs) once retries are
// exhausted or the error type is not retryable at all.
async function markFailed(jobId, { errorType, errorMessage, now = new Date() }) {
  const pool = getPool();

  return withTransaction(pool, async (client) => {
    const jobResult = await client.query('SELECT * FROM crawl_jobs WHERE id = $1 FOR UPDATE;', [jobId]);
    const job = fromRow(jobResult.rows[0]);
    if (!job) throw new Error(`No such crawl job: ${jobId}`);

    const attempts = job.attempts + 1;
    const retryable = isRetryableErrorType(errorType) && attempts < job.maxAttempts;

    if (retryable) {
      const delayMs = computeBackoffMs({ attempt: attempts, baseMs: 1000, maxMs: 60000 });
      const nextAttemptAt = new Date(now.getTime() + delayMs);
      const updated = await client.query(
        `UPDATE crawl_jobs
         SET status = 'retrying', attempts = $2, next_attempt_at = $3,
             last_error_type = $4, last_error_message = $5,
             locked_by = NULL, locked_at = NULL, updated_at = $6
         WHERE id = $1
         RETURNING *;`,
        [jobId, attempts, nextAttemptAt, errorType, errorMessage, now]
      );
      return fromRow(updated.rows[0]);
    }

    const updated = await client.query(
      `UPDATE crawl_jobs
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
      `INSERT INTO dead_letter_jobs (crawl_job_id, item_number, source_name, source_url, reason, attempts, failed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7);`,
      [jobId, job.itemNumber, job.sourceName, job.sourceUrl, reason, attempts, now]
    );

    return fromRow(updated.rows[0]);
  });
}

// Crash/restart recovery: a job left in 'processing' with a lock older
// than leaseMs is assumed to belong to a worker that died mid-request.
// It is returned to 'pending' so another worker can claim it — nothing is
// permanently lost, and it is not silently re-marked 'succeeded'.
async function reclaimStaleJobs({ leaseMs = 5 * 60 * 1000, now = new Date() } = {}) {
  const pool = getPool();
  const cutoff = new Date(now.getTime() - leaseMs);
  const result = await pool.query(
    `UPDATE crawl_jobs
     SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = $2
     WHERE status = 'processing' AND locked_at < $1
     RETURNING *;`,
    [cutoff, now]
  );
  return result.rows.map(fromRow);
}

async function getJobById(jobId) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM crawl_jobs WHERE id = $1;', [jobId]);
  return fromRow(result.rows[0]);
}

async function countByStatus(status) {
  const pool = getPool();
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM crawl_jobs WHERE status = $1;', [status]);
  return result.rows[0].n;
}

// All status counts in one query, for the queue dashboard (final pass) —
// every possible status key is always present (0 when there are no jobs
// in that state), so a frontend never has to guard against a missing key.
async function countAllStatuses() {
  const pool = getPool();
  const result = await pool.query('SELECT status, COUNT(*)::int AS n FROM crawl_jobs GROUP BY status;');
  const counts = { pending: 0, processing: 0, retrying: 0, succeeded: 0, dead_letter: 0 };
  for (const row of result.rows) counts[row.status] = row.n;
  return counts;
}

async function listRecentJobs({ limit = 25 } = {}) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM crawl_jobs ORDER BY updated_at DESC LIMIT $1;', [Math.min(Math.max(Number(limit) || 25, 1), 200)]);
  return result.rows.map(fromRow);
}

async function listDeadLetter({ itemNumber = null } = {}) {
  const pool = getPool();
  const result = itemNumber
    ? await pool.query('SELECT * FROM dead_letter_jobs WHERE item_number = $1 ORDER BY failed_at DESC;', [itemNumber])
    : await pool.query('SELECT * FROM dead_letter_jobs ORDER BY failed_at DESC;');
  return result.rows;
}

async function withTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  enqueueJob,
  claimNextJob,
  markSucceeded,
  markFailed,
  reclaimStaleJobs,
  getJobById,
  countByStatus,
  countAllStatuses,
  listRecentJobs,
  listDeadLetter
};
