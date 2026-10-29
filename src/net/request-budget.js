const { getPool } = require('../db/connection');

// Per-source daily request budget — "proxy budget" from the requirements
// document is an explicitly OPEN business decision (no number is specified
// anywhere), so this module invents no default limit: with no
// configuration, every check returns allowed:true and usage is merely
// counted. A limit only takes effect once the operator sets one via
// MAX_REQUESTS_PER_SOURCE_PER_DAY (or a per-source override — see
// loadBudgetConfigFromEnv). Persisted in Postgres (not memory) so a
// process restart does not silently reset the day's count.

function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function loadBudgetConfigFromEnv(env = process.env) {
  const globalMax = env.MAX_REQUESTS_PER_SOURCE_PER_DAY !== undefined ? Number(env.MAX_REQUESTS_PER_SOURCE_PER_DAY) : null;
  const perSource = {};
  const prefix = 'MAX_REQUESTS_PER_SOURCE_PER_DAY_';
  for (const key of Object.keys(env)) {
    if (key.startsWith(prefix)) {
      const sourceName = key.slice(prefix.length).toLowerCase().replace(/_/g, '-');
      perSource[sourceName] = Number(env[key]);
    }
  }
  return { globalMax, perSource };
}

function maxForSource(sourceName, config) {
  if (config.perSource[sourceName] !== undefined) return config.perSource[sourceName];
  return config.globalMax;
}

// Atomically records one request against today's counter for this source,
// and reports whether it was within budget. Recording happens regardless
// of the outcome (an over-budget request still "happened" and should count
// against tomorrow's fresh budget starting clean) — this is a usage
// counter, not a token bucket; a caller that wants to STOP rather than
// merely observe should check `withinBudget` and refuse to proceed.
async function recordAndCheckBudget(sourceName, { config = null, now = new Date() } = {}) {
  const resolvedConfig = config || loadBudgetConfigFromEnv();
  const max = maxForSource(sourceName, resolvedConfig);

  const pool = getPool();
  const day = todayUtc(now);
  const result = await pool.query(
    `INSERT INTO request_budget (source_name, day, request_count, updated_at)
     VALUES ($1, $2, 1, $3)
     ON CONFLICT (source_name, day) DO UPDATE SET
       request_count = request_budget.request_count + 1, updated_at = $3
     RETURNING request_count;`,
    [sourceName, day, now]
  );
  const count = result.rows[0].request_count;

  return {
    sourceName,
    day,
    count,
    max,
    withinBudget: max === null || Number.isNaN(max) ? true : count <= max
  };
}

async function getBudgetUsage(sourceName, { now = new Date() } = {}) {
  const pool = getPool();
  const day = todayUtc(now);
  const result = await pool.query('SELECT request_count FROM request_budget WHERE source_name = $1 AND day = $2;', [sourceName, day]);
  return { sourceName, day, count: result.rows[0]?.request_count || 0 };
}

module.exports = { loadBudgetConfigFromEnv, recordAndCheckBudget, getBudgetUsage, todayUtc };
