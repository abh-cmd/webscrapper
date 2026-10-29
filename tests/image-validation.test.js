const test = require('node:test');
const assert = require('node:assert/strict');

const { detectImageFormat } = require('../src/images/magic-bytes');
const { parseDimensions } = require('../src/images/dimensions');
const { validateImage } = require('../src/images/validate');
const { computeContentHash } = require('../src/images/content-hash');
const { averageHashPng, hammingDistance } = require('../src/images/perceptual-hash');
const { PlaceholderDetector } = require('../src/images/placeholder-detector');
const { selectPrimaryImage } = require('../src/images/role-selector');

const { solidColorPng } = require('./helpers/png-fixture');
const { makeGif, makeJpeg, makeWebpVp8x, makeAvif, makeSvg } = require('./helpers/other-image-fixtures');

// --- Magic-byte detection / format validation ---

test('JPEG magic-byte validation', () => {
  const jpeg = makeJpeg(100, 80);
  assert.equal(detectImageFormat(jpeg), 'jpeg');
  assert.equal(validateImage(jpeg).valid, true);
});

test('PNG magic-byte validation', () => {
  const png = solidColorPng(10, 10, [200, 50, 50]);
  assert.equal(detectImageFormat(png), 'png');
  assert.equal(validateImage(png).valid, true);
});

test('WebP validation', () => {
  const webp = makeWebpVp8x(64, 48);
  assert.equal(detectImageFormat(webp), 'webp');
  const result = validateImage(webp);
  assert.equal(result.valid, true);
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);
});

test('AVIF validation: format is recognized (dimension parsing is a disclosed, unimplemented gap)', () => {
  const avif = makeAvif();
  assert.equal(detectImageFormat(avif), 'avif');
  const result = validateImage(avif);
  assert.equal(result.valid, true);
  assert.equal(result.width, null);
});

test('GIF validation', () => {
  const gif = makeGif(20, 20);
  assert.equal(detectImageFormat(gif), 'gif');
  const result = validateImage(gif);
  assert.equal(result.valid, true);
  assert.equal(result.width, 20);
  assert.equal(result.height, 20);
});

test('SVG rejection', () => {
  const svg = makeSvg();
  assert.equal(detectImageFormat(svg), 'svg');
  const result = validateImage(svg);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'SVG_REJECTED');
});

test('unrecognized/garbage bytes are rejected, not guessed at', () => {
  const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
  assert.equal(detectImageFormat(garbage), null);
  assert.equal(validateImage(garbage).valid, false);
  assert.equal(validateImage(garbage).reason, 'UNRECOGNIZED_FORMAT');
});

// --- Corrupt / truncated ---

test('corrupt image rejection: a PNG missing its IEND chunk is rejected', () => {
  const png = solidColorPng(10, 10, [1, 2, 3]);
  const corrupt = png.slice(0, png.length - 12); // chop off the IEND chunk
  const result = validateImage(corrupt);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CORRUPT_OR_TRUNCATED');
});

test('truncated image rejection: a JPEG cut off mid-stream (no EOI) is rejected', () => {
  const jpeg = makeJpeg(50, 50);
  const truncated = jpeg.slice(0, jpeg.length - 5);
  const result = validateImage(truncated);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CORRUPT_OR_TRUNCATED');
});

test('truncated image rejection: a GIF missing its trailer byte is rejected', () => {
  const gif = makeGif(10, 10);
  const truncated = gif.slice(0, gif.length - 1);
  const result = validateImage(truncated);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CORRUPT_OR_TRUNCATED');
});

// --- Dimension limits ---

test('undersized image rejection', () => {
  const tinyPng = solidColorPng(4, 4, [10, 10, 10]);
  const result = validateImage(tinyPng, { minWidth: 100, minHeight: 100 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'BELOW_MINIMUM_DIMENSIONS');
});

test('oversized/pixel-budget rejection', () => {
  const png = solidColorPng(2000, 2000, [5, 5, 5]); // 4,000,000 px
  const result = validateImage(png, { maxPixels: 1_000_000 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'EXCEEDS_PIXEL_BUDGET');
});

test('a file over the maximum byte-size limit is rejected before any parsing', () => {
  const png = solidColorPng(10, 10, [1, 1, 1]);
  const result = validateImage(png, { maxBytes: 10 });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'FILE_TOO_LARGE');
});

test('an image within all configured limits is accepted', () => {
  const png = solidColorPng(300, 300, [80, 80, 80]);
  const result = validateImage(png, { minWidth: 100, minHeight: 100, maxPixels: 1_000_000, maxBytes: 1_000_000 });
  assert.equal(result.valid, true);
  assert.equal(result.width, 300);
  assert.equal(result.height, 300);
});

// --- Content-hash deduplication ---

test('content-hash deduplication: identical bytes hash identically', () => {
  const a = solidColorPng(10, 10, [1, 2, 3]);
  const b = Buffer.from(a); // exact copy
  assert.equal(computeContentHash(a), computeContentHash(b));
});

test('content-hash deduplication: different bytes hash differently', () => {
  const a = solidColorPng(10, 10, [1, 2, 3]);
  const b = solidColorPng(10, 10, [4, 5, 6]);
  assert.notEqual(computeContentHash(a), computeContentHash(b));
});

// --- Perceptual-hash deduplication (PNG only, "where practical") ---

test('perceptual-hash deduplication: visually similar PNGs (near-identical solid colors) hash close together', () => {
  const a = solidColorPng(64, 64, [100, 100, 100]);
  const b = solidColorPng(64, 64, [102, 101, 99]); // imperceptibly different
  const hashA = averageHashPng(a);
  const hashB = averageHashPng(b);
  assert.equal(typeof hashA, 'string');
  assert.equal(hammingDistance(hashA, hashB), 0, 'near-identical solid colors should hash identically under aHash');
});

test('perceptual-hash deduplication: a genuinely different image (half black, half white) hashes far apart from a solid gray one', () => {
  const gray = solidColorPng(64, 64, [128, 128, 128]);
  const splitBlackWhite = require('./helpers/png-fixture').makePng(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
  const distance = hammingDistance(averageHashPng(gray), averageHashPng(splitBlackWhite));
  assert.ok(distance > 10, `expected a large Hamming distance for visually distinct images, got ${distance}`);
});

test('perceptual-hash deduplication: unsupported formats return null rather than a fabricated hash', () => {
  assert.equal(averageHashPng(makeJpeg(50, 50)), null);
});

test('cross-source image deduplication: the same content hash lets two different (source, product) references point at one stored image', () => {
  // This is exercised at the repository/DB layer (image-repository.test.js
  // for the live-database integration test); here we confirm the hash
  // that makes it possible is itself source/product-agnostic.
  const bytes = solidColorPng(20, 20, [7, 7, 7]);
  const hashFromSourceA = computeContentHash(bytes);
  const hashFromSourceB = computeContentHash(Buffer.from(bytes));
  assert.equal(hashFromSourceA, hashFromSourceB);
});

// --- Placeholder detection ---

test('placeholder detection: a registered content hash for a source is flagged as a placeholder', () => {
  const detector = new PlaceholderDetector();
  const placeholderBytes = solidColorPng(1, 1, [255, 255, 255]);
  const hash = computeContentHash(placeholderBytes);
  detector.registerContentHash('wine-com', hash);

  assert.equal(detector.isPlaceholder({ sourceName: 'wine-com', contentHash: hash }), true);
  assert.equal(detector.isPlaceholder({ sourceName: 'total-wine', contentHash: hash }), false, 'a placeholder registered for one source must not flag another source');
});

test('placeholder detection: a registered URL pattern for a source is flagged as a placeholder', () => {
  const detector = new PlaceholderDetector();
  detector.registerUrlPattern('vivino', /no-image-available/i);
  assert.equal(
    detector.isPlaceholder({ sourceName: 'vivino', imageUrl: 'https://images.vivino.com/no-image-available.png' }),
    true
  );
  assert.equal(
    detector.isPlaceholder({ sourceName: 'vivino', imageUrl: 'https://images.vivino.com/real-bottle-photo.jpg' }),
    false
  );
});

test('placeholder detection: an image never registered anywhere is not a placeholder', () => {
  const detector = new PlaceholderDetector();
  assert.equal(detector.isPlaceholder({ sourceName: 'wine-com', contentHash: 'deadbeef', imageUrl: 'https://x/real.jpg' }), false);
});

// --- Role assignment / primary image selection ---

test('image role assignment and primary-image selection: hero outranks packaging/label/lifestyle', () => {
  const candidates = [
    { role: 'lifestyle', isPlaceholder: false, url: 'lifestyle.jpg' },
    { role: 'label', isPlaceholder: false, url: 'label.jpg' },
    { role: 'hero', isPlaceholder: false, url: 'hero.jpg' },
    { role: 'packaging', isPlaceholder: false, url: 'packaging.jpg' }
  ];
  const primary = selectPrimaryImage(candidates);
  assert.equal(primary.role, 'hero');
});

test('primary-image selection: placeholders are never selected, even if no real image has a preferred role', () => {
  const candidates = [
    { role: 'hero', isPlaceholder: true, url: 'placeholder.jpg' },
    { role: 'lifestyle', isPlaceholder: false, url: 'lifestyle.jpg' }
  ];
  const primary = selectPrimaryImage(candidates);
  assert.equal(primary.url, 'lifestyle.jpg');
});

test('primary-image selection: exactly one primary image is chosen when multiple real images exist', () => {
  const candidates = [
    { role: 'hero', isPlaceholder: false, url: 'hero-1.jpg' },
    { role: 'hero', isPlaceholder: false, url: 'hero-2.jpg' },
    { role: 'label', isPlaceholder: false, url: 'label.jpg' }
  ];
  const primary = selectPrimaryImage(candidates);
  assert.equal(primary.url, 'hero-1.jpg');
});

test('primary-image selection: an all-placeholder candidate set selects no primary image', () => {
  const candidates = [{ role: 'hero', isPlaceholder: true, url: 'placeholder.jpg' }];
  assert.equal(selectPrimaryImage(candidates), null);
});

test('primary-image selection: an empty candidate set selects no primary image', () => {
  assert.equal(selectPrimaryImage([]), null);
});
