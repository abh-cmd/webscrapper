const test = require('node:test');
const assert = require('node:assert/strict');

const { selectBestSource, DEFAULT_SOURCE_PRIORITY } = require('../src/selection/source-selector');
const { createEmptyProductRecord } = require('../src/schema/product-schema');

// Phase 8: the multi-source selection layer is a pure, deterministic
// function operating on already-normalized adapter results. All tests here
// run fully offline — no crawling, no network calls, no live sources.

function makeProduct(overrides = {}) {
  return { ...createEmptyProductRecord(), item_number: 'WO-10001', item_name: 'Test Wine', ...overrides };
}

function success(sourceName, overrides = {}) {
  return { sourceName, status: 'success', product: makeProduct({ source_site: sourceName, ...overrides }), error: null };
}

function failed(sourceName, errorType) {
  return { sourceName, status: 'failed', product: null, error: { type: errorType, message: `${sourceName} failed: ${errorType}` } };
}

test('1. one successful source is selected directly', () => {
  const result = selectBestSource([success('wine-com', { abv: '13.5%' })]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.product.abv, '13.5%');
  assert.equal(result.provenance.primarySource, 'wine-com');
});

test('2. multiple successful sources: the most complete one is primary', () => {
  const result = selectBestSource([
    success('wine-com', { abv: '13.5%', region: 'Napa Valley' }),
    success('total-wine', { abv: '13.5%' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provenance.primarySource, 'wine-com');
  assert.equal(result.product.region, 'Napa Valley');
});

test('3. one source blocked does not prevent using the other', () => {
  const result = selectBestSource([
    failed('wine-com', 'ACCESS_DENIED'),
    success('total-wine', { abv: '14.0%' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provenance.primarySource, 'total-wine');
  assert.equal(result.product.abv, '14.0%');
});

test('4. multiple sources blocked still allows selecting from the remaining successful source', () => {
  const result = selectBestSource([
    failed('wine-com', 'ACCESS_DENIED'),
    failed('wine-searcher', 'ACCESS_DENIED'),
    failed('total-wine', 'PAGE_TYPE_UNKNOWN'),
    success('vivino', { varietal: 'Malbec' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provenance.primarySource, 'vivino');
  assert.equal(result.product.varietal, 'Malbec');
});

test('5. partial data: gaps in the primary source are filled from a secondary source, never guessed', () => {
  const result = selectBestSource([
    success('wine-com', { abv: null, region: 'Napa Valley', varietal: 'Cabernet Sauvignon' }),
    success('total-wine', { abv: '14.5%', region: 'Sonoma' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provenance.primarySource, 'wine-com');
  // abv was null on the primary (wine-com) source -> filled from total-wine.
  assert.equal(result.product.abv, '14.5%');
  assert.equal(result.provenance.fieldSources.abv, 'total-wine');
  // region was already populated on the primary source -> kept, not overwritten.
  assert.equal(result.product.region, 'Napa Valley');
  assert.equal(result.provenance.fieldSources.region, 'wine-com');
});

test('6. complete data from a single source needs no filling', () => {
  const result = selectBestSource([
    success('wine-com', { abv: '13.5%', region: 'Napa Valley', varietal: 'Cabernet Sauvignon', price: '39.99' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provenance.fieldSources.abv, 'wine-com');
  assert.equal(result.provenance.fieldSources.region, 'wine-com');
});

test('7. conflicting explicit values: higher-priority source wins, conflict is documented, never averaged', () => {
  const result = selectBestSource([
    success('wine-com', { abv: '13.5%' }),
    success('total-wine', { abv: '14.0%' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  // wine-com outranks total-wine in the documented priority order, and both
  // have identical completeness here, so wine-com's value wins.
  assert.equal(result.product.abv, '13.5%');
  assert.equal(result.provenance.conflicts.length, 1);
  assert.deepEqual(result.provenance.conflicts[0], {
    field: 'abv',
    chosenSource: 'wine-com',
    chosenValue: '13.5%',
    conflictingSource: 'total-wine',
    conflictingValue: '14.0%'
  });
  // Never averaged into some invented "13.75%".
  assert.notEqual(result.product.abv, '13.75%');
});

test('8. a source-reported product mismatch (PRODUCT_NOT_FOUND) is treated as a failure, excluded from selection', () => {
  const result = selectBestSource([
    failed('wine-com', 'PRODUCT_NOT_FOUND'),
    success('vivino', { product_name: 'Correctly Matched Wine' })
  ]);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.provenance.primarySource, 'vivino');
  assert.equal(result.product.product_name, 'Correctly Matched Wine');
});

test('9. no usable source: every source failed', () => {
  const result = selectBestSource([
    failed('wine-com', 'ACCESS_DENIED'),
    failed('total-wine', 'ACCESS_DENIED'),
    failed('vivino', 'PRODUCT_NOT_FOUND'),
    failed('wine-searcher', 'ACCESS_DENIED')
  ]);
  assert.equal(result.status, 'NO_USABLE_SOURCE');
  assert.equal(result.product, null);
  assert.equal(result.attempted.length, 4);
  assert.ok(result.attempted.every((a) => a.status === 'failed'));
});

test('9b. no sources attempted at all also yields NO_USABLE_SOURCE', () => {
  const result = selectBestSource([]);
  assert.equal(result.status, 'NO_USABLE_SOURCE');
  assert.deepEqual(result.attempted, []);
});

test('10. source priority rule: documented order is wine-com > total-wine > vivino > wine-searcher when completeness ties', () => {
  assert.deepEqual(DEFAULT_SOURCE_PRIORITY, ['wine-com', 'total-wine', 'vivino', 'wine-searcher']);

  const result = selectBestSource([
    success('wine-searcher', { abv: '13.5%' }),
    success('vivino', { abv: '13.5%' }),
    success('total-wine', { abv: '13.5%' }),
    success('wine-com', { abv: '13.5%' })
  ]);
  // All four have identical completeness, so priority order alone decides.
  assert.equal(result.provenance.primarySource, 'wine-com');
  assert.deepEqual(result.provenance.ranking, ['wine-com', 'total-wine', 'vivino', 'wine-searcher']);
});

test('10b. a custom priority order can be supplied without changing the default', () => {
  const result = selectBestSource(
    [success('wine-searcher', { abv: '13.5%' }), success('wine-com', { abv: '13.5%' })],
    { priorityOrder: ['wine-searcher', 'wine-com'] }
  );
  assert.equal(result.provenance.primarySource, 'wine-searcher');
  assert.deepEqual(DEFAULT_SOURCE_PRIORITY, ['wine-com', 'total-wine', 'vivino', 'wine-searcher']);
});

test('11. provenance is preserved: every populated field can be traced to the source it came from', () => {
  const result = selectBestSource([
    success('wine-com', { abv: '13.5%', region: null }),
    success('total-wine', { abv: null, region: 'Sonoma' })
  ]);
  assert.equal(result.provenance.fieldSources.abv, 'wine-com');
  assert.equal(result.provenance.fieldSources.region, 'total-wine');
  // item_number/item_name/source_site/source_url/scraped_at are never
  // cross-source-filled, so they are not part of the field provenance map.
  assert.equal(result.provenance.fieldSources.item_number, undefined);
  assert.equal(result.provenance.fieldSources.source_url, undefined);
});

test('12. the final merged product still matches the existing 32-field schema exactly', () => {
  const result = selectBestSource([
    success('wine-com', { abv: '13.5%' }),
    success('total-wine', { region: 'Sonoma' })
  ]);
  assert.deepEqual(Object.keys(result.product).sort(), Object.keys(createEmptyProductRecord()).sort());
});

test('the common 32-field schema itself is never modified by this module (no extra fields on the record)', () => {
  const result = selectBestSource([success('wine-com')]);
  const extraKeys = Object.keys(result.product).filter((key) => !(key in createEmptyProductRecord()));
  assert.deepEqual(extraKeys, []);
});

test('array fields (image_urls) fill from a secondary source only when the primary has none, as a whole array', () => {
  const result = selectBestSource([
    success('wine-com', { image_urls: [] }),
    success('total-wine', { image_urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'] })
  ]);
  assert.deepEqual(result.product.image_urls, ['https://example.com/a.jpg', 'https://example.com/b.jpg']);
  assert.equal(result.provenance.fieldSources.image_urls, 'total-wine');
});
