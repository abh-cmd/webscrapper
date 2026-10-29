const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let snapshots;
let history;
let productRepo;
if (isDatabaseConfigured()) {
  snapshots = require('../src/snapshots/snapshot-repository');
  history = require('../src/history/field-history-repository');
  productRepo = require('../src/db/product-repository');
}

const TEST_ITEM = 'WO-HISTORY-TEST-00001';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM raw_snapshots WHERE item_number = $1;', [TEST_ITEM]);
  await pool.query('DELETE FROM product_field_history WHERE item_number = $1;', [TEST_ITEM]);
  await productRepo?.deleteProductByItemNumber(TEST_ITEM);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('15. raw snapshot persistence', { skip }, async () => {
  const saved = await snapshots.saveSnapshot({
    itemNumber: TEST_ITEM,
    sourceName: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/history-test/000001',
    runId: 'run_test_1',
    rawContent: '<html><body>Snapshot 1</body></html>'
  });
  assert.equal(saved.itemNumber, TEST_ITEM);
  assert.equal(saved.rawContent, '<html><body>Snapshot 1</body></html>');
});

test('16. raw snapshot retrieval: latest snapshot and full history are both retrievable', { skip }, async () => {
  await snapshots.saveSnapshot({
    itemNumber: TEST_ITEM,
    sourceName: 'wine-com',
    sourceUrl: 'https://www.wine.com/product/history-test/000001',
    runId: 'run_test_2',
    rawContent: '<html><body>Snapshot 2 (newer)</body></html>'
  });

  const latest = await snapshots.getLatestSnapshot(TEST_ITEM);
  assert.equal(latest.rawContent, '<html><body>Snapshot 2 (newer)</body></html>');

  const all = await snapshots.listSnapshots(TEST_ITEM);
  assert.equal(all.length, 2);
});

test('17. field-level history: a first-ever crawl (no previous record) logs every populated field as a change', { skip }, async () => {
  const product = {
    item_number: TEST_ITEM,
    item_name: 'History Test Wine',
    product_name: 'History Test Wine',
    price: '19.99',
    currency: 'USD',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/history-test/000001',
    scraped_at: new Date().toISOString()
  };
  await productRepo.upsertProductWithHistory(product, { sourceSite: 'wine-com', runId: 'run_test_1' });

  const priceHistory = await history.getFieldHistory(TEST_ITEM, 'price');
  assert.equal(priceHistory.length, 1);
  assert.equal(priceHistory[0].old_value, null);
  assert.equal(priceHistory[0].new_value, '19.99');
});

test('18. price-change history: a second crawl with a different price logs exactly one new history row', { skip }, async () => {
  const updated = {
    item_number: TEST_ITEM,
    item_name: 'History Test Wine',
    product_name: 'History Test Wine',
    price: '24.99',
    currency: 'USD',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/history-test/000001',
    scraped_at: new Date().toISOString()
  };
  await productRepo.upsertProductWithHistory(updated, { sourceSite: 'wine-com', runId: 'run_test_2' });

  const priceHistory = await history.getFieldHistory(TEST_ITEM, 'price');
  assert.equal(priceHistory.length, 2);
  assert.equal(priceHistory[1].old_value, '19.99');
  assert.equal(priceHistory[1].new_value, '24.99');
  assert.equal(priceHistory[1].run_id, 'run_test_2');
});

test('18b. an unchanged field between crawls does not generate a spurious history row', { skip }, async () => {
  const currencyHistory = await history.getFieldHistory(TEST_ITEM, 'currency');
  // currency was "USD" on both crawls -> only the very first insertion logs it (old=null -> new="USD"), never a second row.
  assert.equal(currencyHistory.length, 1);
});

test('18c. re-persisting with no changes at all logs nothing new', { skip }, async () => {
  const before = await history.getFieldHistory(TEST_ITEM, 'price');
  const same = {
    item_number: TEST_ITEM,
    item_name: 'History Test Wine',
    product_name: 'History Test Wine',
    price: '24.99',
    currency: 'USD',
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/history-test/000001',
    scraped_at: new Date().toISOString()
  };
  await productRepo.upsertProductWithHistory(same, { sourceSite: 'wine-com', runId: 'run_test_3' });
  const after = await history.getFieldHistory(TEST_ITEM, 'price');
  assert.equal(after.length, before.length);
});

test('19. the canonical product row is never destroyed by history tracking', { skip }, async () => {
  const current = await productRepo.getProductByItemNumber(TEST_ITEM);
  assert.ok(current);
  assert.equal(current.price, '24.99');
});

test('cleanup: remove all test rows', { skip }, async () => {
  await cleanup();
  await closePool();
});
