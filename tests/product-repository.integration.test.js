const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, closePool } = require('../src/db/connection');

// Live PostgreSQL integration tests. These require a real, reachable
// database at DATABASE_URL with the schema already applied (`npm run
// db:migrate`). This environment has neither Docker nor a local PostgreSQL
// installation available, so DATABASE_URL is unset here and every test in
// this file is SKIPPED (not failed) — per the Phase 9 instruction not to
// make the unit test suite depend on a developer's personal PostgreSQL
// installation. `tests/product-repository-mapping.test.js` covers the
// repository's actual row<->record logic offline, without a live database.
//
// To actually run these tests:
//   1. Have a reachable PostgreSQL instance.
//   2. export DATABASE_URL=postgres://user:pass@host:5432/dbname
//   3. npm run db:migrate
//   4. npm test  (or: node --test tests/product-repository.integration.test.js)

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — no PostgreSQL instance available in this environment; see file header.';

let repo;
if (isDatabaseConfigured()) {
  repo = require('../src/db/product-repository');
}

function sampleProduct(overrides = {}) {
  return {
    item_number: 'WO-TEST-00001',
    item_name: 'Integration Test Wine',
    product_name: 'Integration Test Wine',
    brand: 'Test Brand',
    producer: null,
    category: 'Red Wine',
    subcategory: null,
    size: '750ml',
    vintage: '2021',
    upc: null,
    sku: null,
    price: '19.99',
    currency: 'USD',
    availability_status: 'In stock',
    product_description: 'A test wine used only by the integration suite.',
    food_pairing: null,
    color: null,
    aroma: null,
    taste: null,
    seasons: null,
    occasions: null,
    comments: null,
    varietal: 'Cabernet Sauvignon',
    region: 'Napa Valley',
    abv: '13.5%',
    winemaker_notes: null,
    product_highlights: null,
    professional_ratings: [],
    image_urls: ['https://example.com/test-image.jpg'],
    source_site: 'wine-com',
    source_url: 'https://www.wine.com/product/test/000000',
    scraped_at: new Date().toISOString(),
    ...overrides
  };
}

test('1. database connection/configuration', { skip }, async () => {
  const { getPool } = require('../src/db/connection');
  const pool = getPool();
  const result = await pool.query('SELECT 1 AS ok;');
  assert.equal(result.rows[0].ok, 1);
});

test('2. schema initialization/migration is idempotent', { skip }, async () => {
  const { migrate } = require('../src/db/migrate');
  await migrate();
  await migrate();
});

test('3. insert product', { skip }, async () => {
  await repo.deleteProductByItemNumber('WO-TEST-00001');
  const inserted = await repo.upsertProduct(sampleProduct());
  assert.equal(inserted.item_number, 'WO-TEST-00001');
  assert.equal(inserted.product_name, 'Integration Test Wine');
});

test('4. read product', { skip }, async () => {
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.ok(found);
  assert.equal(found.item_number, 'WO-TEST-00001');
});

test('5. update product (via upsert)', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ price: '24.99' }));
  const updated = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(updated.price, '24.99');
});

test('6. upsert same item_number', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ region: 'Sonoma' }));
  await repo.upsertProduct(sampleProduct({ region: 'Sonoma' }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(found.region, 'Sonoma');
});

test('7. no duplicate canonical product row is created by repeated upserts', { skip }, async () => {
  // Scoped to this test's own item_number, not the whole table: other
  // integration test files (queue/image tests) also insert/delete their
  // own rows in `products` concurrently (node --test runs files in
  // parallel by default), so a whole-table COUNT(*) is not a safe
  // isolation boundary here — what this test actually needs to prove is
  // that upserting the SAME item twice never yields more than one row
  // for THAT item, which a scoped count verifies precisely.
  const { getPool } = require('../src/db/connection');
  const pool = getPool();

  await repo.upsertProduct(sampleProduct());
  await repo.upsertProduct(sampleProduct());
  const result = await pool.query('SELECT COUNT(*)::int AS n FROM products WHERE item_number = $1;', ['WO-TEST-00001']);
  assert.equal(result.rows[0].n, 1);
});

test('8. null scalar persistence', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ winemaker_notes: null, food_pairing: null }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(found.winemaker_notes, null);
  assert.equal(found.food_pairing, null);
  assert.notEqual(found.winemaker_notes, 'N/A');
});

test('9. empty array persistence', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ professional_ratings: [] }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.deepEqual(found.professional_ratings, []);
});

test('10. image URL persistence', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ image_urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.deepEqual(found.image_urls, ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
});

test('11. professional rating persistence', { skip }, async () => {
  const ratings = [{ rater: 'Wine Spectator', rating: '92', description: 'Excellent structure.' }];
  await repo.upsertProduct(sampleProduct({ professional_ratings: ratings }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.deepEqual(found.professional_ratings, ratings);
});

test('12. source metadata persistence', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ source_site: 'total-wine', source_url: 'https://www.totalwine.com/x' }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(found.source_site, 'total-wine');
  assert.equal(found.source_url, 'https://www.totalwine.com/x');
});

test('13. timestamp persistence', { skip }, async () => {
  const scrapedAt = '2026-08-27T12:00:00.000Z';
  await repo.upsertProduct(sampleProduct({ scraped_at: scrapedAt }));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(found.scraped_at, scrapedAt);
});

test('14. invalid data is rejected (non-numeric price violates the NUMERIC column type)', { skip }, async () => {
  await assert.rejects(() => repo.upsertProduct(sampleProduct({ price: 'not-a-price' })));
});

test('15. transaction/error handling: a rejected query does not corrupt the existing row', { skip }, async () => {
  await repo.upsertProduct(sampleProduct({ price: '19.99' }));
  await assert.rejects(() => repo.upsertProduct(sampleProduct({ price: 'garbage' })));
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(found.price, '19.99');
});

test('cleanup: remove test row', { skip }, async () => {
  await repo.deleteProductByItemNumber('WO-TEST-00001');
  const found = await repo.getProductByItemNumber('WO-TEST-00001');
  assert.equal(found, null);
  await closePool();
});
