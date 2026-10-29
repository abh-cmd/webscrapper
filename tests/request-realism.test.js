const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UserAgentRotator,
  SessionHeaderBuilder,
  SessionCookieJar,
  validateRequestConfig
} = require('../src/net/request-realism');
const { loadProxiesFromEnv, loadProxyPoolOptionsFromEnv } = require('../src/net/proxy-config');

test('User-Agent rotation: successive calls cycle through the configured pool', () => {
  const rotator = new UserAgentRotator({ userAgents: ['UA-1', 'UA-2', 'UA-3'] });
  assert.deepEqual([rotator.next(), rotator.next(), rotator.next(), rotator.next()], ['UA-1', 'UA-2', 'UA-3', 'UA-1']);
});

test('User-Agent rotation: refuses an empty pool', () => {
  assert.throws(() => new UserAgentRotator({ userAgents: [] }));
});

test('session/cookie isolation: each session gets a consistent header set that does not mix with another session', () => {
  const builder = new SessionHeaderBuilder({ rotator: new UserAgentRotator({ userAgents: ['UA-1', 'UA-2'] }) });
  const sessionA1 = builder.headersFor('session-A');
  const sessionA2 = builder.headersFor('session-A');
  const sessionB1 = builder.headersFor('session-B');

  assert.equal(sessionA1['User-Agent'], sessionA2['User-Agent'], 'the same session must keep the same User-Agent');
  assert.notEqual(sessionA1['User-Agent'], sessionB1['User-Agent'], 'different sessions should not silently share state');
});

test('session/cookie isolation: cookies set for one session are invisible to another', () => {
  const jar = new SessionCookieJar();
  jar.setCookie('session-A', 'sid', 'abc123');
  jar.setCookie('session-B', 'sid', 'xyz789');

  assert.equal(jar.getCookieHeader('session-A'), 'sid=abc123');
  assert.equal(jar.getCookieHeader('session-B'), 'sid=xyz789');
});

test('session/cookie isolation: a session with no cookies returns null, not an empty/garbage string', () => {
  const jar = new SessionCookieJar();
  assert.equal(jar.getCookieHeader('never-used'), null);
});

test('session/cookie isolation: clearing a session removes only that session', () => {
  const jar = new SessionCookieJar();
  jar.setCookie('session-A', 'sid', 'abc123');
  jar.setCookie('session-B', 'sid', 'xyz789');
  jar.clear('session-A');
  assert.equal(jar.getCookieHeader('session-A'), null);
  assert.equal(jar.getCookieHeader('session-B'), 'xyz789'.length ? 'sid=xyz789' : null);
});

test('timeout configuration: a positive timeout is accepted', () => {
  const config = validateRequestConfig({ timeoutMs: 15000, maxRedirects: 3 });
  assert.equal(config.timeoutMs, 15000);
});

test('timeout configuration: a non-positive timeout is rejected', () => {
  assert.throws(() => validateRequestConfig({ timeoutMs: 0 }));
  assert.throws(() => validateRequestConfig({ timeoutMs: -100 }));
});

test('redirect configuration: maxRedirects is accepted including zero (no redirects allowed)', () => {
  assert.equal(validateRequestConfig({ maxRedirects: 0 }).maxRedirects, 0);
  assert.equal(validateRequestConfig({ maxRedirects: 10 }).maxRedirects, 10);
});

test('redirect configuration: a negative maxRedirects is rejected', () => {
  assert.throws(() => validateRequestConfig({ maxRedirects: -1 }));
});

test('proxy config: no PROXY_LIST configured yields an empty, honestly-empty list (no fabricated proxies)', () => {
  assert.deepEqual(loadProxiesFromEnv({}), []);
});

test('proxy config: a valid PROXY_LIST is parsed without exposing any hard-coded credentials in source', () => {
  const env = { PROXY_LIST: JSON.stringify([{ id: 'p1', url: 'http://user:pass@proxy.example:8080', tier: 'residential' }]) };
  const proxies = loadProxiesFromEnv(env);
  assert.deepEqual(proxies, [{ id: 'p1', url: 'http://user:pass@proxy.example:8080', tier: 'residential' }]);
});

test('proxy config: malformed PROXY_LIST JSON throws a clear error rather than silently ignoring it', () => {
  assert.throws(() => loadProxiesFromEnv({ PROXY_LIST: 'not json' }));
});

test('proxy config: loadProxyPoolOptionsFromEnv wires numeric env vars through correctly', () => {
  const options = loadProxyPoolOptionsFromEnv({
    PROXY_LIST: '[]',
    PROXY_COOLDOWN_MS: '5000',
    PROXY_EJECT_AFTER_CONSECUTIVE_FAILURES: '4',
    PROXY_EJECT_AFTER_BLOCK_COUNT: '2'
  });
  assert.deepEqual(options, {
    proxies: [],
    cooldownMs: 5000,
    ejectAfterConsecutiveFailures: 4,
    ejectAfterBlockCount: 2
  });
});
