const { getPool } = require('../db/connection');

// Aggregate metrics computed from the queue/dead-letter tables that
// already exist (crawl_jobs, image_jobs, dead_letter_jobs,
// image_dead_letter) — no new report format is introduced; this reads
// what the crawl/image pipeline already recorded, per the requirement's
// list of per-run metrics (pages attempted/succeeded/blocked/retried/
// items extracted, and the parallel image metrics).

async function computePageMetrics(sourceName, { sinceMinutes = 1440 } = {}) {
  const pool = getPool();
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);

  const result = await pool.query(
    `SELECT status, last_error_type, attempts
     FROM crawl_jobs
     WHERE source_name = $1 AND created_at >= $2;`,
    [sourceName, since]
  );

  const rows = result.rows;
  const attempted = rows.length;
  const succeeded = rows.filter((r) => r.status === 'succeeded').length;
  const blocked = rows.filter((r) => r.last_error_type === 'ACCESS_DENIED').length;
  const retried = rows.filter((r) => Number(r.attempts) > 1).length;
  const deadLettered = rows.filter((r) => r.status === 'dead_letter').length;

  return {
    sourceName,
    windowMinutes: sinceMinutes,
    pagesAttempted: attempted,
    pagesSucceeded: succeeded,
    pagesBlocked: blocked,
    pagesRetried: retried,
    pagesDeadLettered: deadLettered,
    itemsExtracted: succeeded,
    blockRate: attempted === 0 ? 0 : blocked / attempted
  };
}

async function computeImageMetrics(sourceName, { sinceMinutes = 1440 } = {}) {
  const pool = getPool();
  const since = new Date(Date.now() - sinceMinutes * 60 * 1000);

  const jobs = await pool.query(
    `SELECT status, last_error_type FROM image_jobs WHERE source_name = $1 AND created_at >= $2;`,
    [sourceName, since]
  );

  const rows = jobs.rows;
  const queued = rows.length;
  const downloaded = rows.filter((r) => r.status === 'succeeded').length;
  const deadLettered = rows.filter((r) => r.status === 'dead_letter').length;

  const rejectedByReason = {};
  for (const row of rows) {
    if (row.status === 'dead_letter' && row.last_error_type) {
      rejectedByReason[row.last_error_type] = (rejectedByReason[row.last_error_type] || 0) + 1;
    }
  }

  const references = await pool.query(
    `SELECT COUNT(*)::int AS n FROM image_references WHERE source_name = $1 AND role = 'placeholder' AND fetched_at >= $2;`,
    [sourceName, since]
  );
  const placeholderCount = references.rows[0].n;

  return {
    sourceName,
    windowMinutes: sinceMinutes,
    imagesQueued: queued,
    imagesDownloaded: downloaded,
    imagesDeadLettered: deadLettered,
    imagesRejectedByReason: rejectedByReason,
    imagesRejectedTotal: deadLettered,
    placeholderCount,
    rejectionRate: queued === 0 ? 0 : deadLettered / queued,
    placeholderRate: queued === 0 ? 0 : placeholderCount / queued
  };
}

async function computeRunMetrics(sourceName, options = {}) {
  const [pages, images] = await Promise.all([
    computePageMetrics(sourceName, options),
    computeImageMetrics(sourceName, options)
  ]);
  return { ...pages, ...images };
}

// For the frontend Sources view (final pass): the most recent crawl_jobs
// row per source (whatever its outcome), joined with the compliance
// record — one row per source that has ever actually been attempted, so
// "last crawl / HTTP status / blocked status / error classification" is
// always the real, most recent observed state, not a static list.
async function getSourceStatusOverview() {
  const pool = getPool();
  const result = await pool.query(`
    SELECT DISTINCT ON (cj.source_name)
      cj.source_name, cj.status AS last_job_status, cj.last_error_type,
      cj.last_error_message, cj.updated_at AS last_attempted_at,
      sc.robots_txt_honored, sc.tos_review_status, sc.enabled_in_production
    FROM crawl_jobs cj
    LEFT JOIN source_compliance sc ON sc.source_name = cj.source_name
    ORDER BY cj.source_name, cj.updated_at DESC;
  `);
  return result.rows.map((row) => ({
    sourceName: row.source_name,
    lastJobStatus: row.last_job_status,
    lastErrorType: row.last_error_type,
    lastErrorMessage: row.last_error_message,
    lastAttemptedAt: row.last_attempted_at,
    robotsTxtHonored: row.robots_txt_honored,
    tosReviewStatus: row.tos_review_status,
    enabledInProduction: row.enabled_in_production
  }));
}

module.exports = { computePageMetrics, computeImageMetrics, computeRunMetrics, getSourceStatusOverview };
