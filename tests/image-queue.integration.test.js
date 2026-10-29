const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let imageQueue;
if (isDatabaseConfigured()) {
  imageQueue = require('../src/images/image-queue-repository');
}

const TEST_ITEM = 'WO-IMGQUEUE-TEST-00001';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM image_dead_letter WHERE item_number LIKE $1;', [`${TEST_ITEM}%`]);
  await pool.query('DELETE FROM image_jobs WHERE item_number LIKE $1;', [`${TEST_ITEM}%`]);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('image queue creation', { skip }, async () => {
  const job = await imageQueue.enqueueImageJob({
    itemNumber: TEST_ITEM,
    sourceName: 'wine-com',
    imageUrl: 'https://images.wine.com/example/000001/hero.jpg',
    refererUrl: 'https://www.wine.com/product/example/000001',
    role: 'hero'
  });
  assert.equal(job.status, 'pending');
  assert.equal(job.role, 'hero');
  assert.equal(job.deduped, false);
});

test('duplicate image job submission is deduped, not re-created', { skip }, async () => {
  const url = 'https://images.wine.com/example/000001/hero.jpg';
  const second = await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: 'wine-com', imageUrl: url });
  assert.equal(second.deduped, true);
});

test('claiming image work moves it to processing', { skip }, async () => {
  const claimed = await imageQueue.claimNextImageJob({ workerId: 'img-worker-1' });
  assert.ok(claimed);
  assert.equal(claimed.itemNumber, TEST_ITEM);
  assert.equal(claimed.status, 'processing');
});

test('image fetch success stores ETag/Last-Modified on the job for future conditional requests', { skip }, async () => {
  const pool = getPool();
  const { rows } = await pool.query('SELECT id FROM image_jobs WHERE item_number = $1;', [TEST_ITEM]);
  const jobId = rows[0].id;

  const succeeded = await imageQueue.markImageSucceeded(jobId, { etag: '"xyz"', lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' });
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.etag, '"xyz"');
});

test('failed image fetch + retry: attempts increments and a future retry is scheduled', { skip }, async () => {
  const job = await imageQueue.enqueueImageJob({
    itemNumber: `${TEST_ITEM}-retry`,
    sourceName: 'total-wine',
    imageUrl: 'https://images.totalwine.com/example/label.jpg',
    role: 'label'
  });
  await imageQueue.claimNextImageJob({ workerId: 'img-worker-1' });
  const failed = await imageQueue.markImageFailed(job.id, { errorType: 'TIMEOUT', errorMessage: 'fetch timed out (test)' });
  assert.equal(failed.status, 'retrying');
  assert.equal(failed.attempts, 1);
});

test('image dead-letter: exhausting attempts moves the job to dead_letter with a readable reason', { skip }, async () => {
  const job = await imageQueue.enqueueImageJob({
    itemNumber: `${TEST_ITEM}-deadletter`,
    sourceName: 'vivino',
    imageUrl: 'https://images.vivino.com/example/broken.jpg',
    maxAttempts: 1
  });
  await imageQueue.claimNextImageJob({ workerId: 'img-worker-1' });
  const result = await imageQueue.markImageFailed(job.id, { errorType: 'HTTP_ERROR', errorMessage: 'HTTP 404 (test)' });
  assert.equal(result.status, 'dead_letter');

  const deadLetters = await imageQueue.listImageDeadLetter({ itemNumber: `${TEST_ITEM}-deadletter` });
  assert.equal(deadLetters.length, 1);
  assert.match(deadLetters[0].reason, /Exhausted 1 attempts/);
});

test('a product record succeeds even when its image job fails: the two queues are fully independent', { skip }, async () => {
  const productRepo = require('../src/db/product-repository');
  const product = {
    item_number: `${TEST_ITEM}-independent`,
    item_name: 'Image Failure Independence Test',
    product_name: 'Image Failure Independence Test',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/independent-test/1',
    scraped_at: new Date().toISOString()
  };
  const saved = await productRepo.upsertProduct(product);
  assert.equal(saved.item_number, `${TEST_ITEM}-independent`);

  const imageJob = await imageQueue.enqueueImageJob({
    itemNumber: `${TEST_ITEM}-independent`,
    sourceName: 'wine-com',
    imageUrl: 'https://images.wine.com/independent-test/broken.jpg',
    maxAttempts: 1
  });
  await imageQueue.claimNextImageJob({ workerId: 'img-worker-1' });
  const failedImage = await imageQueue.markImageFailed(imageJob.id, { errorType: 'HTTP_ERROR', errorMessage: '500 (test)' });
  assert.equal(failedImage.status, 'dead_letter');

  // The product row is completely unaffected by the image failure.
  const stillThere = await productRepo.getProductByItemNumber(`${TEST_ITEM}-independent`);
  assert.ok(stillThere);
  assert.equal(stillThere.item_name, 'Image Failure Independence Test');

  await productRepo.deleteProductByItemNumber(`${TEST_ITEM}-independent`);
});

test('cleanup: remove all test rows', { skip }, async () => {
  await cleanup();
  await closePool();
});
