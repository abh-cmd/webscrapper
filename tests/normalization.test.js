const test = require('node:test');
const assert = require('node:assert/strict');

const { createEmptyProductRecord, normalizeProductRecord } = require('../src/schema/product-schema');

test('creates a normalized empty product record', () => {
  const record = createEmptyProductRecord();

  assert.equal(record.item_number, null);
  assert.deepEqual(record.professional_ratings, []);
  assert.deepEqual(record.image_urls, []);
});

test('missing scalar values become null', () => {
  const record = normalizeProductRecord({
    item_name: '  Example Wine  ',
    brand: '   ',
    category: '',
    image_urls: [''],
    professional_ratings: [{ rater: ' ', rating: '  ', description: '  ' }]
  });

  assert.equal(record.item_name, 'Example Wine');
  assert.equal(record.brand, null);
  assert.equal(record.category, null);
  assert.deepEqual(record.image_urls, []);
  assert.deepEqual(record.professional_ratings, [{
    rater: null,
    rating: null,
    description: null
  }]);
});

test('empty arrays remain empty arrays', () => {
  const record = normalizeProductRecord({
    image_urls: [],
    professional_ratings: []
  });

  assert.deepEqual(record.image_urls, []);
  assert.deepEqual(record.professional_ratings, []);
});

test('whitespace is cleaned from strings', () => {
  const record = normalizeProductRecord({
    item_name: '  Example Cabernet  ',
    product_description: '  Rich and layered  '
  });

  assert.equal(record.item_name, 'Example Cabernet');
  assert.equal(record.product_description, 'Rich and layered');
});
