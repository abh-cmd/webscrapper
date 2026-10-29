// Startup configuration validation. Called once at process start (see
// src/index.js, src/batch/run-batch-cli.js) so a misconfigured deployment
// fails fast with an actionable message instead of failing confusingly
// three stages into a crawl. Returns { valid, errors, warnings } rather
// than throwing directly, so callers can decide how strict to be (a test
// harness may want to inspect errors rather than crash).
//
// Never logs or returns the actual value of a secret — only whether it is
// present/well-formed, and (for a malformed value) which part is wrong,
// never the value itself.

function redactedPresence(value) {
  return value ? `set (${value.length} chars)` : 'not set';
}

function validateDatabaseUrl(env, errors) {
  if (!env.DATABASE_URL) {
    errors.push('DATABASE_URL is not set — the system cannot persist anything without it. Set it to a postgres:// connection string.');
    return;
  }
  try {
    const parsed = new URL(env.DATABASE_URL);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      errors.push(`DATABASE_URL has an unexpected protocol "${parsed.protocol}" — expected postgres:// or postgresql://.`);
    }
    if (!parsed.hostname) {
      errors.push('DATABASE_URL is missing a hostname.');
    }
  } catch (error) {
    errors.push(`DATABASE_URL is not a valid URL: ${error.message}`);
  }
}

function validateAiConfig(env, errors, warnings) {
  const provider = env.AI_PROVIDER || 'deterministic-test';
  if (!['deterministic-test', 'http', 'none'].includes(provider)) {
    errors.push(`AI_PROVIDER="${provider}" is not recognized. Expected "deterministic-test", "http", or "none".`);
    return;
  }
  if (provider === 'http') {
    const missing = ['AI_API_BASE_URL', 'AI_API_KEY'].filter((key) => !env[key]);
    if (missing.length > 0) {
      errors.push(`AI_PROVIDER=http requires ${missing.join(' and ')} to be set (${missing.map((k) => `${k}: ${redactedPresence(env[k])}`).join(', ')}). Real AI calls will fail without them.`);
    }
    if (env.AI_API_BASE_URL) {
      try { new URL(env.AI_API_BASE_URL); } catch (error) { errors.push(`AI_API_BASE_URL is not a valid URL: ${error.message}`); }
    }
  }
  if (env.AI_REQUEST_TIMEOUT_MS !== undefined) {
    const n = Number(env.AI_REQUEST_TIMEOUT_MS);
    if (!Number.isFinite(n) || n <= 0) errors.push(`AI_REQUEST_TIMEOUT_MS="${env.AI_REQUEST_TIMEOUT_MS}" must be a positive number of milliseconds.`);
  }
  if (env.AI_MAX_RETRIES !== undefined) {
    const n = Number(env.AI_MAX_RETRIES);
    if (!Number.isInteger(n) || n < 0) errors.push(`AI_MAX_RETRIES="${env.AI_MAX_RETRIES}" must be a non-negative integer.`);
  }
  if (provider !== 'http') {
    warnings.push(`AI_PROVIDER="${provider}" — no real AI calls will be made (this is the safe default; set AI_PROVIDER=http with real credentials to enable live AI).`);
  }
}

function validateProxyConfig(env, errors, warnings) {
  if (env.PROXY_LIST) {
    try {
      const parsed = JSON.parse(env.PROXY_LIST);
      if (!Array.isArray(parsed)) {
        errors.push('PROXY_LIST is set but is not a JSON array.');
      } else {
        parsed.forEach((entry, index) => {
          if (!entry.id || !entry.url) errors.push(`PROXY_LIST[${index}] is missing a required "id" or "url" field.`);
          if (entry.url) {
            try { new URL(entry.url); } catch (error) { errors.push(`PROXY_LIST[${index}].url is not a valid URL.`); }
          }
        });
      }
    } catch (error) {
      errors.push(`PROXY_LIST is set but is not valid JSON: ${error.message}`);
    }
  } else {
    warnings.push('PROXY_LIST is not set — the crawler will run in direct mode (no proxy) for every source. This is safe but means no residential/datacenter IP rotation is available.');
  }

  for (const key of ['PROXY_COOLDOWN_MS', 'PROXY_EJECT_AFTER_CONSECUTIVE_FAILURES', 'PROXY_EJECT_AFTER_BLOCK_COUNT']) {
    if (env[key] !== undefined && (Number.isNaN(Number(env[key])) || Number(env[key]) < 0)) {
      errors.push(`${key}="${env[key]}" must be a non-negative number.`);
    }
  }
}

function validateStorageConfig(env, errors) {
  if (env.IMAGE_STORAGE_ROOT !== undefined && env.IMAGE_STORAGE_ROOT.trim() === '') {
    errors.push('IMAGE_STORAGE_ROOT is set but empty — unset it entirely to use the default (./output/images), or provide a real path.');
  }
  if (env.IMAGE_RETENTION_DAYS !== undefined) {
    const n = Number(env.IMAGE_RETENTION_DAYS);
    if (!Number.isFinite(n) || n <= 0) errors.push(`IMAGE_RETENTION_DAYS="${env.IMAGE_RETENTION_DAYS}" must be a positive number of days.`);
  }
}

function validateSchedulerConfig(env, errors, warnings) {
  if (env.SCHEDULE_INTERVAL_MINUTES !== undefined) {
    const n = Number(env.SCHEDULE_INTERVAL_MINUTES);
    if (!Number.isFinite(n) || n <= 0) errors.push(`SCHEDULE_INTERVAL_MINUTES="${env.SCHEDULE_INTERVAL_MINUTES}" must be a positive number.`);
    if (env.SCHEDULE_BATCH_FILE === undefined) errors.push('SCHEDULE_INTERVAL_MINUTES is set but SCHEDULE_BATCH_FILE is not — the scheduler needs to know which product-input file to run.');
  } else {
    warnings.push('SCHEDULE_INTERVAL_MINUTES is not set — the in-process scheduler will not run (refresh cadence is an open business decision; see README). Use an external scheduler, or set this to enable one.');
  }
}

function validateComplianceConfig(env, errors, warnings) {
  if (env.ROBOTS_TXT_GLOBAL_OVERRIDE === 'true') {
    errors.push('ROBOTS_TXT_GLOBAL_OVERRIDE=true would disable robots.txt enforcement for every source at once — this is not supported. Overrides must be recorded per-source with a reason and a signer via source_compliance (see src/compliance/compliance-repository.js).');
  }
}

function validateBudgetConfig(env, errors) {
  for (const key of Object.keys(env)) {
    if (/^MAX_REQUESTS_PER_(SOURCE_)?(DAY|MONTH)$/.test(key) || key === 'MAX_REQUESTS_PER_SOURCE_PER_DAY') {
      const n = Number(env[key]);
      if (!Number.isFinite(n) || n <= 0) errors.push(`${key}="${env[key]}" must be a positive number.`);
    }
  }
}

function validateStartupConfig(env = process.env) {
  const errors = [];
  const warnings = [];

  validateDatabaseUrl(env, errors);
  validateAiConfig(env, errors, warnings);
  validateProxyConfig(env, errors, warnings);
  validateStorageConfig(env, errors);
  validateSchedulerConfig(env, errors, warnings);
  validateComplianceConfig(env, errors, warnings);
  validateBudgetConfig(env, errors);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateStartupConfig };
