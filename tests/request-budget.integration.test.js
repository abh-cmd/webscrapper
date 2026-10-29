const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

const SOURCE = 'wo-budget-test-source';

async function cleanup() {
  const pool = getPool();
  await pool.query('DELETE FROM request_budget WHERE source_name = $1;', [SOURCE]);
}

test('setup', { skip }, cleanup);

test('with no configured limit, usage is counted but always within budget', { skip }, async () => {
  const { recordAndCheckBudget } = require('../src/net/request-budget');
  const r1 = await recordAndCheckBudget(SOURCE, { config: { globalMax: null, perSource: {} } });
  const r2 = await recordAndCheckBudget(SOURCE, { config: { globalMax: null, perSource: {} } });
  assert.equal(r1.count, 1);
  assert.equal(r2.count, 2);
  assert.equal(r1.withinBudget, true);
  assert.equal(r2.withinBudget, true);
});

test('a configured global limit is enforced, and persists across separate calls (simulating a restart)', { skip }, async (t) => {
  await cleanup();
  const { recordAndCheckBudget, getBudgetUsage } = require('../src/net/request-budget');
  const config = { globalMax: 2, perSource: {} };

  const r1 = await recordAndCheckBudget(SOURCE, { config });
  const r2 = await recordAndCheckBudget(SOURCE, { config });
  const r3 = await recordAndCheckBudget(SOURCE, { config });

  assert.equal(r1.withinBudget, true);
  assert.equal(r2.withinBudget, true);
  assert.equal(r3.withinBudget, false, 'the 3rd request must exceed a limit of 2');

  const usage = await getBudgetUsage(SOURCE);
  assert.equal(usage.count, 3, 'usage read back fresh from Postgres, not from in-memory state');
});

test('a per-source override takes precedence over the global limit', { skip }, async () => {
  await cleanup();
  const { recordAndCheckBudget } = require('../src/net/request-budget');
  const config = { globalMax: 100, perSource: { [SOURCE]: 1 } };

  const r1 = await recordAndCheckBudget(SOURCE, { config });
  const r2 = await recordAndCheckBudget(SOURCE, { config });

  assert.equal(r1.withinBudget, true);
  assert.equal(r2.withinBudget, false, 'the per-source limit of 1 overrides the global limit of 100');
});

test('loadBudgetConfigFromEnv parses global and per-source env vars correctly', { skip: false }, () => {
  const { loadBudgetConfigFromEnv } = require('../src/net/request-budget');
  const config = loadBudgetConfigFromEnv({
    MAX_REQUESTS_PER_SOURCE_PER_DAY: '1000',
    MAX_REQUESTS_PER_SOURCE_PER_DAY_WINE_COM: '50'
  });
  assert.equal(config.globalMax, 1000);
  assert.equal(config.perSource['wine-com'], 50);
});

test('cleanup', { skip }, async () => {
  await cleanup();
  await closePool();
});
