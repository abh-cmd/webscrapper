const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extract, detectPageType, classifyAccessFailure, isMatchingProduct } = require('../src/sources/total-wine');

// Phase 5 tests run entirely offline against saved/synthetic HTML fixtures
// (plus one real captured PerimeterX anti-bot challenge page). They must
// keep passing whether or not totalwine.com is reachable — every real
// request made during development was blocked, so there is no live-site
// dependency to begin with.

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function fakePage(html) {
  return { content: async () => html };
}

const REQUEST_CONTEXT = {
  item_number: 'WO-10003',
  item_name: 'Torres Vina Esmeralda',
  sourceUrl: 'https://www.totalwine.com/wine/white-wine/white-blend/torres-vina-esmeralda/p/13784750',
  httpStatus: 200
};

test('product-page fixture: product name extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.product_name, 'Torres Vina Esmeralda');
});

test('product-page fixture: brand extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.brand, 'Torres');
});

test('product-page fixture: producer extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.producer, 'Familia Torres');
});

test('product-page fixture: category extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.category, 'White Wine');
});

test('product-page fixture: size extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.size, '750ML');
});

test('product-page fixture: vintage extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.vintage, '2023');
});

test('product-page fixture: UPC extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.upc, '8410113005557');
});

test('product-page fixture: SKU extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.sku, '13784750');
});

test('product-page fixture: price extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.price, '11.99');
});

test('product-page fixture: currency extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.currency, 'USD');
});

test('product-page fixture: availability extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.availability_status, 'In stock');
});

test('product-page fixture: description extraction (verbatim, not paraphrased)', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.product_description, 'A fragrant, floral white blend of Moscatel and Gewurztraminer from Penedes, Catalonia.');
});

test('product-page fixture: food pairing extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.food_pairing, 'Spicy Asian cuisine, Thai food, and appetizers.');
});

test('product-page fixture: color extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.color, 'Pale straw yellow.');
});

test('product-page fixture: aroma extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.aroma, 'Floral notes of muscat grape and lychee.');
});

test('product-page fixture: taste extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.taste, 'Off-dry with crisp acidity and a fragrant finish.');
});

test('product-page fixture: varietal extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.varietal, 'Moscatel / Gewurztraminer Blend');
});

test('product-page fixture: region extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.region, 'Penedes, Catalonia, Spain');
});

test('product-page fixture: ABV extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.abv, '11.5%');
});

test('product-page fixture: professional ratings stay empty (no generic signal for critic scores vs. customer reviews)', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.deepEqual(product.professional_ratings, []);
});

test('product-page fixture: image extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.deepEqual(product.image_urls, ['https://example.com/fixtures/total-wine/torres-vina-esmeralda.jpg']);
});

test('minimal product fixture: missing scalar fields become null, not fabricated', async () => {
  const product = await extract({
    page: fakePage(loadFixture('total-wine-product-minimal.html')),
    context: { ...REQUEST_CONTEXT, item_name: 'Minimal Test Wine' }
  });
  assert.equal(product.brand, null);
  assert.equal(product.producer, null);
  assert.equal(product.category, null);
  assert.equal(product.vintage, null);
  assert.equal(product.varietal, null);
  assert.equal(product.region, null);
  assert.equal(product.abv, null);
  assert.equal(product.food_pairing, null);
  assert.equal(product.color, null);
  assert.equal(product.aroma, null);
  assert.equal(product.taste, null);
  assert.equal(product.upc, null);
});

test('minimal product fixture: missing arrays become [], not fabricated', async () => {
  const product = await extract({
    page: fakePage(loadFixture('total-wine-product-minimal.html')),
    context: { ...REQUEST_CONTEXT, item_name: 'Minimal Test Wine' }
  });
  assert.deepEqual(product.image_urls, []);
  assert.deepEqual(product.professional_ratings, []);
});

test('source_site is always "total-wine", source_url matches, and scraped_at is set', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.source_site, 'total-wine');
  assert.equal(product.source_url, REQUEST_CONTEXT.sourceUrl);
  assert.equal(typeof product.scraped_at, 'string');
  assert.ok(!Number.isNaN(Date.parse(product.scraped_at)));
});

test('product-page fixture is detected as PRODUCT_PAGE and matched', async () => {
  const product = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.__meta.pageType, 'PRODUCT_PAGE');
  assert.equal(product.__meta.matchedListing, true);
});

