const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');
const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

const { createScheduler, createSchedulerFromEnv, runOnce } = require('../src/scheduler/scheduler');

const BATCH_FILE = path.join(__dirname, '..', 'input', 'batch', 'sample-batch.json');

async function cleanup(pool) {
  await pool.query("DELETE FROM scheduled_runs WHERE batch_file LIKE '%sample-batch.json' OR batch_file = 'does-not-exist.json';");
  await pool.query("DELETE FROM product_staging WHERE item_number = 'WO-10001';");
  await pool.query("DELETE FROM crawl_jobs WHERE item_number = 'WO-10001';");
}

test('createSchedulerFromEnv returns null when cadence is not configured (an open business decision, not assumed)', () => {
  assert.equal(createSchedulerFromEnv({}), null);
  assert.equal(createSchedulerFromEnv({ SCHEDULE_INTERVAL_MINUTES: '60' }), null, 'batch file must also be set');
});

test('createSchedulerFromEnv throws on a non-positive interval', () => {
  assert.throws(() => createSchedulerFromEnv({ SCHEDULE_INTERVAL_MINUTES: '0', SCHEDULE_BATCH_FILE: BATCH_FILE }));
});

test('createSchedulerFromEnv builds a real scheduler when both are set', () => {
  const scheduler = createSchedulerFromEnv({ SCHEDULE_INTERVAL_MINUTES: '60', SCHEDULE_BATCH_FILE: BATCH_FILE });
  assert.ok(scheduler);
  assert.equal(typeof scheduler.start, 'function');
  scheduler.stop();
});

test('LIVE: a real tick enqueues, drains, and records a completed run with real counts', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); });

  const result = await runOnce({ batchFile: BATCH_FILE, workerState: { running: false } });
  assert.equal(result.status, 'completed');
  assert.equal(result.itemsEnqueued, 1);

  const row = await pool.query('SELECT * FROM scheduled_runs WHERE id = $1;', [result.runId]);
  assert.equal(row.rows[0].status, 'completed');
  assert.equal(row.rows[0].items_enqueued, 1);
  assert.ok(row.rows[0].finished_at);
}, { timeout: 20000 });

test('LIVE: overlapping ticks are prevented — a run already in progress causes the next tick to record skipped_overlap', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); });

  const workerState = { running: true }; // simulate: a run is already in progress
  const result = await runOnce({ batchFile: BATCH_FILE, workerState });
  assert.equal(result.status, 'skipped_overlap');

  const row = await pool.query("SELECT * FROM scheduled_runs WHERE batch_file LIKE '%sample-batch.json' AND status = 'skipped_overlap' ORDER BY id DESC LIMIT 1;");
  assert.equal(row.rows.length, 1);
}, { timeout: 10000 });

test('LIVE: a failed tick (bad batch file) is recorded, and does not prevent the next tick from succeeding', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); });

  const workerState = { running: false };
  const failure = await runOnce({ batchFile: 'does-not-exist.json', workerState });
  assert.equal(failure.status, 'failed');
  assert.ok(failure.error);
  assert.equal(workerState.running, false, 'the mutex must be released even after a failure — otherwise every future tick would report skipped_overlap forever');

  const failedRow = await pool.query("SELECT status, error_message FROM scheduled_runs WHERE batch_file = 'does-not-exist.json' ORDER BY id DESC LIMIT 1;");
  assert.equal(failedRow.rows[0].status, 'failed');
  assert.ok(failedRow.rows[0].error_message);

  const recovery = await runOnce({ batchFile: BATCH_FILE, workerState });
  assert.equal(recovery.status, 'completed', 'recovery: a subsequent valid tick must still succeed');
}, { timeout: 20000 });

test('LIVE: start()/stop() actually fires runOnce on a real (short) interval, and stop() actually prevents further ticks', { skip }, async (t) => {
  const pool = getPool();
  await cleanup(pool);
  t.after(async () => { await cleanup(pool); await closePool(); });

  const scheduler = createScheduler({ batchFile: BATCH_FILE, intervalMs: 300, runImmediately: true });
  scheduler.start();

  await new Promise((resolve) => setTimeout(resolve, 900)); // enough real time for 2-3 ticks to have STARTED
  scheduler.stop();
  assert.equal(scheduler.isRunning(), false);

  // A tick that started before stop() (e.g. a real crawl, ~0.5-1.5s) may
  // still be mid-flight the instant stop() returns — wait for anything
  // already in progress to settle before taking the "after stop" baseline,
  // so this test measures "did stop() start anything NEW", not "how fast
  // is Postgres."
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const countAfterSettling = await pool.query("SELECT count(*)::int AS n FROM scheduled_runs WHERE batch_file LIKE '%sample-batch.json';");
  const ticksObserved = countAfterSettling.rows[0].n;
  assert.ok(ticksObserved >= 2, `expected at least 2 real ticks in 900ms at a 300ms interval, observed ${ticksObserved}`);

  await new Promise((resolve) => setTimeout(resolve, 900)); // if stop() didn't work, a genuinely NEW tick would appear here
  const countAfterWaiting = await pool.query("SELECT count(*)::int AS n FROM scheduled_runs WHERE batch_file LIKE '%sample-batch.json';");
  assert.equal(countAfterWaiting.rows[0].n, ticksObserved, 'no further ticks should occur after stop()');
}, { timeout: 20000 });
