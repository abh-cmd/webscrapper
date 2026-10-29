const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let masterData;
let stagingRepo;
let productRepo;
if (isDatabaseConfigured()) {
  masterData = require('../src/master-data/master-data-service');
  stagingRepo = require('../src/staging/staging-repository');
  productRepo = require('../src/db/product-repository');
}

const TEST_ITEM = 'WO-MASTERDATA-TEST-00001';
const TEST_PRODUCER_NAME = `Test Producer Winery ${Date.now()}`;

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM product_rater_links WHERE item_number LIKE $1;', [`${TEST_ITEM}%`]);
  await pool.query('DELETE FROM product_staging WHERE item_number LIKE $1;', [`${TEST_ITEM}%`]);
  // Products must be deleted before their referenced master records (FK).
  await productRepo?.deleteProductByItemNumber(TEST_ITEM);
  await productRepo?.deleteProductByItemNumber(`${TEST_ITEM}-b`);
  await pool.query('DELETE FROM master_producers WHERE normalized_name = $1;', [TEST_PRODUCER_NAME.toLowerCase()]);
  await pool.query('DELETE FROM master_professional_raters WHERE name LIKE $1;', ['Test Rater%']);
}

async function getMasterIdColumns(itemNumber) {
  const pool = getPool();
  const result = await pool.query(
    'SELECT producer_master_id, region_master_id, varietal_master_id FROM products WHERE item_number = $1;',
    [itemNumber]
  );
  return result.rows[0] || null;
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('get-or-create: a new producer name creates a new master record', { skip }, async () => {
  const id = await masterData.getOrCreateMaster('producer', TEST_PRODUCER_NAME);
  assert.ok(id, 'expected a truthy master id (BIGSERIAL, returned as a string by node-postgres)');
});

test('get-or-create: the same name (exact) reuses the existing master id', { skip }, async () => {
  const first = await masterData.getOrCreateMaster('producer', TEST_PRODUCER_NAME);
  const second = await masterData.getOrCreateMaster('producer', TEST_PRODUCER_NAME);
  assert.equal(String(first), String(second));
});

test('get-or-create: case-insensitive / normalized matching reuses the same master id', { skip }, async () => {
  const original = await masterData.getOrCreateMaster('producer', TEST_PRODUCER_NAME);
  const upperCase = await masterData.getOrCreateMaster('producer', TEST_PRODUCER_NAME.toUpperCase());
  const extraSpaces = await masterData.getOrCreateMaster('producer', `  ${TEST_PRODUCER_NAME}   `);
  assert.equal(String(original), String(upperCase));
  assert.equal(String(original), String(extraSpaces));
});

test('get-or-create: duplicate master records are never created for the same normalized name', { skip }, async () => {
  const pool = getPool();
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM master_producers WHERE normalized_name = $1;', [TEST_PRODUCER_NAME.toLowerCase()]);
  assert.equal(result.rows[0].n, 1);
});

test('get-or-create: an empty/null name returns null rather than creating a junk master record', { skip }, async () => {
  assert.equal(await masterData.getOrCreateMaster('producer', null), null);
  assert.equal(await masterData.getOrCreateMaster('producer', '   '), null);
});

test('get-or-create: an unknown master kind throws clearly', { skip }, async () => {
  await assert.rejects(() => masterData.getOrCreateMaster('not-a-real-kind', 'x'));
});

test('master mapping only happens via approved staging — never before approval', { skip }, async () => {
  const staging = await stagingRepo.stageProduct({
    itemNumber: TEST_ITEM,
    runId: 'run_test_1',
    sourceSite: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/masterdata-test/1',
    rawExtracted: { item_number: TEST_ITEM },
    normalized: {
      item_number: TEST_ITEM,
      item_name: 'Master Data Test Wine',
      producer: TEST_PRODUCER_NAME,
      region: 'Test Region Valley',
      varietal: 'Test Varietal Blend',
      professional_ratings: [{ rater: 'Test Rater One', rating: '90', description: 'Solid.' }],
      source_site: 'wine-com',
      source_url: 'https://www.wine.com/product/masterdata-test/1',
      scraped_at: new Date().toISOString()
    },
    aiMetadata: null
  });

  // Before approval: no master link on the product (it isn't in `products` at all yet).
  const notYetProduct = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.equal(notYetProduct, null);

  const { product, masterData: mapping } = await stagingRepo.approveStaging(staging.id, { reviewer: 'masterdata-test@example.com' });

  assert.ok(mapping.producerId);
  assert.ok(mapping.regionId);
  assert.ok(mapping.varietalId);
  assert.equal(mapping.raterLinks.length, 1);
  assert.equal(mapping.raterLinks[0].raterName, 'Test Rater One');

  // product (from upsertProduct) intentionally only carries the 32-field
  // schema shape — master-id columns are additive/DB-only, so verify them
  // with a raw column read instead of expecting them on that object.
  const masterIdColumns = await getMasterIdColumns(TEST_ITEM);
  assert.equal(String(masterIdColumns.producer_master_id), String(mapping.producerId));
  assert.equal(String(masterIdColumns.region_master_id), String(mapping.regionId));
  assert.equal(String(masterIdColumns.varietal_master_id), String(mapping.varietalId));

  const pool = getPool();
  const linkRow = await pool.query('SELECT * FROM product_rater_links WHERE item_number = $1;', [TEST_ITEM]);
  assert.equal(linkRow.rows.length, 1);
  assert.equal(linkRow.rows[0].rater_name, 'Test Rater One');
});

test('a second product from the same producer reuses the existing master id (no duplicate producer record)', { skip }, async () => {
  const staging = await stagingRepo.stageProduct({
    itemNumber: `${TEST_ITEM}-b`,
    runId: 'run_test_2',
    sourceSite: 'total-wine',
    sourceUrl: 'https://www.totalwine.com/wine/masterdata-test/2',
    rawExtracted: { item_number: `${TEST_ITEM}-b` },
    normalized: {
      item_number: `${TEST_ITEM}-b`,
      item_name: 'Second Master Data Test Wine',
      producer: TEST_PRODUCER_NAME.toLowerCase(), // deliberately different casing
      source_site: 'total-wine',
      source_url: 'https://www.totalwine.com/wine/masterdata-test/2',
      scraped_at: new Date().toISOString()
    },
    aiMetadata: null
  });

  const { product, masterData: mapping } = await stagingRepo.approveStaging(staging.id, { reviewer: 'masterdata-test@example.com' });

  const pool = getPool();
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM master_producers WHERE normalized_name = $1;', [TEST_PRODUCER_NAME.toLowerCase()]);
  assert.equal(count.rows[0].n, 1, 'still exactly one producer master record, reused across both products');

  const masterIdColumns = await getMasterIdColumns(product.item_number);
  assert.equal(String(masterIdColumns.producer_master_id), String(mapping.producerId));
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
