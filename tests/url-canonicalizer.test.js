const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalizeUrl } = require('../src/queue/url-canonicalizer');

test('canonicalizeUrl: lowercases the hostname', () => {
  assert.equal(canonicalizeUrl('https://WWW.Wine.com/product/x'), canonicalizeUrl('https://www.wine.com/product/x'));
});

test('canonicalizeUrl: strips a trailing slash', () => {
  assert.equal(canonicalizeUrl('https://www.wine.com/product/x/'), canonicalizeUrl('https://www.wine.com/product/x'));
});

test('canonicalizeUrl: sorts query parameters', () => {
  assert.equal(
    canonicalizeUrl('https://www.totalwine.com/wine?b=2&a=1'),
    canonicalizeUrl('https://www.totalwine.com/wine?a=1&b=2')
  );
});

test('canonicalizeUrl: strips the fragment', () => {
  assert.equal(canonicalizeUrl('https://www.vivino.com/wines/1#reviews'), canonicalizeUrl('https://www.vivino.com/wines/1'));
});

test('canonicalizeUrl: distinct paths remain distinct', () => {
  assert.notEqual(canonicalizeUrl('https://www.wine.com/product/a'), canonicalizeUrl('https://www.wine.com/product/b'));
});
