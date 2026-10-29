const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveSource,
  getAdapterForUrl,
  detectSourceNameByUrl,
  sourceRegistry,
  PRODUCTION_SOURCE_NAMES
} = require('../src/sources/source-registry');

// All Phase 3 registry behavior is deterministic and offline — no network
// calls, no dependency on Wine.com / Total Wine / Vivino / Wine-Searcher
// actually being reachable.

test('the four approved production sources are registered', () => {
  assert.deepEqual(
    [...PRODUCTION_SOURCE_NAMES].sort(),
    ['total-wine', 'vivino', 'wine-com', 'wine-searcher'].sort()
  );
});

test('every production adapter exposes the common adapter contract', () => {
  for (const name of PRODUCTION_SOURCE_NAMES) {
    const adapter = sourceRegistry[name];
    assert.equal(typeof adapter.canHandle, 'function', `${name} missing canHandle`);
    assert.equal(typeof adapter.extract, 'function', `${name} missing extract`);
    assert.ok(Array.isArray(adapter.hostnames) && adapter.hostnames.length > 0, `${name} missing hostnames`);
  }
});

test('detects wine.com from www and non-www URLs', () => {
  assert.equal(detectSourceNameByUrl('https://www.wine.com/product/123'), 'wine-com');
  assert.equal(detectSourceNameByUrl('https://wine.com/product/123'), 'wine-com');
});

test('detects total-wine from www and non-www URLs', () => {
  assert.equal(detectSourceNameByUrl('https://www.totalwine.com/wine/red-wine/123'), 'total-wine');
  assert.equal(detectSourceNameByUrl('https://totalwine.com/wine/red-wine/123'), 'total-wine');
});

test('detects vivino from www and non-www URLs', () => {
  assert.equal(detectSourceNameByUrl('https://www.vivino.com/wines/123'), 'vivino');
  assert.equal(detectSourceNameByUrl('https://vivino.com/wines/123'), 'vivino');
});

test('detects wine-searcher from www and non-www URLs', () => {
  assert.equal(detectSourceNameByUrl('https://www.wine-searcher.com/find/x'), 'wine-searcher');
  assert.equal(detectSourceNameByUrl('https://wine-searcher.com/find/x'), 'wine-searcher');
});

test('flaviar URLs are not treated as one of the four production sources', () => {
  assert.equal(detectSourceNameByUrl('https://flaviar.com/products/wyoming-whiskey-single-barrel-750'), null);
  assert.equal(detectSourceNameByUrl('https://eu.flaviar.com/products/mount-gay-xo-triple-cask-blend-700'), null);
});

test('an unsupported hostname is not detected', () => {
  assert.equal(detectSourceNameByUrl('https://unsupported.example.com/product/123'), null);
});

test('near-miss / spoofed domains are not mistaken for approved sources', () => {
  // "wine.com" is a substring/suffix trap: a naive text-contains check would
  // wrongly accept these. Hostname matching must reject them.
  assert.equal(detectSourceNameByUrl('https://wine.com.evil.example/product'), null);
  assert.equal(detectSourceNameByUrl('https://example-wine-searcher.com/product'), null);
  assert.equal(detectSourceNameByUrl('https://notwine.com/product'), null);
  assert.equal(detectSourceNameByUrl('https://fakewine.com/product'), null);

  // A spoofed/near-miss domain must never be mistaken for the real named
  // adapter it resembles — it still falls back to a generic adapter (per
  // the behavior change below), but critically, the WRONG production
  // adapter (with the wrong extraction assumptions) is never selected.
  for (const [url, spoofedName] of [
    ['https://wine.com.evil.example/product', 'wine-com'],
    ['https://example-wine-searcher.com/product', 'wine-searcher']
  ]) {
    const adapter = getAdapterForUrl(url);
    assert.notEqual(adapter.name, spoofedName);
    assert.equal(adapter.isGeneric, true);
  }
});

test('getAdapterForUrl returns the matching adapter for a recognized URL', () => {
  const adapter = getAdapterForUrl('https://www.vivino.com/wines/123');
  assert.equal(adapter.name, 'vivino');
});

test('getAdapterForUrl returns the flaviar browser-interaction adapter for a flaviar URL', () => {
  const adapter = getAdapterForUrl('https://flaviar.com/products/wyoming-whiskey-single-barrel-750');
  assert.equal(adapter.name, 'flaviar');
  assert.equal(typeof adapter.preparePage, 'function');
});

