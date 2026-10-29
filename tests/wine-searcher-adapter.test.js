const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractWineSearcherProduct } = require('../src/sources/wine-searcher');

// Phase 2 integration tests run entirely offline against saved HTML fixtures
// (including a real captured Wine-Searcher CAPTCHA page). They must keep
// passing whether or not the live Wine-Searcher site is reachable.

function loadFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
}

function fakePage(html) {
  return { content: async () => html };
}

test('access-denied fixture (real captured PerimeterX challenge) is detected, not extracted as data', async () => {
  const html = loadFixture('wine-searcher-blocked.html');
  const page = fakePage(html);

  await assert.rejects(
    () => extractWineSearcherProduct({
      page,
      context: {
        item_number: 'WO-10001',
        item_name: 'Penfolds Superblend 802 B',
        sourceUrl: 'https://www.wine-searcher.com/find/penfolds+superblend+802+b+australia/1/india',
        httpStatus: 403
      }
    }),
    (error) => {
      assert.equal(error.type, 'ACCESS_DENIED');
      assert.equal(error.httpStatus, 403);
      return true;
    }
  );
});

test('HTTP 429 is classified as RATE_LIMITED regardless of page content', async () => {
  const html = loadFixture('wine-searcher-blocked.html');
  const page = fakePage(html);

  await assert.rejects(
    () => extractWineSearcherProduct({
      page,
      context: { sourceUrl: 'https://www.wine-searcher.com/find/x', httpStatus: 429 }
    }),
    (error) => {
      assert.equal(error.type, 'RATE_LIMITED');
      return true;
    }
  );
});

test('product-page fixture extracts real fields without fabricating missing ones', async () => {
  const html = loadFixture('wine-searcher-product.html');
  const page = fakePage(html);

  const product = await extractWineSearcherProduct({
    page,
    context: {
      item_number: 'WO-10001',
      item_name: 'Penfolds Superblend 802 B',
      sourceUrl: 'https://www.wine-searcher.com/wine/penfolds-superblend-802-b-2021',
      httpStatus: 200
    }
  });

  assert.equal(product.__meta.pageType, 'PRODUCT_PAGE');
  assert.equal(product.__meta.matchedListing, true);
  assert.equal(product.product_name, 'Penfolds Superblend 802 B 2021');
  assert.equal(product.brand, 'Penfolds');
  assert.equal(product.price, '129.99');
  assert.equal(product.currency, 'USD');
  assert.equal(product.region, 'Barossa Valley, South Australia');
  assert.equal(product.abv, '14.5%');
  assert.deepEqual(product.image_urls, ['https://example.com/fixtures/penfolds-802b-1.jpg']);

  // Fields absent from the fixture must stay null, never invented.
  assert.equal(product.producer, null);
  assert.equal(product.upc, null);
  assert.equal(product.food_pairing, null);
  assert.deepEqual(product.professional_ratings, []);
});

test('search-results fixture: a unique matching listing is extracted from its own container only', async () => {
  const html = loadFixture('wine-searcher-search-results.html');
  const page = fakePage(html);

  const product = await extractWineSearcherProduct({
    page,
    context: {
      item_number: 'WO-10001',
      item_name: 'Penfolds Superblend 802 B',
      sourceUrl: 'https://www.wine-searcher.com/find/penfolds+superblend+802+b+australia/1/india',
      httpStatus: 200
    }
  });

  assert.equal(product.__meta.pageType, 'LISTING_PAGE');
  assert.equal(product.__meta.matchedListing, true);
  assert.equal(product.product_name, 'Penfolds Superblend 802 B');
  assert.equal(product.price, '$129.99');
  // Must not pull data from the unrelated "Penfolds Bin 389" listing on the same page.
  assert.notEqual(product.price, '$59.99');
});

test('search-results fixture: an ambiguous name is rejected as PRODUCT_NOT_FOUND, never a fabricated match', async () => {
  const html = loadFixture('wine-searcher-search-results.html');
  const page = fakePage(html);

  await assert.rejects(
    () => extractWineSearcherProduct({
      page,
      context: {
        item_number: 'WO-10001',
        item_name: 'Penfolds',
        sourceUrl: 'https://www.wine-searcher.com/find/penfolds/1/india',
        httpStatus: 200
      }
    }),
    (error) => {
      assert.equal(error.type, 'PRODUCT_NOT_FOUND');
      return true;
    }
  );
});

test('search-results fixture: no matching listing is rejected as PRODUCT_NOT_FOUND, never a fabricated match', async () => {
  const html = loadFixture('wine-searcher-search-results.html');
  const page = fakePage(html);

  await assert.rejects(
    () => extractWineSearcherProduct({
      page,
      context: {
        item_number: 'WO-99999',
        item_name: 'Nonexistent Winery Product',
        sourceUrl: 'https://www.wine-searcher.com/find/nonexistent+winery+product/1/india',
        httpStatus: 200
      }
    }),
    (error) => {
      assert.equal(error.type, 'PRODUCT_NOT_FOUND');
      return true;
    }
  );
});

test('a page with no schema.org Product data and a non-/find/ URL is rejected as PAGE_TYPE_UNKNOWN', async () => {
  const page = fakePage('<html><head><title>Some other page</title></head><body>No structured data here.</body></html>');

  await assert.rejects(
    () => extractWineSearcherProduct({
      page,
      context: {
        item_number: 'WO-10001',
        item_name: 'Penfolds Superblend 802 B',
        sourceUrl: 'https://www.wine-searcher.com/about-us',
        httpStatus: 200
      }
    }),
    (error) => {
      assert.equal(error.type, 'PAGE_TYPE_UNKNOWN');
      return true;
    }
  );
});
