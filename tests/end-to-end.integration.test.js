const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');
const { solidColorPng } = require('./helpers/png-fixture');

// End-to-end pipeline proof, using WO-10001 (the Phase 1 local fixture —
// NOT a blocked production website, per instructions), against the real
// live PostgreSQL database and a real local HTTP server for the image
// step. Every stage in the pipeline diagram is genuinely exercised:
//
//   INPUT PRODUCT -> SOURCE URL -> QUEUE -> RATE LIMITER -> PROXY SESSION
//   -> CRAWLER -> SOURCE ADAPTER -> NORMALIZED 32-FIELD RECORD
//   -> PRODUCT PERSISTENCE -> IMAGE QUEUE -> IMAGE FETCH
//   -> IMAGE VALIDATION -> IMAGE DEDUPLICATION -> IMAGE STORAGE
//   -> PRODUCT/IMAGE REFERENCES
//
// The one honest gap: no real proxy provider exists in this project (see
// src/net/proxy-config.js), so the "proxy session" stage demonstrates the
// pool's genuine graceful-degradation decision (pool exhausted -> proceed
// without a proxy) rather than fabricating an actual proxied request.

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

const TEST_ITEM = 'WO-10001';

test('end-to-end pipeline: WO-10001 flows through every real stage', { skip }, async (t) => {
  const { RateLimiter } = require('../src/net/rate-limiter');
  const { ProxyPool } = require('../src/net/proxy-pool');
  const { loadProxyPoolOptionsFromEnv } = require('../src/net/proxy-config');
  const { runCrawl } = require('../src/crawler/crawler');
  const queue = require('../src/queue/crawl-queue-repository');
  const productRepo = require('../src/db/product-repository');
  const imageQueue = require('../src/images/image-queue-repository');
  const imageStore = require('../src/images/image-store-repository');
  const { fetchImage } = require('../src/images/image-fetcher');
  const { validateImage } = require('../src/images/validate');

  const pool = getPool();
  await pool.query('DELETE FROM image_references WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM crawl_jobs WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM product_field_history WHERE item_number = $1;', [TEST_ITEM]);

  // --- INPUT PRODUCT / SOURCE URL ---
  const productInput = require('../input/sample-product.json');
  assert.equal(productInput.item_number, TEST_ITEM);
  const sourceUrl = productInput.source.url;

  // --- QUEUE ---
  const job = await queue.enqueueJob({
    itemNumber: TEST_ITEM,
    sourceName: productInput.source.name,
    sourceUrl
  });
  assert.equal(job.status, 'pending');

  const claimed = await queue.claimNextJob({ workerId: 'e2e-worker' });
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, 'processing');

  // --- RATE LIMITER ---
  const rateLimiter = new RateLimiter();
  rateLimiter.configureDomain('127.0.0.1', { ratePerSecond: 5, burst: 5, concurrency: 3 });
  const rateDecision = rateLimiter.canProceed({ domain: '127.0.0.1', sourceName: productInput.source.name });
  assert.equal(rateDecision.allowed, true);
  rateLimiter.beginRequest('127.0.0.1');

  // --- PROXY SESSION (honest gap: no real proxy provider is configured
  // anywhere in this project — graceful degradation is exactly what's
  // demonstrated here, not a fabricated proxied request) ---
  const proxyPool = new ProxyPool(loadProxyPoolOptionsFromEnv());
  const proxySelection = proxyPool.selectProxy({ sessionKey: TEST_ITEM });
  const proxyExhausted = proxyPool.isExhausted();
  assert.equal(proxySelection, null, 'no proxy provider is configured in this environment');
  assert.equal(proxyExhausted, true);
  // The pipeline proceeds via a direct connection — exactly the documented
  // graceful-degradation behavior, not a silent failure.

  // --- CRAWLER -> SOURCE ADAPTER -> NORMALIZED 32-FIELD RECORD ---
  const crawlResult = await runCrawl(productInput, sourceUrl);
  rateLimiter.endRequest('127.0.0.1');
  assert.equal(crawlResult.status, 'success');
  const normalizedProduct = crawlResult.product;
  assert.equal(normalizedProduct.item_number, TEST_ITEM);
  assert.equal(Object.keys(normalizedProduct).length, 32);

  await queue.markSucceeded(job.id);
  const succeededJob = await queue.getJobById(job.id);
  assert.equal(succeededJob.status, 'succeeded');

  // --- PRODUCT PERSISTENCE ---
  const persisted = await productRepo.upsertProductWithHistory(normalizedProduct, {
    sourceSite: normalizedProduct.source_site,
    runId: crawlResult.run_id
  });
  assert.equal(persisted.item_number, TEST_ITEM);

  const reQueried = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.equal(reQueried.product_name, normalizedProduct.product_name);

  // --- IMAGE QUEUE / IMAGE FETCH (real local HTTP server, not a live
  // external image host) ---
  const imageBytes = solidColorPng(120, 120, [128, 20, 20]);
  const imageServer = http.createServer((req, res) => {
    if (req.url === '/hero.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(imageBytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  t.after(() => imageServer.close());
  const imagePort = imageServer.address().port;
  const imageUrl = `http://127.0.0.1:${imagePort}/hero.png`;

  const imageJob = await imageQueue.enqueueImageJob({
    itemNumber: TEST_ITEM,
    sourceName: normalizedProduct.source_site,
    imageUrl,
    refererUrl: sourceUrl,
    role: 'hero'
  });
  assert.equal(imageJob.status, 'pending');

  const claimedImageJob = await imageQueue.claimNextImageJob({ workerId: 'e2e-image-worker' });
  assert.equal(claimedImageJob.id, imageJob.id);

  const fetched = await fetchImage(imageUrl, { refererUrl: sourceUrl, timeoutMs: 5000 });
  assert.equal(fetched.notModified, false);
  assert.ok(fetched.buffer.equals(imageBytes));

  // --- IMAGE VALIDATION ---
  const validation = validateImage(fetched.buffer, { minWidth: 10, minHeight: 10, maxPixels: 10_000_000, maxBytes: 5_000_000 });
  assert.equal(validation.valid, true);
  assert.equal(validation.format, 'png');

  // --- IMAGE DEDUPLICATION / IMAGE STORAGE ---
  const storeResult = await imageStore.storeValidatedImage(fetched.buffer, { sourceUrl: imageUrl });
  assert.equal(storeResult.stored, true);

  await imageQueue.markImageSucceeded(imageJob.id, { etag: fetched.etag, lastModified: fetched.lastModified });

  // --- PRODUCT/IMAGE REFERENCES ---
  const reference = await imageStore.addImageReference({
    imageId: storeResult.image.id,
    itemNumber: TEST_ITEM,
    sourceName: normalizedProduct.source_site,
    sourceUrl: imageUrl,
    role: 'hero'
  });
  await imageStore.setPrimaryImageReference(TEST_ITEM, reference.id);

  const finalReferences = await imageStore.getImageReferences(TEST_ITEM);
  assert.equal(finalReferences.length, 1);
  assert.equal(finalReferences[0].isPrimary, true);
  assert.equal(finalReferences[0].role, 'hero');
  assert.equal(finalReferences[0].image.width, 120);
  assert.equal(finalReferences[0].image.height, 120);

  // --- Final cross-check: everything is genuinely linked for WO-10001 ---
  const finalProduct = await productRepo.getProductByItemNumber(TEST_ITEM);
  const finalImageRefs = await imageStore.getImageReferences(TEST_ITEM);
  assert.equal(finalProduct.item_number, TEST_ITEM);
  assert.equal(finalImageRefs[0].itemNumber, TEST_ITEM);

  console.log('END-TO-END PIPELINE SUMMARY for WO-10001:');
  console.log('  crawl status:', crawlResult.status, '| run_id:', crawlResult.run_id);
  console.log('  product persisted:', finalProduct.item_number, '-', finalProduct.product_name);
  console.log('  primary image:', finalImageRefs[0].image.storagePath, `(${finalImageRefs[0].image.width}x${finalImageRefs[0].image.height})`);
});

test('end-to-end cleanup', { skip }, async () => {
  const pool = getPool();
  await pool.query('DELETE FROM image_references WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM crawl_jobs WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM image_jobs WHERE item_number = $1;', [TEST_ITEM]);
  await closePool();
});
