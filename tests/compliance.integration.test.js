const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

let compliance;
if (isDatabaseConfigured()) {
  compliance = require('../src/compliance/compliance-repository');
}

const TEST_SOURCE = 'wo-compliance-test-source';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM source_compliance WHERE source_name = $1;', [TEST_SOURCE]);
}

test('setup: clean slate', { skip }, async () => {
  await cleanup();
});

test('a new source defaults to honoring robots.txt and NOT being production-enabled (honest default, nothing fabricated)', { skip }, async () => {
  const row = await compliance.upsertSourceCompliance(TEST_SOURCE, {});
  assert.equal(row.robotsTxtHonored, true);
  assert.equal(row.robotsTxtOverride, false);
  assert.equal(row.tosReviewStatus, 'not_reviewed');
  assert.equal(row.enabledInProduction, false);
  assert.equal(row.imageRedistributionStatus, 'internal_use_only');
});

test('a source is not production-ready until robots.txt policy + ToS review + explicit enable all align', { skip }, async () => {
  assert.equal(await compliance.isSourceProductionReady(TEST_SOURCE), false);

  await compliance.upsertSourceCompliance(TEST_SOURCE, { tosReviewStatus: 'approved' });
  assert.equal(await compliance.isSourceProductionReady(TEST_SOURCE), false, 'ToS approved alone is not enough');

  await compliance.upsertSourceCompliance(TEST_SOURCE, { enabledInProduction: true });
  assert.equal(await compliance.isSourceProductionReady(TEST_SOURCE), true, 'robots.txt honored (default) + ToS approved + enabled = ready');
});

test('a robots.txt override without both a reason and a sign-off is rejected', { skip }, async () => {
  await assert.rejects(() => compliance.upsertSourceCompliance(TEST_SOURCE, { robotsTxtOverride: true }));
  await assert.rejects(() => compliance.upsertSourceCompliance(TEST_SOURCE, { robotsTxtOverride: true, robotsTxtOverrideReason: 'x' }));
});

test('a robots.txt override with a reason and sign-off is recorded and timestamped', { skip }, async () => {
  const row = await compliance.upsertSourceCompliance(TEST_SOURCE, {
    robotsTxtOverride: true,
    robotsTxtOverrideReason: 'Source explicitly permits this specific path via written agreement (test).',
    robotsTxtOverrideSignedOffBy: 'compliance-officer@example.com'
  });
  assert.equal(row.robotsTxtOverride, true);
  assert.equal(row.robotsTxtOverrideSignedOffBy, 'compliance-officer@example.com');
  assert.ok(row.robotsTxtOverrideSignedOffAt);
});

test('image redistribution status defaults to internal-use-only, never redistributable by default', { skip }, async () => {
  const row = await compliance.getSourceCompliance(TEST_SOURCE);
  assert.equal(row.imageRedistributionStatus, 'internal_use_only');
});

test('seedDefaultSources creates rows for missing sources without overwriting existing ones', { skip }, async () => {
  const pool = getPool();
  await pool.query('DELETE FROM source_compliance WHERE source_name = $1;', ['wo-compliance-test-seed']);

  await compliance.seedDefaultSources([TEST_SOURCE, 'wo-compliance-test-seed']);

  // Existing row (which we deliberately modified above with an override) must be untouched.
  const existing = await compliance.getSourceCompliance(TEST_SOURCE);
  assert.equal(existing.robotsTxtOverride, true);

  const seeded = await compliance.getSourceCompliance('wo-compliance-test-seed');
  assert.ok(seeded);
  assert.equal(seeded.enabledInProduction, false);

  await pool.query('DELETE FROM source_compliance WHERE source_name = $1;', ['wo-compliance-test-seed']);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
