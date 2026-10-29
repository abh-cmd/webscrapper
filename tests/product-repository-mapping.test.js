const test = require('node:test');
const assert = require('node:assert/strict');

const { COLUMNS, toRow, fromRow } = require('../src/db/product-repository');
const { createEmptyProductRecord } = require('../src/schema/product-schema');

// Pure row<->record mapping tests. No database connection is used or
// required — these run fully offline and always execute, unlike the gated
// live integration tests in product-repository.integration.test.js.

test('COLUMNS matches the 32-field product schema exactly, in order', () => {
  assert.deepEqual(COLUMNS, Object.keys(createEmptyProductRecord()));
  assert.equal(COLUMNS.length, 32);
});

test('toRow: null scalar fields stay null (not fabricated placeholder strings)', () => {
  const row = toRow({ item_number: 'WO-1', item_name: 'Test' });
  const abvIndex = COLUMNS.indexOf('abv');
  const regionIndex = COLUMNS.indexOf('region');
  assert.equal(row[abvIndex], null);
  assert.equal(row[regionIndex], null);
  assert.notEqual(row[abvIndex], 'N/A');
  assert.notEqual(row[abvIndex], 'unknown');
});

test('toRow: missing arrays serialize as an empty JSON array, not null', () => {
  const row = toRow({ item_number: 'WO-1', item_name: 'Test' });
  const imagesIndex = COLUMNS.indexOf('image_urls');
  const ratingsIndex = COLUMNS.indexOf('professional_ratings');
  assert.equal(row[imagesIndex], '[]');
  assert.equal(row[ratingsIndex], '[]');
});

test('toRow: populated arrays serialize as JSON', () => {
  const row = toRow({
    item_number: 'WO-1',
    item_name: 'Test',
    image_urls: ['https://example.com/a.jpg'],
    professional_ratings: [{ rater: 'Wine Spectator', rating: '92', description: 'Excellent.' }]
  });
  const imagesIndex = COLUMNS.indexOf('image_urls');
  const ratingsIndex = COLUMNS.indexOf('professional_ratings');
  assert.deepEqual(JSON.parse(row[imagesIndex]), ['https://example.com/a.jpg']);
  assert.deepEqual(JSON.parse(row[ratingsIndex]), [{ rater: 'Wine Spectator', rating: '92', description: 'Excellent.' }]);
});

test('toRow: vintage stays a plain string ("NV" is valid, not coerced to a number)', () => {
  const row = toRow({ item_number: 'WO-1', item_name: 'Test', vintage: 'NV' });
  assert.equal(row[COLUMNS.indexOf('vintage')], 'NV');
});

test('toRow: price stays a plain numeric-looking string, unmodified', () => {
  const row = toRow({ item_number: 'WO-1', item_name: 'Test', price: '39.99' });
  assert.equal(row[COLUMNS.indexOf('price')], '39.99');
});

test('fromRow: null row returns null', () => {
  assert.equal(fromRow(null), null);
  assert.equal(fromRow(undefined), null);
});

test('fromRow: JSONB arrays already parsed by pg pass through unchanged', () => {
  const row = {
    item_number: 'WO-1',
    item_name: 'Test',
    image_urls: ['https://example.com/a.jpg'],
    professional_ratings: [{ rater: 'X', rating: '90', description: null }]
  };
  const record = fromRow(row);
  assert.deepEqual(record.image_urls, ['https://example.com/a.jpg']);
  assert.deepEqual(record.professional_ratings, [{ rater: 'X', rating: '90', description: null }]);
});

test('fromRow: a raw JSON string for a JSONB column is tolerated (defensive, e.g. driver mocks)', () => {
  const record = fromRow({ item_number: 'WO-1', item_name: 'Test', image_urls: '["https://example.com/a.jpg"]', professional_ratings: '[]' });
  assert.deepEqual(record.image_urls, ['https://example.com/a.jpg']);
  assert.deepEqual(record.professional_ratings, []);
});

test('fromRow: a Date object for scraped_at is converted to an ISO string', () => {
  const date = new Date('2026-08-27T12:00:00.000Z');
  const record = fromRow({ item_number: 'WO-1', item_name: 'Test', scraped_at: date, image_urls: [], professional_ratings: [] });
  assert.equal(record.scraped_at, '2026-08-27T12:00:00.000Z');
});

test('fromRow: missing columns on the row become null, never undefined', () => {
  const record = fromRow({ item_number: 'WO-1' });
  assert.equal(record.abv, null);
  assert.equal(record.region, null);
  assert.notEqual(record.abv, undefined);
});

test('round trip: toRow -> (simulated row) -> fromRow preserves all 32 fields', () => {
  const original = {
    item_number: 'WO-10001',
    item_name: 'Example Cabernet Sauvignon',
    product_name: 'Example Cabernet Sauvignon',
    brand: 'Example Winery',
    producer: null,
    category: 'Red Wine',
    subcategory: null,
    size: '750ml',
    vintage: '2021',
    upc: null,
    sku: null,
    price: '39.99',
    currency: 'USD',
    availability_status: 'In stock',
    product_description: 'Black cherry, cedar, and tobacco notes.',
    food_pairing: 'Grilled steak.',
    color: null,
    aroma: null,
    taste: null,
    seasons: null,
    occasions: null,
    comments: null,
    varietal: 'Cabernet Sauvignon',
    region: 'Napa Valley',
    abv: '14.5%',
    winemaker_notes: null,
    product_highlights: null,
    professional_ratings: [],
    image_urls: ['https://example.com/images/product-1.jpg'],
    source_site: 'example-source',
    source_url: 'http://127.0.0.1:3000/input/fixtures/example-source-product.html',
    scraped_at: '2026-08-27T09:10:33.670Z'
  };

  const row = toRow(original);
  // Simulate what `pg` would hand back on SELECT * (JSONB pre-parsed).
  const simulatedDbRow = {};
  COLUMNS.forEach((field, index) => {
    if (field === 'image_urls' || field === 'professional_ratings') {
      simulatedDbRow[field] = JSON.parse(row[index]);
    } else {
      simulatedDbRow[field] = row[index];
    }
  });

  const roundTripped = fromRow(simulatedDbRow);
  assert.deepEqual(roundTripped, original);
});
