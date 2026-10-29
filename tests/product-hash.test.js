const test = require('node:test');
const assert = require('node:assert/strict');

const { computeProductHash } = require('../src/queue/product-hash');

test('computeProductHash: identical UPC + size hashes the same regardless of source', () => {
  const a = computeProductHash({ upc: '0850001234567', sku: null, size: '750ML' });
  const b = computeProductHash({ upc: '0850001234567', sku: null, size: '750ML' });
  assert.equal(a, b);
});

test('computeProductHash: is case/whitespace insensitive', () => {
  const a = computeProductHash({ upc: ' 0850001234567 ', size: '750ml' });
  const b = computeProductHash({ upc: '0850001234567', size: '750ML' });
  assert.equal(a, b);
});

test('computeProductHash: different UPCs hash differently', () => {
  const a = computeProductHash({ upc: '111', size: '750ML' });
  const b = computeProductHash({ upc: '222', size: '750ML' });
  assert.notEqual(a, b);
});

test('computeProductHash: same UPC, different size hashes differently', () => {
  const a = computeProductHash({ upc: '111', size: '750ML' });
  const b = computeProductHash({ upc: '111', size: '1.5L' });
  assert.notEqual(a, b);
});

test('computeProductHash: SKU alone (no UPC) is usable', () => {
  const hash = computeProductHash({ sku: '13784750', size: '750ML' });
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64); // sha256 hex
});

test('computeProductHash: neither UPC nor SKU present returns null (size alone is not an identifier)', () => {
  assert.equal(computeProductHash({ size: '750ML' }), null);
  assert.equal(computeProductHash({}), null);
});
