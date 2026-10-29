const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

const ITEM_A = 'WO-BATCH-TEST-A';
const ITEM_B = 'WO-BATCH-TEST-B';

// Queue dedup keys on canonical_url (a UNIQUE column), not item_number —
// see src/queue/crawl-queue-repository.js. Two distinct batch items must
// therefore have distinct source URLs, same as in real product data.
function batchInputs() {
  const base = require('../input/sample-product.json');
  return [
    { ...base, item_number: ITEM_A, source: { ...base.source, url: `${base.source.url}?batchItem=a` } },
    { ...base, item_number: ITEM_B, source: { ...base.source, url: `${base.source.url}?batchItem=b` } }
  ];
}

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM dead_letter_jobs WHERE item_number LIKE $1;', ['WO-BATCH-TEST-%']);
  await pool.query('DELETE FROM crawl_jobs WHERE item_number LIKE $1;', ['WO-BATCH-TEST-%']);
  await pool.query('DELETE FROM product_staging WHERE item_number LIKE $1;', ['WO-BATCH-TEST-%']);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('batch execution: multiple products are enqueued and processed through the existing queue', { skip }, async () => {
  const { runBatch } = require('../src/batch/batch-runner');
  const deterministicProvider = require('../src/ai/providers/deterministic-test-provider');

  const results = await runBatch(batchInputs(), { provider: deterministicProvider });

  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === 'staged'));

  const stagingRepo = require('../src/staging/staging-repository');
  const stagingA = await stagingRepo.listStaging({ itemNumber: ITEM_A });
  const stagingB = await stagingRepo.listStaging({ itemNumber: ITEM_B });
  assert.equal(stagingA.length, 1);
  assert.equal(stagingB.length, 1);
}, { timeout: 120000 });

test('re-running the same batch does not create duplicate queue jobs (reuses existing dedup)', { skip }, async () => {
  const { enqueueBatch } = require('../src/batch/batch-runner');
  await enqueueBatch(batchInputs());
  await enqueueBatch(batchInputs());

  const pool = getPool();
  const countA = await pool.query('SELECT COUNT(*)::int AS n FROM crawl_jobs WHERE item_number = $1;', [ITEM_A]);
  assert.equal(countA.rows[0].n, 1);
});

test('crash/restart resumability: a stale in-progress job is reclaimed and completed by a fresh drain', { skip }, async (t) => {
  const queue = require('../src/queue/crawl-queue-repository');
  const { runBatchFromQueue } = require('../src/batch/batch-runner');

  const pool = getPool();
  await cleanup();

  const job = await queue.enqueueJob({
    itemNumber: ITEM_A,
    sourceName: 'example-source',
    sourceUrl: 'http://127.0.0.1:3000/input/fixtures/example-source-product.html'
  });
  await queue.claimNextJob({ workerId: 'worker-that-crashed' });
  // Simulate a crash: the lock is old, the job was never finished.
  await pool.query("UPDATE crawl_jobs SET locked_at = now() - interval '1 hour' WHERE id = $1;", [job.id]);

  const reclaimed = await queue.reclaimStaleJobs({ leaseMs: 5 * 60 * 1000 });
  assert.ok(reclaimed.some((j) => j.id === job.id));

  const deterministicProvider = require('../src/ai/providers/deterministic-test-provider');
  const results = await runBatchFromQueue([require('../input/sample-product.json')].map((p) => ({ ...p, item_number: ITEM_A })), {
    provider: deterministicProvider
  });
  assert.ok(results.some((r) => r.itemNumber === ITEM_A && r.status === 'staged'));
}, { timeout: 60000 });

test('a claimed job with no matching product input fails clearly rather than guessing', { skip }, async () => {
  const queue = require('../src/queue/crawl-queue-repository');
  const { runBatchFromQueue } = require('../src/batch/batch-runner');

  await queue.enqueueJob({ itemNumber: `${ITEM_A}-nomatch`, sourceName: 'example-source', sourceUrl: 'http://127.0.0.1:3000/input/fixtures/example-source-product.html?nomatch=1' });
  const results = await runBatchFromQueue([], { maxItems: 1 });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].error.type, 'MISSING_PRODUCT_INPUT');

  const pool = getPool();
  await pool.query('DELETE FROM crawl_jobs WHERE item_number = $1;', [`${ITEM_A}-nomatch`]);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
