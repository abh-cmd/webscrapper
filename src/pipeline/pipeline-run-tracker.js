// An in-memory record of what a live-pipeline UI run actually did, stage
// by stage. This is bookkeeping only — every call site that touches it
// (see run-full-pipeline.js) does so at a genuine transition point in a
// real backend call, never on a timer or a guess. Runs live for the life
// of the process; there is no persistence layer for this because it is
// operational/observability state for a single demonstration run, not a
// business record (compare: crawl_jobs, product_staging, which ARE
// persisted because they matter after a restart).

const runs = new Map();
const MAX_RUNS = 200;

function now() {
  return new Date().toISOString();
}

function createRun({ id, itemNumber, sourceUrl, mode, stageOrder }) {
  const stages = {};
  for (const key of stageOrder) {
    stages[key] = { status: 'pending', startedAt: null, completedAt: null, detail: null };
  }
  const run = {
    id,
    itemNumber,
    sourceUrl,
    mode,
    stageOrder,
    stages,
    status: 'running',
    logs: [],
    createdAt: now(),
    updatedAt: now(),
    result: null
  };
  runs.set(id, run);

  if (runs.size > MAX_RUNS) {
    const oldestKey = runs.keys().next().value;
    runs.delete(oldestKey);
  }

  return run;
}

function getRun(id) {
  return runs.get(id) || null;
}

function listRuns({ limit = 25 } = {}) {
  return Array.from(runs.values())
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit)
    .map((run) => ({
      id: run.id,
      itemNumber: run.itemNumber,
      sourceUrl: run.sourceUrl,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt
    }));
}

function appendLog(run, stage, message, level = 'info') {
  run.logs.push({ ts: now(), level, stage, message });
  run.updatedAt = now();
}

function setStage(run, stage, status, detail = null) {
  if (!run.stages[stage]) {
    // A stage name that isn't part of the declared order (shouldn't
    // happen with the wiring in run-full-pipeline.js) is recorded rather
    // than silently dropped, so nothing that actually happened is hidden.
    run.stages[stage] = { status: 'pending', startedAt: null, completedAt: null, detail: null };
  }
  const entry = run.stages[stage];
  entry.status = status;
  if (status === 'running' && !entry.startedAt) entry.startedAt = now();
  if (status === 'completed' || status === 'failed' || status === 'blocked') entry.completedAt = now();
  if (detail !== null) entry.detail = detail;
  run.updatedAt = now();
  appendLog(run, stage, `${stage.toUpperCase()} -> ${status.toUpperCase()}`, status === 'failed' ? 'error' : 'info');
}

// Any stage still 'pending' when the pipeline stops early (a real failure
// or block) is marked 'blocked' — it was genuinely never attempted, which
// is a different, honest thing from 'failed'.
function blockRemaining(run) {
  for (const stage of run.stageOrder) {
    if (run.stages[stage].status === 'pending') {
      run.stages[stage].status = 'blocked';
      run.stages[stage].completedAt = now();
    }
  }
}

function finish(run, status, result = null) {
  run.status = status;
  run.result = result;
  run.updatedAt = now();
  appendLog(run, 'pipeline', `Pipeline ${status}.`, status === 'failed' ? 'error' : 'info');
}

function makeOnStage(run) {
  // Adapts the coarse-grained {stage, status, detail} calls made from
  // inside crawler.js/request-handler.js/enrichment.js/etc. into tracker
  // updates. Passed as the `onStage` callback to those real functions.
  return (stage, status, detail) => setStage(run, stage, status, detail);
}

module.exports = {
  createRun,
  getRun,
  listRuns,
  appendLog,
  setStage,
  blockRemaining,
  finish,
  makeOnStage
};
