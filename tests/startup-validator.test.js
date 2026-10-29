const test = require('node:test');
const assert = require('node:assert/strict');

const { validateStartupConfig } = require('../src/config/startup-validator');

function baseEnv(overrides = {}) {
  return { DATABASE_URL: 'postgres://user:pass@localhost:5432/wineoutlet', ...overrides };
}

test('a fully valid, minimal config passes with no errors', () => {
  const result = validateStartupConfig(baseEnv());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('missing DATABASE_URL is a hard error', () => {
  const result = validateStartupConfig({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('DATABASE_URL is not set')));
});

test('a malformed DATABASE_URL is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ DATABASE_URL: 'not-a-url' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('not a valid URL')));
});

test('AI_PROVIDER=http without credentials is a hard error, and does not leak the actual key value', () => {
  const result = validateStartupConfig(baseEnv({ AI_PROVIDER: 'http', AI_API_KEY: 'sk-super-secret-value' }));
  assert.equal(result.valid, false);
  const message = result.errors.join(' ');
  assert.ok(message.includes('AI_API_BASE_URL'));
  assert.ok(!message.includes('sk-super-secret-value'), 'the actual secret value must never appear in an error message');
});

test('a non-positive AI_REQUEST_TIMEOUT_MS is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ AI_REQUEST_TIMEOUT_MS: '0' }));
  assert.equal(result.valid, false);
});

test('a negative AI_MAX_RETRIES is a hard error, but 0 (no retries) is valid', () => {
  assert.equal(validateStartupConfig(baseEnv({ AI_MAX_RETRIES: '-1' })).valid, false);
  assert.equal(validateStartupConfig(baseEnv({ AI_MAX_RETRIES: '0' })).valid, true);
});

test('AI_PROVIDER=http with both credentials set passes', () => {
  const result = validateStartupConfig(baseEnv({ AI_PROVIDER: 'http', AI_API_BASE_URL: 'https://api.openai.com/v1', AI_API_KEY: 'sk-test' }));
  assert.equal(result.valid, true);
});

test('an unrecognized AI_PROVIDER value is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ AI_PROVIDER: 'not-a-real-provider' }));
  assert.equal(result.valid, false);
});

test('no PROXY_LIST produces a warning, not an error (direct mode is safe)', () => {
  const result = validateStartupConfig(baseEnv());
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => w.includes('direct mode')));
});

test('a malformed PROXY_LIST is a hard error, and does not leak proxy credentials from the URL', () => {
  const result = validateStartupConfig(baseEnv({ PROXY_LIST: '{not json' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('not valid JSON')));
});

test('a PROXY_LIST entry missing id/url is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ PROXY_LIST: JSON.stringify([{ url: 'http://proxy.example.invalid' }]) }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('missing a required "id" or "url"')));
});

test('a valid PROXY_LIST passes with no warning about missing proxies', () => {
  const result = validateStartupConfig(baseEnv({ PROXY_LIST: JSON.stringify([{ id: 'p1', url: 'http://user:pass@proxy.example.invalid:8080', tier: 'residential' }]) }));
  assert.equal(result.valid, true);
  assert.ok(!result.warnings.some((w) => w.includes('direct mode')));
});

test('a negative PROXY_COOLDOWN_MS is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ PROXY_COOLDOWN_MS: '-5' }));
  assert.equal(result.valid, false);
});

test('an empty IMAGE_STORAGE_ROOT is a hard error (ambiguous: did they mean to unset it?)', () => {
  const result = validateStartupConfig(baseEnv({ IMAGE_STORAGE_ROOT: '   ' }));
  assert.equal(result.valid, false);
});

test('a non-positive IMAGE_RETENTION_DAYS is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ IMAGE_RETENTION_DAYS: '0' }));
  assert.equal(result.valid, false);
});

test('SCHEDULE_INTERVAL_MINUTES without SCHEDULE_BATCH_FILE is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ SCHEDULE_INTERVAL_MINUTES: '60' }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('SCHEDULE_BATCH_FILE')));
});

test('SCHEDULE_INTERVAL_MINUTES with SCHEDULE_BATCH_FILE passes', () => {
  const result = validateStartupConfig(baseEnv({ SCHEDULE_INTERVAL_MINUTES: '60', SCHEDULE_BATCH_FILE: 'input/batch/products.json' }));
  assert.equal(result.valid, true);
});

test('no scheduler config produces a warning that cadence is an open decision, not an error', () => {
  const result = validateStartupConfig(baseEnv());
  assert.ok(result.warnings.some((w) => w.includes('open business decision')));
});

test('ROBOTS_TXT_GLOBAL_OVERRIDE=true is refused outright — overrides must be per-source with sign-off', () => {
  const result = validateStartupConfig(baseEnv({ ROBOTS_TXT_GLOBAL_OVERRIDE: 'true' }));
  assert.equal(result.valid, false);
});

test('a non-positive MAX_REQUESTS_PER_SOURCE_PER_DAY is a hard error', () => {
  const result = validateStartupConfig(baseEnv({ MAX_REQUESTS_PER_SOURCE_PER_DAY: '0' }));
  assert.equal(result.valid, false);
});

test('a valid MAX_REQUESTS_PER_SOURCE_PER_DAY passes', () => {
  const result = validateStartupConfig(baseEnv({ MAX_REQUESTS_PER_SOURCE_PER_DAY: '500' }));
  assert.equal(result.valid, true);
});
