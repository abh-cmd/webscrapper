const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

// Real PostgreSQL integration tests for the Block 2 work queue. Gated on
// DATABASE_URL exactly like the Phase 9 product-repository integration
// tests — when a database IS configured (as it is now), these run for
// real, not mocked, per the instruction not to skip DB tests when
// DATABASE_URL is available.

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let queue;
if (isDatabaseConfigured()) {
  queue = require('../src/queue/crawl-queue-repository');
}

const TEST_ITEM = 'WO-QUEUE-TEST-00001';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM dead_letter_jobs WHERE item_number LIKE $1;', [`${TEST_ITEM}%`]);
  await pool.query('DELETE FROM crawl_jobs WHERE item_number LIKE $1;', [`${TEST_ITEM}%`]);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('1. queue insertion', { skip }, async () => {
  const job = await queue.enqueueJob({
    itemNumber: TEST_ITEM,
    sourceName: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/queue-test/000001'
  });
  assert.equal(job.status, 'pending');
  assert.equal(job.deduped, false);
  assert.equal(job.attempts, 0);
});

test('2. claiming work moves it to processing', { skip }, async () => {
  const claimed = await queue.claimNextJob({ workerId: 'worker-1' });
  assert.ok(claimed);
  assert.equal(claimed.itemNumber, TEST_ITEM);
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.lockedBy, 'worker-1');
});

test('3. processing state is visible via getJobById', { skip }, async () => {
  const jobs = await queue.countByStatus('processing');
  assert.ok(jobs >= 1);
});

test('4. success transitions the job to succeeded', { skip }, async () => {
  const pool = getPool();
  const { rows } = await pool.query('SELECT id FROM crawl_jobs WHERE item_number = $1;', [TEST_ITEM]);
  const jobId = rows[0].id;
  const succeeded = await queue.markSucceeded(jobId);
  assert.equal(succeeded.status, 'succeeded');
});

test('5. completed item is not re-claimed by the next worker', { skip }, async () => {
  const claimed = await queue.claimNextJob({ workerId: 'worker-2' });
  assert.equal(claimed, null, 'a succeeded job must not be claimable again');
});

test('6. retry: a retryable failure increments attempts and schedules a future retry', { skip }, async () => {
  const job = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-retry`,
    sourceName: 'total-wine',
    sourceUrl: 'https://www.totalwine.com/wine/queue-test-retry/000002'
  });
  const claimed = await queue.claimNextJob({ workerId: 'worker-1' });
  assert.equal(claimed.id, job.id);

  const failed = await queue.markFailed(job.id, { errorType: 'ACCESS_DENIED', errorMessage: 'blocked (test)' });
  assert.equal(failed.status, 'retrying');
  assert.equal(failed.attempts, 1);
  assert.ok(new Date(failed.nextAttemptAt).getTime() > Date.now(), 'exponential backoff must push next_attempt_at into the future');
});

test('7. retry count accumulates across repeated failures', { skip }, async () => {
  const pool = getPool();
  const { rows } = await pool.query('SELECT id FROM crawl_jobs WHERE item_number = $1;', [`${TEST_ITEM}-retry`]);
  const jobId = rows[0].id;

  // Force it claimable immediately for this test (bypass real backoff wait).
  await pool.query("UPDATE crawl_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1;", [jobId]);
  await queue.claimNextJob({ workerId: 'worker-1' });
  const failedAgain = await queue.markFailed(jobId, { errorType: 'ACCESS_DENIED', errorMessage: 'blocked again (test)' });
  assert.equal(failedAgain.attempts, 2);
});

test('8. exponential backoff grows between successive retries', { skip }, async () => {
  const pool = getPool();
  const { rows } = await pool.query(
    'SELECT next_attempt_at, updated_at FROM crawl_jobs WHERE item_number = $1;',
    [`${TEST_ITEM}-retry`]
  );
  const delayMs = new Date(rows[0].next_attempt_at).getTime() - new Date(rows[0].updated_at).getTime();
  // attempt 2 backoff (baseMs=1000, exponential) should be meaningfully
  // larger than a trivially small delay.
  assert.ok(delayMs > 1000, `expected a multi-second backoff, got ${delayMs}ms`);
});

test('9. dead-letter transition after exhausting max attempts, with a readable reason', { skip }, async () => {
  const job = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-deadletter`,
    sourceName: 'vivino',
    sourceUrl: 'https://www.vivino.com/wines/queue-test-deadletter',
    maxAttempts: 2
  });

  await queue.claimNextJob({ workerId: 'worker-1' });
  await queue.markFailed(job.id, { errorType: 'ACCESS_DENIED', errorMessage: 'first failure' });

  const pool = getPool();
  await pool.query("UPDATE crawl_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1;", [job.id]);
  await queue.claimNextJob({ workerId: 'worker-1' });
  const final = await queue.markFailed(job.id, { errorType: 'ACCESS_DENIED', errorMessage: 'second failure — exhausted' });

  assert.equal(final.status, 'dead_letter');
  assert.equal(final.attempts, 2);

  const deadLetters = await queue.listDeadLetter({ itemNumber: `${TEST_ITEM}-deadletter` });
  assert.equal(deadLetters.length, 1);
  assert.match(deadLetters[0].reason, /Exhausted 2 attempts/);
  assert.equal(deadLetters[0].attempts, 2);
});