test('the normalized record is compatible with the existing 32-field schema (via normalizeProductRecord)', async () => {
  const { normalizeProductRecord, createEmptyProductRecord } = require('../src/schema/product-schema');
  const raw = await extract({ page: fakePage(loadFixture('total-wine-product.html')), context: REQUEST_CONTEXT });
  const normalized = normalizeProductRecord(raw);
  assert.deepEqual(Object.keys(normalized).sort(), Object.keys(createEmptyProductRecord()).sort());
  assert.equal(normalized.product_name, 'Torres Vina Esmeralda');
  assert.equal(normalized.source_site, 'total-wine');
});

// --- Page-type detection ---

test('detectPageType: schema.org Product JSON-LD -> PRODUCT_PAGE', () => {
  const cheerio = require('cheerio');
  const $ = cheerio.load(loadFixture('total-wine-product.html'));
  const jsonLd = JSON.parse($('script[type="application/ld+json"]').html());
  assert.equal(detectPageType([jsonLd]), 'PRODUCT_PAGE');
});

test('detectPageType: schema.org ItemList JSON-LD -> LISTING_PAGE', () => {
  const cheerio = require('cheerio');
  const $ = cheerio.load(loadFixture('total-wine-listing.html'));
  const jsonLd = JSON.parse($('script[type="application/ld+json"]').html());
  assert.equal(detectPageType([jsonLd]), 'LISTING_PAGE');
});

test('detectPageType: no recognizable structured data -> UNKNOWN_PAGE', () => {
  assert.equal(detectPageType([]), 'UNKNOWN_PAGE');
});

test('a listing page is rejected as PRODUCT_NOT_FOUND, never extracted as a product', async () => {
  await assert.rejects(
    () => extract({ page: fakePage(loadFixture('total-wine-listing.html')), context: REQUEST_CONTEXT }),
    (error) => {
      assert.equal(error.type, 'PRODUCT_NOT_FOUND');
      return true;
    }
  );
});

test('an unknown page type is rejected as PAGE_TYPE_UNKNOWN', async () => {
  await assert.rejects(
    () => extract({ page: fakePage(loadFixture('total-wine-unknown.html')), context: REQUEST_CONTEXT }),
    (error) => {
      assert.equal(error.type, 'PAGE_TYPE_UNKNOWN');
      return true;
    }
  );
});

// --- Product matching ---

test('isMatchingProduct: requires every requested token to appear in the page product name', () => {
  assert.equal(isMatchingProduct('Torres Vina Esmeralda', 'Torres Vina Esmeralda'), true);
  assert.equal(isMatchingProduct('Torres Vina Esmeralda', 'Penfolds Superblend 802 B'), false);
});

test('a real product page whose product does not match the requested item is rejected as PRODUCT_NOT_FOUND', async () => {
  await assert.rejects(
    () => extract({
      page: fakePage(loadFixture('total-wine-product.html')),
      context: { ...REQUEST_CONTEXT, item_name: 'Penfolds Superblend 802 B' }
    }),
    (error) => {
      assert.equal(error.type, 'PRODUCT_NOT_FOUND');
      return true;
    }
  );
});

// --- Error classification ---

test('the real captured PerimeterX challenge page is classified as ACCESS_DENIED, not extracted as data', async () => {
  await assert.rejects(
    () => extract({
      page: fakePage(loadFixture('total-wine-blocked.html')),
      context: { ...REQUEST_CONTEXT, httpStatus: 403 }
    }),
    (error) => {
      assert.equal(error.type, 'ACCESS_DENIED');
      assert.equal(error.httpStatus, 403);
      return true;
    }
  );
});

test('classifyAccessFailure: HTTP 429 -> RATE_LIMITED', () => {
  const result = classifyAccessFailure({ httpStatus: 429, pageText: '', title: '' });
  assert.equal(result.code, 'RATE_LIMITED');
});

test('classifyAccessFailure: HTTP 404 -> PRODUCT_NOT_FOUND', () => {
  const result = classifyAccessFailure({ httpStatus: 404, pageText: '', title: '' });
  assert.equal(result.code, 'PRODUCT_NOT_FOUND');
});

test('classifyAccessFailure: HTTP 500 -> SOURCE_SERVER_ERROR', () => {
  const result = classifyAccessFailure({ httpStatus: 503, pageText: '', title: '' });
  assert.equal(result.code, 'SOURCE_SERVER_ERROR');
});

test('classifyAccessFailure: a normal 200 page with no bot-challenge wording is not flagged', () => {
  const result = classifyAccessFailure({ httpStatus: 200, pageText: 'A normal product page.', title: 'Some Wine' });
  assert.equal(result, null);
});

test('an unexpected internal error during extraction is classified as EXTRACTION_FAILED', async () => {
  const brokenPage = { content: async () => { throw new Error('boom'); } };
  await assert.rejects(
    () => extract({ page: brokenPage, context: REQUEST_CONTEXT }),
    (error) => {
      assert.equal(error.type, 'EXTRACTION_FAILED');
      return true;
    }
  );
});
