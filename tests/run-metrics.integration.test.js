const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let metrics;
let queue;
let imageQueue;
if (isDatabaseConfigured()) {
  metrics = require('../src/observability/run-metrics');
  queue = require('../src/queue/crawl-queue-repository');
  imageQueue = require('../src/images/image-queue-repository');
}

const TEST_SOURCE = 'wo-metrics-test-source';
const TEST_ITEM = 'WO-METRICS-TEST-00001';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM dead_letter_jobs WHERE source_name = $1;', [TEST_SOURCE]);
  await pool.query('DELETE FROM crawl_jobs WHERE source_name = $1;', [TEST_SOURCE]);
  await pool.query('DELETE FROM image_dead_letter WHERE source_name = $1;', [TEST_SOURCE]);
  await pool.query('DELETE FROM image_jobs WHERE source_name = $1;', [TEST_SOURCE]);
  await pool.query('DELETE FROM image_references WHERE source_name = $1;', [TEST_SOURCE]);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('page metrics: attempted/succeeded/blocked counts reflect real crawl_jobs rows', { skip }, async () => {
  await queue.enqueueJob({ itemNumber: `${TEST_ITEM}-1`, sourceName: TEST_SOURCE, sourceUrl: 'https://example.invalid/1' });
  const job2 = await queue.enqueueJob({ itemNumber: `${TEST_ITEM}-2`, sourceName: TEST_SOURCE, sourceUrl: 'https://example.invalid/2' });
  const job3 = await queue.enqueueJob({ itemNumber: `${TEST_ITEM}-3`, sourceName: TEST_SOURCE, sourceUrl: 'https://example.invalid/3', maxAttempts: 1 });

  await queue.claimNextJob({ workerId: 'w' });
  await queue.markSucceeded(job2.id);

  await queue.claimNextJob({ workerId: 'w' });
  await queue.markFailed(job3.id, { errorType: 'ACCESS_DENIED', errorMessage: 'blocked (test)' });

  const result = await metrics.computePageMetrics(TEST_SOURCE);
  assert.equal(result.pagesAttempted, 3);
  assert.equal(result.pagesSucceeded, 1);
  assert.equal(result.pagesBlocked, 1);
  assert.equal(result.pagesDeadLettered, 1);
  assert.ok(result.blockRate > 0);
});

test('image metrics: queued/downloaded/rejected-by-reason and placeholder rate reflect real image_jobs/image_references rows', { skip }, async () => {
  const job1 = await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: TEST_SOURCE, imageUrl: 'https://example.invalid/img1.png', role: 'hero' });
  const job2 = await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: TEST_SOURCE, imageUrl: 'https://example.invalid/img2.svg', role: 'hero', maxAttempts: 1 });
  await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: TEST_SOURCE, imageUrl: 'https://example.invalid/img3.png', role: 'hero' });

  await imageQueue.claimNextImageJob({ workerId: 'w' });
  await imageQueue.markImageSucceeded(job1.id);

  await imageQueue.claimNextImageJob({ workerId: 'w' });
  await imageQueue.markImageFailed(job2.id, { errorType: 'VALIDATION_SVG_REJECTED', errorMessage: 'svg (test)' });

  const pool = getPool();
  await pool.query(
    `INSERT INTO images (content_hash, format, width, height, byte_size, storage_path)
     VALUES ('wo-metrics-test-hash', 'png', 10, 10, 100, '/tmp/wo-metrics-test.png')
     ON CONFLICT (content_hash) DO NOTHING;`
  );
  const imageRow = await pool.query("SELECT id FROM images WHERE content_hash = 'wo-metrics-test-hash';");
  await pool.query(
    `INSERT INTO image_references (image_id, item_number, source_name, source_url, role)
     VALUES ($1, $2, $3, 'https://example.invalid/placeholder.png', 'placeholder');`,
    [imageRow.rows[0].id, TEST_ITEM, TEST_SOURCE]
  );

  const result = await metrics.computeImageMetrics(TEST_SOURCE);
  assert.equal(result.imagesQueued, 3);
  assert.equal(result.imagesDownloaded, 1);
  assert.equal(result.imagesDeadLettered, 1);
  assert.equal(result.imagesRejectedByReason.VALIDATION_SVG_REJECTED, 1);
  assert.equal(result.placeholderCount, 1);
  assert.ok(result.placeholderRate > 0);

  await pool.query('DELETE FROM image_references WHERE source_name = $1;', [TEST_SOURCE]);
  await pool.query("DELETE FROM images WHERE content_hash = 'wo-metrics-test-hash';");
});

test('computeRunMetrics combines page and image metrics for a source', { skip }, async () => {
  const combined = await metrics.computeRunMetrics(TEST_SOURCE);
  assert.ok('pagesAttempted' in combined);
  assert.ok('imagesQueued' in combined);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
