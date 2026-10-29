const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let stagingRepo;
let productRepo;
if (isDatabaseConfigured()) {
  stagingRepo = require('../src/staging/staging-repository');
  productRepo = require('../src/db/product-repository');
}

const TEST_ITEM = 'WO-STAGING-TEST-00001';

function sampleNormalized(overrides = {}) {
  return {
    item_number: TEST_ITEM,
    item_name: 'Staging Test Wine',
    product_name: 'Staging Test Wine',
    price: '19.99',
    currency: 'USD',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/staging-test/1',
    scraped_at: new Date().toISOString(),
    ...overrides
  };
}

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM product_staging WHERE item_number = $1;', [TEST_ITEM]);
  await productRepo?.deleteProductByItemNumber(TEST_ITEM);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('staged data is NOT written to products — the review-before-production requirement', { skip }, async () => {
  const staging = await stagingRepo.stageProduct({
    itemNumber: TEST_ITEM,
    runId: 'run_test_1',
    sourceSite: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/staging-test/1',
    rawExtracted: sampleNormalized(),
    normalized: sampleNormalized(),
    aiMetadata: { provider: 'deterministic-test', paraphrasedFields: [] }
  });

  assert.equal(staging.status, 'pending_review');

  const inProduction = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.equal(inProduction, null, 'a pending-review staging record must never appear in products');
});

test('approval promotes the staged record into products, in one transaction', { skip }, async () => {
  const [pending] = await stagingRepo.listStaging({ itemNumber: TEST_ITEM, status: 'pending_review' });
  assert.ok(pending);

  const { staging, product } = await stagingRepo.approveStaging(pending.id, { reviewer: 'test-reviewer@example.com' });
  assert.equal(staging.status, 'approved');
  assert.equal(staging.reviewer, 'test-reviewer@example.com');
  assert.ok(staging.promotedAt);
  assert.equal(product.item_number, TEST_ITEM);

  const inProduction = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.ok(inProduction, 'an approved staging record must be promoted to products');
  assert.equal(inProduction.product_name, 'Staging Test Wine');
});

test('a staging record cannot be approved twice', { skip }, async () => {
  const [approved] = await stagingRepo.listStaging({ itemNumber: TEST_ITEM, status: 'approved' });
  assert.ok(approved);
  await assert.rejects(() => stagingRepo.approveStaging(approved.id, { reviewer: 'someone-else@example.com' }));
});

test('rejection marks the staging record rejected and never touches products', { skip }, async () => {
  await productRepo.deleteProductByItemNumber(TEST_ITEM);

  const staging = await stagingRepo.stageProduct({
    itemNumber: TEST_ITEM,
    runId: 'run_test_2',
    sourceSite: 'total-wine',
    sourceUrl: 'https://www.totalwine.com/wine/staging-test/2',
    rawExtracted: sampleNormalized({ source_site: 'total-wine' }),
    normalized: sampleNormalized({ source_site: 'total-wine' }),
    aiMetadata: null
  });

  const rejected = await stagingRepo.rejectStaging(staging.id, { reviewer: 'test-reviewer@example.com', reason: 'Price looks wrong compared to source page (test).' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectionReason, 'Price looks wrong compared to source page (test).');

  const inProduction = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.equal(inProduction, null, 'a rejected staging record must never reach products');
});

test('rejection requires a reviewer and a reason (auditability)', { skip }, async () => {
  const staging = await stagingRepo.stageProduct({
    itemNumber: `${TEST_ITEM}-audit`,
    runId: 'run_test_3',
    sourceSite: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/staging-test/3',
    rawExtracted: sampleNormalized({ item_number: `${TEST_ITEM}-audit` }),
    normalized: sampleNormalized({ item_number: `${TEST_ITEM}-audit` }),
    aiMetadata: null
  });

  await assert.rejects(() => stagingRepo.rejectStaging(staging.id, { reviewer: null, reason: 'x' }));
  await assert.rejects(() => stagingRepo.rejectStaging(staging.id, { reviewer: 'x', reason: null }));

  const pool = getPool();
  await pool.query('DELETE FROM product_staging WHERE item_number = $1;', [`${TEST_ITEM}-audit`]);
});

test('original extracted data (pre-AI-enrichment) is preserved alongside the AI-enriched version', { skip }, async () => {
  const original = sampleNormalized({
    item_number: `${TEST_ITEM}-preserve`,
    product_description: 'Notes of black cherry pair well with a delicious finish.'
  });
  const enriched = { ...original, product_description: 'Hints of black cherry is a great match for an enjoyable aftertaste.' };

  const staging = await stagingRepo.stageProduct({
    itemNumber: `${TEST_ITEM}-preserve`,
    runId: 'run_test_4',
    sourceSite: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/staging-test/4',
    rawExtracted: original,
    normalized: enriched,
    aiMetadata: { provider: 'deterministic-test', paraphrasedFields: ['product_description'], original: { product_description: original.product_description, food_pairing: null } }
  });

  const fetched = await stagingRepo.getStagingById(staging.id);
  assert.equal(fetched.rawExtracted.product_description, 'Notes of black cherry pair well with a delicious finish.');
  assert.equal(fetched.normalized.product_description, 'Hints of black cherry is a great match for an enjoyable aftertaste.');
  assert.notEqual(fetched.rawExtracted.product_description, fetched.normalized.product_description);

  const pool = getPool();
  await pool.query('DELETE FROM product_staging WHERE item_number = $1;', [`${TEST_ITEM}-preserve`]);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
