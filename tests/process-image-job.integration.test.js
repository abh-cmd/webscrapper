const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');
const { solidColorPng } = require('./helpers/png-fixture');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let processImageJob;
let imageQueue;
let PlaceholderDetector;
if (isDatabaseConfigured()) {
  ({ processImageJob } = require('../src/images/process-image-job'));
  imageQueue = require('../src/images/image-queue-repository');
  ({ PlaceholderDetector } = require('../src/images/placeholder-detector'));
}

const TEST_ITEM = 'WO-PROCESSIMG-TEST-00001';
const REAL_IMAGE = solidColorPng(80, 80, [30, 60, 90]);
const PLACEHOLDER_IMAGE = solidColorPng(10, 10, [255, 255, 255]);

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/real.png') {
      res.writeHead(200, { 'Content-Type': 'image/png', ETag: '"real-etag"' });
      res.end(REAL_IMAGE);
      return;
    }
    if (req.url === '/placeholder.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(PLACEHOLDER_IMAGE);
      return;
    }
    if (req.url === '/broken.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      return;
    }
    if (req.url === '/unchanged.png') {
      if (req.headers['if-none-match'] === '"stable-etag"') {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', ETag: '"stable-etag"' });
      res.end(REAL_IMAGE);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM image_references WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM image_dead_letter WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM image_jobs WHERE item_number = $1;', [TEST_ITEM]);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('a real image is fetched, validated, stored, and referenced with its real role', { skip }, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const port = server.address().port;

  const job = await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: 'wine-com', imageUrl: `http://127.0.0.1:${port}/real.png`, role: 'hero' });
  await imageQueue.claimNextImageJob({ workerId: 'test-worker' });

  const result = await processImageJob(job);
  assert.equal(result.status, 'stored');
  assert.equal(result.reference.role, 'hero');
  assert.equal(result.image.width, 80);

  const finishedJob = await imageQueue.getImageJobById(job.id);
  assert.equal(finishedJob.status, 'succeeded');
});

test('a placeholder image (per a registered detector) is stored with role=placeholder, never a real role', { skip }, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const port = server.address().port;

  const { computeContentHash } = require('../src/images/content-hash');
  const detector = new PlaceholderDetector();
  detector.registerContentHash('wine-com', computeContentHash(PLACEHOLDER_IMAGE));

  const job = await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: 'wine-com', imageUrl: `http://127.0.0.1:${port}/placeholder.png`, role: 'hero' });
  await imageQueue.claimNextImageJob({ workerId: 'test-worker' });

  const result = await processImageJob(job, { placeholderDetector: detector });
  assert.equal(result.status, 'placeholder');
  assert.equal(result.reference.role, 'placeholder', 'must never be stored under the requested "hero" role');
});

test('an invalid image (SVG) is rejected and the job fails with a readable reason', { skip }, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const port = server.address().port;

  const job = await imageQueue.enqueueImageJob({ itemNumber: TEST_ITEM, sourceName: 'wine-com', imageUrl: `http://127.0.0.1:${port}/broken.svg`, role: 'label', maxAttempts: 1 });
  await imageQueue.claimNextImageJob({ workerId: 'test-worker' });

  const result = await processImageJob(job);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'SVG_REJECTED');

  const finishedJob = await imageQueue.getImageJobById(job.id);
  assert.equal(finishedJob.status, 'dead_letter');
  assert.match(finishedJob.lastErrorType, /SVG_REJECTED/);
});

test('an unchanged image (matching ETag) is not re-downloaded or re-stored', { skip }, async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const port = server.address().port;

  const job1 = await imageQueue.enqueueImageJob({ itemNumber: `${TEST_ITEM}-unchanged`, sourceName: 'wine-com', imageUrl: `http://127.0.0.1:${port}/unchanged.png`, role: 'hero' });
  await imageQueue.claimNextImageJob({ workerId: 'test-worker' });
  const first = await processImageJob(job1);
  assert.equal(first.status, 'stored');

  const jobAfterFirst = await imageQueue.getImageJobById(job1.id);
  assert.equal(jobAfterFirst.etag, '"stable-etag"');

  const second = await processImageJob(jobAfterFirst);
  assert.equal(second.status, 'unchanged');

  const pool = getPool();
  await pool.query('DELETE FROM image_references WHERE item_number = $1;', [`${TEST_ITEM}-unchanged`]);
  await pool.query('DELETE FROM image_jobs WHERE item_number = $1;', [`${TEST_ITEM}-unchanged`]);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
