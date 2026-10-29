const test = require('node:test');
const assert = require('node:assert/strict');

const { getProxyPoolOptions, describeProxyTiers } = require('../src/net/proxy-provider');

test('default provider (env-list) with no PROXY_LIST returns an empty proxy list', () => {
  const options = getProxyPoolOptions({});
  assert.deepEqual(options.proxies, []);
});

test('PROXY_PROVIDER=env-list reads PROXY_LIST exactly like the underlying config loader', () => {
  const env = { PROXY_LIST: JSON.stringify([{ id: 'p1', url: 'http://proxy.invalid:8080', tier: 'residential' }]) };
  const options = getProxyPoolOptions({ ...env, PROXY_PROVIDER: 'env-list' });
  assert.equal(options.proxies.length, 1);
  assert.equal(options.proxies[0].tier, 'residential');
});

test('PROXY_PROVIDER=none always returns an empty pool, even if PROXY_LIST is set', () => {
  const env = { PROXY_PROVIDER: 'none', PROXY_LIST: JSON.stringify([{ id: 'p1', url: 'http://proxy.invalid:8080' }]) };
  const options = getProxyPoolOptions(env);
  assert.deepEqual(options.proxies, []);
});

test('an unrecognized PROXY_PROVIDER throws rather than silently defaulting', () => {
  assert.throws(() => getProxyPoolOptions({ PROXY_PROVIDER: 'brightdata' }), /Unknown PROXY_PROVIDER/);
});

test('describeProxyTiers summarizes tier counts without exposing credentials', () => {
  const env = {
    PROXY_LIST: JSON.stringify([
      { id: 'p1', url: 'http://user:pass@proxy1.invalid:8080', tier: 'residential' },
      { id: 'p2', url: 'http://user:pass@proxy2.invalid:8080', tier: 'residential' },
      { id: 'p3', url: 'http://user:pass@proxy3.invalid:8080', tier: 'datacenter' }
    ])
  };
  const summary = describeProxyTiers(env);
  assert.deepEqual(summary, { residential: 2, datacenter: 1 });
  assert.ok(!JSON.stringify(summary).includes('user:pass'));
});
