const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');
const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

const { loadRetentionDaysFromEnv, findExpiredImages, cleanupExpiredImages } = require('../src/images/retention');
const { storeValidatedImage, addImageReference } = require('../src/images/image-store-repository');
const { solidColorPng } = require('./helpers/png-fixture');

async function cleanup(pool) {
  await pool.query("DELETE FROM image_references WHERE item_number LIKE 'WO-RETENTION-TEST-%';");
  await pool.query("DELETE FROM images WHERE first_seen_source_url LIKE '%retention-test%';");
}

test('loadRetentionDaysFromEnv: unset means disabled, invalid values throw', () => {
  assert.equal(loadRetentionDaysFromEnv({}), null);
  assert.throws(() => loadRetentionDaysFromEnv({ IMAGE_RETENTION_DAYS: '0' }));
  assert.throws(() => loadRetentionDaysFromEnv({ IMAGE_RETENTION_DAYS: 'not-a-number' }));
  assert.equal(loadRetentionDaysFromEnv({ IMAGE_RETENTION_DAYS: '30' }), 30);
});

test('with no retention configured, cleanup is a genuine no-op', { skip }, async () => {
  const result = await cleanupExpiredImages({ retentionDays: null });
  assert.equal(result.enabled, false);
  assert.deepEqual(result.deleted, []);
});

test('LIVE: an old, unreferenced image is found as expired; a recent one and a referenced one are not', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); await closePool(); });

  const oldUnreferenced = await storeValidatedImage(solidColorPng(60, 60, [10, 20, 30]), { sourceUrl: 'https://example.invalid/retention-test-old-unreferenced.png' });
  const recentUnreferenced = await storeValidatedImage(solidColorPng(61, 61, [11, 21, 31]), { sourceUrl: 'https://example.invalid/retention-test-recent-unreferenced.png' });
  const oldButReferenced = await storeValidatedImage(solidColorPng(62, 62, [12, 22, 32]), { sourceUrl: 'https://example.invalid/retention-test-old-referenced.png' });
  await addImageReference({ imageId: oldButReferenced.image.id, itemNumber: 'WO-RETENTION-TEST-1', sourceName: 'example-source', sourceUrl: 'https://example.invalid/retention-test-old-referenced.png', role: 'hero' });

  // Backdate two of the three images' created_at directly (simulating age).
  await pool.query('UPDATE images SET created_at = now() - interval \'40 days\' WHERE id IN ($1, $2);', [oldUnreferenced.image.id, oldButReferenced.image.id]);

  const expired = await findExpiredImages({ retentionDays: 30 });
  const expiredIds = expired.map((e) => e.id);

  assert.ok(expiredIds.includes(oldUnreferenced.image.id), 'old + unreferenced must be expired');
  assert.ok(!expiredIds.includes(recentUnreferenced.image.id), 'recent + unreferenced must NOT be expired');
  assert.ok(!expiredIds.includes(oldButReferenced.image.id), 'old but still-referenced must NEVER be expired, regardless of age');
});

test('LIVE: dry run reports what would be deleted without touching anything', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); await closePool(); });

  const stored = await storeValidatedImage(solidColorPng(63, 63, [13, 23, 33]), { sourceUrl: 'https://example.invalid/retention-test-dryrun.png' });
  await pool.query('UPDATE images SET created_at = now() - interval \'40 days\' WHERE id = $1;', [stored.image.id]);

  const dryRunResult = await cleanupExpiredImages({ retentionDays: 30, dryRun: true });
  assert.equal(dryRunResult.dryRun, true);
  assert.ok(dryRunResult.deleted.some((d) => d.id === stored.image.id));

  const stillExists = await pool.query('SELECT id FROM images WHERE id = $1;', [stored.image.id]);
  assert.equal(stillExists.rows.length, 1, 'dry run must not actually delete the row');
  assert.equal(fs.existsSync(stored.image.storagePath), true, 'dry run must not actually delete the file');
});

test('LIVE: a real (non-dry-run) cleanup actually deletes the file and the row', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); await closePool(); });

  const stored = await storeValidatedImage(solidColorPng(64, 64, [14, 24, 34]), { sourceUrl: 'https://example.invalid/retention-test-real-delete.png' });
  await pool.query('UPDATE images SET created_at = now() - interval \'40 days\' WHERE id = $1;', [stored.image.id]);
  assert.equal(fs.existsSync(stored.image.storagePath), true);

  const result = await cleanupExpiredImages({ retentionDays: 30, dryRun: false });
  assert.ok(result.deleted.some((d) => d.id === stored.image.id));

  assert.equal(fs.existsSync(stored.image.storagePath), false, 'the file must actually be gone');
  const rowCheck = await pool.query('SELECT id FROM images WHERE id = $1;', [stored.image.id]);
  assert.equal(rowCheck.rows.length, 0, 'the row must actually be gone');
});