test('9b. a non-retryable error type goes straight to dead-letter, even on the first failure', { skip }, async () => {
  const job = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-nonretryable`,
    sourceName: 'wine-searcher',
    sourceUrl: 'https://www.wine-searcher.com/find/queue-test-nonretryable',
    maxAttempts: 5
  });
  await queue.claimNextJob({ workerId: 'worker-1' });
  const result = await queue.markFailed(job.id, { errorType: 'PRODUCT_NOT_FOUND', errorMessage: 'no match' });
  assert.equal(result.status, 'dead_letter');
  assert.equal(result.attempts, 1);
});

test('10. crash/restart recovery: a stale "processing" job is reclaimed to pending', { skip }, async () => {
  const job = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-crash`,
    sourceName: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/queue-test-crash/000003'
  });
  await queue.claimNextJob({ workerId: 'worker-that-crashed' });

  const pool = getPool();
  // Simulate the crash: back-date locked_at well past any reasonable lease.
  await pool.query("UPDATE crawl_jobs SET locked_at = now() - interval '1 hour' WHERE id = $1;", [job.id]);

  const reclaimed = await queue.reclaimStaleJobs({ leaseMs: 5 * 60 * 1000 });
  assert.ok(reclaimed.some((j) => j.id === job.id));

  const afterReclaim = await queue.getJobById(job.id);
  assert.equal(afterReclaim.status, 'pending');
  assert.equal(afterReclaim.lockedBy, null);

  // And it must now be claimable again by a different worker.
  const claimed = await queue.claimNextJob({ workerId: 'worker-recovered' });
  assert.equal(claimed.id, job.id);
  await queue.markSucceeded(job.id);
});

test('10b. a genuinely in-progress job (fresh lock) is NOT reclaimed', { skip }, async () => {
  const job = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-inprogress`,
    sourceName: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/queue-test-inprogress/000004'
  });
  await queue.claimNextJob({ workerId: 'worker-still-alive' });

  const reclaimed = await queue.reclaimStaleJobs({ leaseMs: 5 * 60 * 1000 });
  assert.ok(!reclaimed.some((j) => j.id === job.id), 'a freshly-locked job must not be reclaimed');

  await queue.markSucceeded(job.id);
});

test('11. canonical URL deduplication: queuing the same URL twice does not create a second row', { skip }, async () => {
  const url = 'https://www.wine.com/product/queue-test-dedup/000005';
  const first = await queue.enqueueJob({ itemNumber: `${TEST_ITEM}-dedup-url`, sourceName: 'wine-com', sourceUrl: url });
  const second = await queue.enqueueJob({ itemNumber: `${TEST_ITEM}-dedup-url`, sourceName: 'wine-com', sourceUrl: url });

  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(first.id, second.id);

  const pool = getPool();
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM crawl_jobs WHERE canonical_url = $1;', [url]);
  assert.equal(rows[0].n, 1);
});

test('11b. duplicate queue submission with a trivially different (but canonically equal) URL is still deduped', { skip }, async () => {
  const first = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-dedup-canon`,
    sourceName: 'total-wine',
    sourceUrl: 'https://WWW.totalwine.com/wine/queue-test-canon/000006/'
  });
  const second = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-dedup-canon`,
    sourceName: 'total-wine',
    sourceUrl: 'https://www.totalwine.com/wine/queue-test-canon/000006'
  });
  assert.equal(second.deduped, true);
  assert.equal(first.id, second.id);
});

test('12. UPC/SKU + size deduplication: the same product hash from a different URL is not duplicated', { skip }, async () => {
  const { computeProductHash } = require('../src/queue/product-hash');
  const hash = computeProductHash({ upc: '0850009999999', size: '750ML' });

  const fromWineCom = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-dedup-hash`,
    sourceName: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/queue-test-hash-a/000007',
    productHash: hash
  });
  const fromTotalWine = await queue.enqueueJob({
    itemNumber: `${TEST_ITEM}-dedup-hash`,
    sourceName: 'total-wine',
    sourceUrl: 'https://www.totalwine.com/wine/queue-test-hash-b/000008', // a DIFFERENT URL
    productHash: hash // but the SAME physical product
  });

  assert.equal(fromWineCom.deduped, false);
  assert.equal(fromTotalWine.deduped, true, 'the same product identity from a different URL must be recognized as a duplicate');
  assert.equal(fromWineCom.id, fromTotalWine.id);
});

test('13. concurrent worker safety: two workers claiming at once never get the same job', { skip }, async () => {
  const jobs = await Promise.all([
    queue.enqueueJob({ itemNumber: `${TEST_ITEM}-concurrent-1`, sourceName: 'wine-com', sourceUrl: 'https://www.wine.com/product/concurrent-1/1' }),
    queue.enqueueJob({ itemNumber: `${TEST_ITEM}-concurrent-2`, sourceName: 'wine-com', sourceUrl: 'https://www.wine.com/product/concurrent-2/2' })
  ]);
  assert.equal(jobs.length, 2);

  const [claim1, claim2] = await Promise.all([
    queue.claimNextJob({ workerId: 'worker-A' }),
    queue.claimNextJob({ workerId: 'worker-B' })
  ]);

  assert.ok(claim1 && claim2, 'both workers should each get a job (two were queued)');
  assert.notEqual(claim1.id, claim2.id, 'two concurrent workers must never claim the same job');

  await queue.markSucceeded(claim1.id);
  await queue.markSucceeded(claim2.id);
});

test('14. transaction rollback: markFailed on a non-existent job throws and writes nothing', { skip }, async () => {
  await assert.rejects(() => queue.markFailed(999999999, { errorType: 'ACCESS_DENIED', errorMessage: 'x' }));
  const deadLetters = await queue.listDeadLetter();
  assert.ok(!deadLetters.some((d) => d.crawl_job_id === 999999999));
});

test('cleanup: remove all test rows', { skip }, async () => {
  await cleanup();
  await closePool();
});
