const test = require('node:test');
const assert = require('node:assert/strict');

const { ProxyPool } = require('../src/net/proxy-pool');

// All tests use controlled, in-memory mock proxy entries — no live proxy
// provider is used or fabricated, per instructions.

function makePool(overrides = {}) {
  return new ProxyPool({
    proxies: [
      { id: 'p1', url: 'http://p1.example', tier: 'datacenter' },
      { id: 'p2', url: 'http://p2.example', tier: 'datacenter' },
      { id: 'p3', url: 'http://p3.example', tier: 'residential' }
    ],
    cooldownMs: 1000,
    ejectAfterConsecutiveFailures: 3,
    ejectAfterBlockCount: 2,
    ...overrides
  });
}

test('proxy selection: returns a proxy from the configured pool', () => {
  const pool = makePool();
  const proxy = pool.selectProxy();
  assert.ok(['p1', 'p2', 'p3'].includes(proxy.id));
});

test('proxy rotation: successive selections rotate round-robin through healthy proxies', () => {
  const pool = makePool();
  const ids = [pool.selectProxy().id, pool.selectProxy().id, pool.selectProxy().id, pool.selectProxy().id];
  assert.deepEqual(ids, ['p1', 'p2', 'p3', 'p1']);
});

test('sticky session behavior: the same session key always gets the same proxy while it stays healthy', () => {
  const pool = makePool();
  const first = pool.selectProxy({ sessionKey: 'session-A' });
  const second = pool.selectProxy({ sessionKey: 'session-A' });
  const third = pool.selectProxy({ sessionKey: 'session-A' });
  assert.equal(first.id, second.id);
  assert.equal(second.id, third.id);
});

test('sticky session behavior: different session keys can get different proxies', () => {
  const pool = makePool();
  const a = pool.selectProxy({ sessionKey: 'session-A' });
  // Force rotation to a different proxy for a second session by exhausting p1 first via a failure/eject.
  pool.reportFailure(a.id, { blocked: true, now: 0 });
  pool.reportFailure(a.id, { blocked: true, now: 0 });
  const b = pool.selectProxy({ sessionKey: 'session-B' });
  assert.notEqual(a.id, b.id);
});

test('proxy health tracking: success/failure counts and success rate', () => {
  const pool = makePool();
  pool.reportSuccess('p1', { latencyMs: 100 });
  pool.reportSuccess('p1', { latencyMs: 200 });
  pool.reportFailure('p1', { now: 0 });
  const health = pool.getHealth('p1');
  assert.equal(health.successCount, 2);
  assert.equal(health.failureCount, 1);
  assert.equal(health.successRate, 2 / 3);
  assert.equal(health.avgLatencyMs, 150);
});

test('proxy failure counting: consecutive failures reset on a success', () => {
  const pool = makePool();
  pool.reportFailure('p1', { now: 0 });
  pool.reportFailure('p1', { now: 0 });
  assert.equal(pool.getHealth('p1').consecutiveFailures, 2);
  pool.reportSuccess('p1');
  assert.equal(pool.getHealth('p1').consecutiveFailures, 0);
});

test('proxy ejection: a proxy is ejected after too many consecutive failures', () => {
  const pool = makePool();
  pool.reportFailure('p1', { now: 0 });
  pool.reportFailure('p1', { now: 0 });
  pool.reportFailure('p1', { now: 0 }); // 3rd consecutive failure -> eject (threshold is 3)
  assert.equal(pool.getHealth('p1').status, 'ejected');

  const selections = [];
  for (let i = 0; i < 10; i += 1) selections.push(pool.selectProxy().id);
  assert.ok(!selections.includes('p1'), 'an ejected proxy must never be selected again');
});

test('proxy ejection: a proxy is also ejected after too many block events', () => {
  const pool = makePool();
  pool.reportFailure('p1', { blocked: true, now: 0 });
  pool.reportFailure('p1', { blocked: true, now: 0 }); // 2nd block -> eject (threshold is 2)
  assert.equal(pool.getHealth('p1').status, 'ejected');
});

test('proxy cooldown: a blocked proxy enters cooldown and is not selected until it expires', () => {
  const pool = makePool();
  pool.reportFailure('p1', { blocked: true, now: 0 });
  assert.equal(pool.getHealth('p1').status, 'cooling_down');

  const duringCooldown = [];
  for (let i = 0; i < 10; i += 1) duringCooldown.push(pool.selectProxy({ now: 500 }).id);
  assert.ok(!duringCooldown.includes('p1'), 'a cooling-down proxy must not be selected mid-cooldown');
});

test('proxy recovery: a cooled-down proxy becomes selectable again once its cooldown expires', () => {
  const pool = makePool();
  pool.reportFailure('p1', { blocked: true, now: 0 }); // cooldownMs = 1000
  const stillCooling = pool.getHealth('p1');
  assert.equal(stillCooling.status, 'cooling_down');

  // After cooldown expires, an availability check should flip it back to active.
  pool.selectProxy({ now: 1500 }); // triggers recovery sweep
  assert.equal(pool.getHealth('p1').status, 'active');
});

test('pool exhaustion: selectProxy returns null and isExhausted() is true when every proxy is unusable', () => {
  const pool = new ProxyPool({ proxies: [{ id: 'only', url: 'http://only.example' }], cooldownMs: 1000, ejectAfterConsecutiveFailures: 1 });
  pool.reportFailure('only', { now: 0 });
  assert.equal(pool.selectProxy({ now: 0 }), null);
  assert.equal(pool.isExhausted(0), true);
});

test('pool exhaustion: an empty pool (no proxies configured) is exhausted', () => {
  const pool = new ProxyPool({ proxies: [] });
  assert.equal(pool.selectProxy(), null);
  assert.equal(pool.isExhausted(), true);
});

test('snapshot: reports health for every configured proxy', () => {
  const pool = makePool();
  const snapshot = pool.snapshot();
  assert.equal(snapshot.length, 3);
  assert.deepEqual(snapshot.map((s) => s.id).sort(), ['p1', 'p2', 'p3']);
});
