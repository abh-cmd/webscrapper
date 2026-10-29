const test = require('node:test');
const assert = require('node:assert/strict');

const { loadDomainRateLimitsFromEnv, rateLimitForDomain, BUILT_IN_PRODUCTION_DEFAULTS } = require('../src/net/rate-limit-config');

test('the four production hostnames have a conservative built-in default with no configuration at all', () => {
  const config = loadDomainRateLimitsFromEnv({});
  assert.deepEqual(rateLimitForDomain('www.wine.com', config), { ratePerSecond: 1, burst: 1, concurrency: 1 });
  assert.deepEqual(rateLimitForDomain('www.totalwine.com', config), { ratePerSecond: 1, burst: 1, concurrency: 1 });
});

test('an arbitrary/local domain (e.g. a test fixture server) has NO built-in limit', () => {
  const config = loadDomainRateLimitsFromEnv({});
  assert.equal(rateLimitForDomain('127.0.0.1', config), null);
  assert.equal(rateLimitForDomain('localhost', config), null);
});

test('RATE_LIMIT_CONFIG can override a built-in production default', () => {
  const env = { RATE_LIMIT_CONFIG: JSON.stringify({ 'www.wine.com': { ratePerSecond: 5, burst: 5, concurrency: 2 } }) };
  const config = loadDomainRateLimitsFromEnv(env);
  assert.deepEqual(rateLimitForDomain('www.wine.com', config), { ratePerSecond: 5, burst: 5, concurrency: 2 });
});

test('RATE_LIMIT_CONFIG can add a limit for a domain with no built-in default', () => {
  const env = { RATE_LIMIT_CONFIG: JSON.stringify({ 'custom-source.example.com': { ratePerSecond: 2, concurrency: 1 } }) };
  const config = loadDomainRateLimitsFromEnv(env);
  assert.deepEqual(rateLimitForDomain('custom-source.example.com', config), { ratePerSecond: 2, concurrency: 1 });
});

test('malformed RATE_LIMIT_CONFIG JSON throws clearly rather than being silently ignored', () => {
  assert.throws(() => loadDomainRateLimitsFromEnv({ RATE_LIMIT_CONFIG: '{not json' }), /not valid JSON/);
});

test('a non-object RATE_LIMIT_CONFIG (e.g. an array) throws', () => {
  assert.throws(() => loadDomainRateLimitsFromEnv({ RATE_LIMIT_CONFIG: '[1,2,3]' }), /must be a JSON object/);
});

test('all four production hostnames (www and bare) are covered by the built-in defaults', () => {
  const hostnames = Object.keys(BUILT_IN_PRODUCTION_DEFAULTS);
  for (const source of ['wine.com', 'totalwine.com', 'wine-searcher.com', 'vivino.com']) {
    assert.ok(hostnames.includes(source), `expected a bare-domain default for ${source}`);
    assert.ok(hostnames.includes(`www.${source}`), `expected a www default for ${source}`);
  }
});
