const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extract, detectPageType, classifyAccessFailure, isMatchingProduct } = require('../src/sources/wine-com');

// Phase 4 tests run entirely offline against saved/synthetic HTML fixtures
// (plus one real captured DataDome anti-bot challenge page). They must keep
// passing whether or not wine.com is reachable — every real request made
// during development was blocked, so there is no live-site dependency to
// begin with.

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function fakePage(html) {
  return { content: async () => html };
}

const REQUEST_CONTEXT = {
  item_number: 'WO-10002',
  item_name: 'Gruet Sauvage Rose',
  sourceUrl: 'https://www.wine.com/product/gruet-sauvage-rose/205944',
  httpStatus: 200
};

test('product-page fixture: product name extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.product_name, 'Gruet Sauvage Rose');
});

test('product-page fixture: brand and producer extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.brand, 'Gruet Winery');
  assert.equal(product.producer, 'Gruet Winery');
});

test('product-page fixture: category extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.category, 'Sparkling Wine');
});

test('product-page fixture: size extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.size, '750ML');
});

test('product-page fixture: vintage extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.vintage, 'NV');
});

test('product-page fixture: price extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.price, '24.99');
});

test('product-page fixture: currency extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.currency, 'USD');
});

test('product-page fixture: availability extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.availability_status, 'In stock');
});

test('product-page fixture: description extraction (verbatim, not paraphrased)', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.product_description, 'A bone-dry sparkling rose made in the traditional method, with notes of strawberry and citrus.');
});

test('product-page fixture: food pairing extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.food_pairing, 'Oysters, sushi, and light appetizers.');
});

test('product-page fixture: varietal extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.varietal, 'Pinot Noir Blend');
});

test('product-page fixture: region extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.region, 'New Mexico');
});

test('product-page fixture: ABV extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.abv, '12.5%');
});

test('product-page fixture: color, aroma, taste, winemaker notes, and highlights extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.color, 'Pale salmon pink.');
  assert.equal(product.aroma, 'Strawberry, citrus, and brioche.');
  assert.equal(product.taste, 'Bone dry with crisp acidity and a fine mousse.');
  assert.equal(product.winemaker_notes, 'Made using the traditional method with extended lees aging.');
  assert.equal(product.product_highlights, 'Extended lees aging; traditional method sparkling.');
});

test('product-page fixture: professional ratings stay empty (no generic signal for critic scores vs. customer reviews)', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.deepEqual(product.professional_ratings, []);
});

test('product-page fixture: image extraction', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.deepEqual(product.image_urls, ['https://example.com/fixtures/wine-com/gruet-sauvage-rose.jpg']);
});

test('minimal product fixture: missing scalar fields become null, not fabricated', async () => {
  const product = await extract({
    page: fakePage(loadFixture('wine-com-product-minimal.html')),
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
    page: fakePage(loadFixture('wine-com-product-minimal.html')),
    context: { ...REQUEST_CONTEXT, item_name: 'Minimal Test Wine' }
  });
  assert.deepEqual(product.image_urls, []);
  assert.deepEqual(product.professional_ratings, []);
});

test('source_site is always "wine-com" and source_url matches the requested URL', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.source_site, 'wine-com');
  assert.equal(product.source_url, REQUEST_CONTEXT.sourceUrl);
});

test('product-page fixture is detected as PRODUCT_PAGE and matched', async () => {
  const product = await extract({ page: fakePage(loadFixture('wine-com-product.html')), context: REQUEST_CONTEXT });
  assert.equal(product.__meta.pageType, 'PRODUCT_PAGE');
  assert.equal(product.__meta.matchedListing, true);
});

// --- Page-type detection ---

test('detectPageType: schema.org Product JSON-LD -> PRODUCT_PAGE', () => {
  const cheerio = require('cheerio');
  const $ = cheerio.load(loadFixture('wine-com-product.html'));
  const jsonLd = JSON.parse($('script[type="application/ld+json"]').html());
  assert.equal(detectPageType([jsonLd]), 'PRODUCT_PAGE');
});

test('detectPageType: schema.org ItemList JSON-LD -> LISTING_PAGE', () => {
  const cheerio = require('cheerio');
  const $ = cheerio.load(loadFixture('wine-com-listing.html'));
  const jsonLd = JSON.parse($('script[type="application/ld+json"]').html());
  assert.equal(detectPageType([jsonLd]), 'LISTING_PAGE');
});

test('detectPageType: no recognizable structured data -> UNKNOWN_PAGE', () => {
  assert.equal(detectPageType([]), 'UNKNOWN_PAGE');
});

test('a listing page is rejected as PRODUCT_NOT_FOUND, never extracted as a product', async () => {
  await assert.rejects(
    () => extract({ page: fakePage(loadFixture('wine-com-listing.html')), context: REQUEST_CONTEXT }),
    (error) => {
      assert.equal(error.type, 'PRODUCT_NOT_FOUND');
      return true;
    }
  );
});

test('an unknown page type is rejected as PAGE_TYPE_UNKNOWN', async () => {
  await assert.rejects(
    () => extract({ page: fakePage(loadFixture('wine-com-unknown.html')), context: REQUEST_CONTEXT }),
    (error) => {
      assert.equal(error.type, 'PAGE_TYPE_UNKNOWN');
      return true;
    }
  );
});

// --- Product matching ---

test('isMatchingProduct: requires every requested token to appear in the page product name', () => {
  assert.equal(isMatchingProduct('Gruet Sauvage Rose', 'Gruet Sauvage Rose'), true);
  assert.equal(isMatchingProduct('Gruet Sauvage Rose', 'Penfolds Superblend 802 B'), false);
});

test('a real product page whose product does not match the requested item is rejected as PRODUCT_NOT_FOUND', async () => {
  await assert.rejects(
    () => extract({
      page: fakePage(loadFixture('wine-com-product.html')),
      context: { ...REQUEST_CONTEXT, item_name: 'Penfolds Superblend 802 B' }
    }),
    (error) => {
      assert.equal(error.type, 'PRODUCT_NOT_FOUND');
      return true;
    }
  );
});

// --- Error classification ---

test('the real captured DataDome challenge page is classified as ACCESS_DENIED, not extracted as data', async () => {
  await assert.rejects(
    () => extract({
      page: fakePage(loadFixture('wine-com-blocked.html')),
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
