const fs = require('node:fs');
const { getPool } = require('../db/connection');
const { runBatch } = require('../batch/batch-runner');

// A minimal, schedule-agnostic in-process scheduler. Refresh cadence is an
// explicitly OPEN business decision (the requirements document's own
// "Open items" list: "Confirm refresh cadence (daily/weekly)") — this
// module invents no cadence; SCHEDULE_INTERVAL_MINUTES must be set for
// start() to do anything, and any cadence (minutes, hours, days — anything
// expressible as a minute count) can be configured once decided. Overlap
// protection (never run two batches at once) and run history
// (scheduled_runs) are not open decisions — they're baseline correctness,
// implemented unconditionally.

async function runOnce({ batchFile, workerState }) {
  const pool = getPool();

  if (workerState.running) {
    await pool.query(
      `INSERT INTO scheduled_runs (batch_file, status, started_at, finished_at)
       VALUES ($1, 'skipped_overlap', now(), now());`,
      [batchFile]
    );
    return { status: 'skipped_overlap' };
  }

  workerState.running = true;
  const runRow = await pool.query(
    `INSERT INTO scheduled_runs (batch_file, status) VALUES ($1, 'running') RETURNING id;`,
    [batchFile]
  );
  const runId = runRow.rows[0].id;

  try {
    const productInputs = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    if (!Array.isArray(productInputs)) throw new Error(`${batchFile} must contain a JSON array of product inputs.`);

    const results = await runBatch(productInputs);
    const staged = results.filter((r) => r.status === 'staged').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    await pool.query(
      `UPDATE scheduled_runs SET status = 'completed', items_enqueued = $2, items_staged = $3, items_failed = $4, finished_at = now() WHERE id = $1;`,
      [runId, productInputs.length, staged, failed]
    );
    return { status: 'completed', runId, itemsEnqueued: productInputs.length, itemsStaged: staged, itemsFailed: failed };
  } catch (error) {
    await pool.query(
      `UPDATE scheduled_runs SET status = 'failed', error_message = $2, finished_at = now() WHERE id = $1;`,
      [runId, error.message]
    );
    return { status: 'failed', runId, error: error.message };
  } finally {
    workerState.running = false;
  }
}

// intervalMs is injectable so tests never have to wait on a real
// wall-clock interval; production code goes through
// createSchedulerFromEnv() below, which resolves it from
// SCHEDULE_INTERVAL_MINUTES.
function createScheduler({ batchFile, intervalMs, runImmediately = false }) {
  if (!batchFile) throw new Error('createScheduler requires a batchFile.');
  if (!(intervalMs > 0)) throw new Error('createScheduler requires a positive intervalMs.');

  const workerState = { running: false };
  let timer = null;
  let stopped = false;

  function tick() {
    // clearInterval() only prevents FUTURE firings — a callback that has
    // already fired and is sitting in the event-loop queue at the moment
    // stop() runs will still execute. This flag is the actual guard
    // against that: checked synchronously, first thing, so a tick that
    // sneaks in after stop() does nothing rather than racing a real DB
    // write against the "no more ticks after stop()" guarantee.
    if (stopped) return;
    runOnce({ batchFile, workerState }).catch((error) => console.error('[scheduler] tick failed:', error.message));
  }

  function start() {
    if (timer) return; // already started — starting twice is a no-op, not an error
    stopped = false;
    if (runImmediately) tick();
    timer = setInterval(tick, intervalMs);
    // Deliberately NOT unref'd: the whole point of the scheduler CLI
    // (src/scheduler/run-scheduler-cli.js) is a long-running process that
    // stays alive on this timer. Callers that don't want that (tests) must
    // call stop() themselves — every test in
    // tests/scheduler.integration.test.js does.
  }

  function stop() {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function isRunning() {
    return timer !== null;
  }

  return { start, stop, isRunning, runOnce: () => runOnce({ batchFile, workerState }) };
}

// The production entry point: builds a scheduler from
// SCHEDULE_INTERVAL_MINUTES / SCHEDULE_BATCH_FILE, or returns null if
// either is unset — cadence is opt-in, never assumed.
function createSchedulerFromEnv(env = process.env) {
  if (env.SCHEDULE_INTERVAL_MINUTES === undefined || env.SCHEDULE_BATCH_FILE === undefined) return null;
  const minutes = Number(env.SCHEDULE_INTERVAL_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error(`SCHEDULE_INTERVAL_MINUTES="${env.SCHEDULE_INTERVAL_MINUTES}" must be a positive number.`);
  return createScheduler({ batchFile: env.SCHEDULE_BATCH_FILE, intervalMs: minutes * 60 * 1000, runImmediately: true });
}

module.exports = { createScheduler, createSchedulerFromEnv, runOnce };
