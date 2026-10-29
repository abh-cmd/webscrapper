const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');
const { solidColorPng } = require('./helpers/png-fixture');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let store;
if (isDatabaseConfigured()) {
  store = require('../src/images/image-store-repository');
}

const TEST_ITEM_A = 'WO-IMGSTORE-TEST-A';
const TEST_ITEM_B = 'WO-IMGSTORE-TEST-B';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM image_references WHERE item_number LIKE $1;', ['WO-IMGSTORE-TEST-%']);
  await pool.query(
    `DELETE FROM images WHERE content_hash IN (
       SELECT content_hash FROM images WHERE first_seen_source_url LIKE $1
     );`,
    ['https://images.test.invalid/%']
  );
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('storing a valid image succeeds and records real dimensions/format', { skip }, async () => {
  const bytes = solidColorPng(50, 50, [10, 20, 30]);
  const result = await store.storeValidatedImage(bytes, { sourceUrl: 'https://images.test.invalid/a.png' });
  assert.equal(result.stored, true);
  assert.equal(result.deduped, false);
  assert.equal(result.image.format, 'png');
  assert.equal(result.image.width, 50);
  assert.equal(result.image.height, 50);
  assert.ok(fs.existsSync(result.image.storagePath), 'the original bytes must actually be written to the configured storage location');
});

test('an invalid image (e.g. SVG) is rejected before any storage happens', { skip }, async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8');
  const result = await store.storeValidatedImage(svg, { sourceUrl: 'https://images.test.invalid/bad.svg' });
  assert.equal(result.stored, false);
  assert.equal(result.validation.reason, 'SVG_REJECTED');
});

test('content-hash deduplication: storing the identical bytes twice does not create a second images row', { skip }, async () => {
  const bytes = solidColorPng(30, 30, [99, 99, 99]);
  const first = await store.storeValidatedImage(bytes, { sourceUrl: 'https://images.test.invalid/dup-1.png' });
  const second = await store.storeValidatedImage(Buffer.from(bytes), { sourceUrl: 'https://images.test.invalid/dup-2.png' });

  assert.equal(first.deduped, false);
  assert.equal(second.deduped, true);
  assert.equal(first.image.id, second.image.id);
});

test('cross-source image deduplication: the same image referenced by two different products shares one stored image', { skip }, async () => {
  const bytes = solidColorPng(40, 40, [55, 66, 77]);
  const stored = await store.storeValidatedImage(bytes, { sourceUrl: 'https://images.test.invalid/shared.png' });

  const refA = await store.addImageReference({
    imageId: stored.image.id,
    itemNumber: TEST_ITEM_A,
    sourceName: 'wine-com',
    sourceUrl: 'https://images.wine.com/shared.png',
    role: 'hero'
  });
  const refB = await store.addImageReference({
    imageId: stored.image.id,
    itemNumber: TEST_ITEM_B,
    sourceName: 'total-wine',
    sourceUrl: 'https://images.totalwine.com/shared-elsewhere.png',
    role: 'hero'
  });

  assert.equal(refA.imageId, refB.imageId, 'two different products referencing the same bytes must point at one stored image');

  const referencesForA = await store.getImageReferences(TEST_ITEM_A);
  assert.equal(referencesForA.length, 1);
  assert.equal(referencesForA[0].image.contentHash, stored.image.contentHash);
});

test('image role assignment is preserved per reference', { skip }, async () => {
  const references = await store.getImageReferences(TEST_ITEM_A);
  assert.equal(references[0].role, 'hero');
});

test('exactly one primary image per product is enforced', { skip }, async () => {
  const heroBytes = solidColorPng(60, 60, [1, 1, 1]);
  const labelBytes = solidColorPng(60, 60, [2, 2, 2]);
  const heroStored = await store.storeValidatedImage(heroBytes, { sourceUrl: 'https://images.test.invalid/hero-primary.png' });
  const labelStored = await store.storeValidatedImage(labelBytes, { sourceUrl: 'https://images.test.invalid/label-primary.png' });

  const heroRef = await store.addImageReference({
    imageId: heroStored.image.id, itemNumber: TEST_ITEM_B, sourceName: 'wine-com',
    sourceUrl: 'https://images.wine.com/hero-primary.png', role: 'hero'
  });
  const labelRef = await store.addImageReference({
    imageId: labelStored.image.id, itemNumber: TEST_ITEM_B, sourceName: 'wine-com',
    sourceUrl: 'https://images.wine.com/label-primary.png', role: 'label'
  });

  await store.setPrimaryImageReference(TEST_ITEM_B, heroRef.id);
  const afterFirst = await store.getImageReferences(TEST_ITEM_B);
  assert.equal(afterFirst.filter((r) => r.isPrimary).length, 1);
  assert.equal(afterFirst.find((r) => r.isPrimary).id, heroRef.id);

  // Switching primary to the label image must not leave two primaries.
  await store.setPrimaryImageReference(TEST_ITEM_B, labelRef.id);
  const afterSwitch = await store.getImageReferences(TEST_ITEM_B);
  const primaries = afterSwitch.filter((r) => r.isPrimary);
  assert.equal(primaries.length, 1, 'exactly one primary image must exist at all times');
  assert.equal(primaries[0].id, labelRef.id);
});

test('perceptual-hash near-duplicate lookup finds visually-similar-but-not-identical PNGs', { skip }, async () => {
  // A solid color always downsamples to every pixel exactly equal to the
  // mean, which collapses to the same hash for ANY solid shade (already
  // proven in tests/image-validation.test.js) — not a useful "slightly
  // different" fixture. A split image with a shifted split point gives a
  // real perceptual difference instead — the shift has to be large enough
  // to actually cross one of the 8x8 hash grid's sample points (spaced
  // 8px apart across a 64px image), verified directly: a 32->36 shift
  // lands between two sample points and produces distance 0 (not useful
  // for this test); a 32->44 shift crosses one and produces distance 8.
  const { makePng } = require('./helpers/png-fixture');
  const original = makePng(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
  const shifted = makePng(64, 64, (x) => (x < 44 ? [0, 0, 0] : [255, 255, 255]));

  const first = await store.storeValidatedImage(original, { sourceUrl: 'https://images.test.invalid/near-1.png' });
  const second = await store.storeValidatedImage(shifted, { sourceUrl: 'https://images.test.invalid/near-2.png' });

  assert.ok(first.image.perceptualHash, 'a PNG must get a real perceptual hash');
  assert.notEqual(first.image.contentHash, second.image.contentHash, 'these must be genuinely different files, not deduped away');

  const matches = await store.findNearDuplicatesByPerceptualHash(first.image.perceptualHash, { maxDistance: 10 });
  assert.ok(matches.some((m) => m.image.id === second.image.id), 'a shifted split image should be found as a perceptual near-duplicate');
});

test('cleanup: remove all test rows', { skip }, async () => {
  await cleanup();
  await closePool();
});