// Behavior changed by explicit request — see the resolveSource test above
// for the full rationale. getAdapterForUrl is resolveSource's URL-routing
// primitive, so it changes the same way.
test('getAdapterForUrl falls back to a generic adapter for an unrecognized URL, never a silent match to the wrong production adapter', async () => {
  const adapter = getAdapterForUrl('https://unsupported.example.com/product/123');
  assert.equal(adapter.name, 'unsupported.example.com');
  assert.equal(adapter.isGeneric, true);
  assert.equal(typeof adapter.extract, 'function');
});

test('resolveSource with an explicit name preserves the Phase 1/2 contract unchanged', () => {
  assert.equal(resolveSource({ name: 'wine-searcher' }).name, 'wine-searcher');
  assert.equal(resolveSource({ name: 'example-source' }).name, 'example-source');
});

test('resolveSource with an explicit unsupported name throws UNSUPPORTED_SOURCE', () => {
  assert.throws(
    () => resolveSource({ name: 'not-a-real-source' }),
    (error) => {
      assert.equal(error.type, 'UNSUPPORTED_SOURCE');
      return true;
    }
  );
});

test('resolveSource with only a URL (no name) auto-detects a production source', () => {
  assert.equal(resolveSource({ url: 'https://www.wine.com/product/123' }).name, 'wine-com');
});

test('resolveSource auto-detects flaviar URLs as the browser-interaction adapter', () => {
  assert.equal(resolveSource({ url: 'https://flaviar.com/products/wyoming-whiskey-single-barrel-750' }).name, 'flaviar');
});

// Behavior changed by explicit request: a URL that doesn't match one of
// the four named production adapters now resolves to a generic,
// standards-based adapter (schema.org/OpenGraph parsing — see
// src/sources/generic-adapter.js) instead of being rejected outright. It
// may still fail for real reasons downstream (robots.txt, anti-bot,
// missing schema.org markup) — this only means extraction is always
// attempted, never refused purely because the hostname is unrecognized.
test('resolveSource with an unrecognized URL and no name falls back to a generic adapter, not silently rejected', () => {
  const adapter = resolveSource({ url: 'https://unsupported.example.com/product/123' });
  assert.equal(adapter.name, 'unsupported.example.com');
  assert.equal(typeof adapter.extract, 'function');
  assert.equal(adapter.isGeneric, true);
});

test('resolveSource with a malformed URL still throws UNSUPPORTED_SOURCE (nothing to build a generic adapter from)', () => {
  assert.throws(
    () => resolveSource({ url: 'not a url at all' }),
    (error) => {
      assert.equal(error.type, 'UNSUPPORTED_SOURCE');
      return true;
    }
  );
});

test('resolveSource with neither name nor url falls back to the local fixture (pre-existing default)', () => {
  assert.equal(resolveSource({}).name, 'example-source');
});

test('all four production adapters are real implementations, not stubs (as of Phase 6)', async () => {
  // wine-com (Phase 4), total-wine (Phase 5), and vivino (Phase 6) each have
  // their own dedicated adapter test suite — this just confirms none of the
  // four production sources fall back to the generic NOT_IMPLEMENTED stub
  // behavior anymore. wine-searcher (Phase 2) predates the PAGE_TYPE_UNKNOWN
  // convention and resolves with an all-null record for unrecognized pages
  // instead of throwing — that is its existing, legitimate behavior, not a
  // regression, so it is only checked for the absence of NOT_IMPLEMENTED.
  for (const name of PRODUCTION_SOURCE_NAMES) {
    try {
      const result = await sourceRegistry[name].extract({ page: { content: async () => '<html></html>' }, context: {} });
      assert.ok(result, `${name} should resolve to a record, not throw, for this input`);
    } catch (error) {
      assert.notEqual(error.type, 'NOT_IMPLEMENTED', `${name} should not fall back to the stub behavior`);
    }
  }
});

test('Talli Drinks is not a detectable production source and is not in PRODUCTION_SOURCE_NAMES', () => {
  assert.equal(detectSourceNameByUrl('https://www.tallidrinks.com/product-page/fratelli-cabernet-sauvignon-1'), null);
  assert.ok(!PRODUCTION_SOURCE_NAMES.includes('talli-drinks-test'));
  // It remains reachable only by explicit name, for the dev/test integration flow.
  assert.equal(resolveSource({ name: 'talli-drinks-test' }).name, 'talli-drinks-test');
});
