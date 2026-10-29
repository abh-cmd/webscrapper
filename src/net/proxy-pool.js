// Pluggable proxy pool: rotation, sticky sessions, health tracking,
// automatic ejection/cooldown, and exhaustion detection.
//
// This module has no concept of "solving" a block — it only tracks which
// proxies are currently healthy enough to use and rotates among them. What
// a caller does when the pool is exhausted (pause the run, alert, etc.) is
// the caller's responsibility (see graceful-degradation handling in
// rate-limiter.js and the end-to-end pipeline).
//
// No live proxy provider is configured or available in this project as of
// this batch — proxies are supplied by the caller via configuration
// (environment/config), never hard-coded here. Tests use controlled mock
// proxy entries, per instructions, rather than fabricating live results.

class ProxyPool {
  constructor({
    proxies = [],
    cooldownMs = 60000,
    ejectAfterConsecutiveFailures = 5,
    ejectAfterBlockCount = 3
  } = {}) {
    this.entries = new Map();
    this.stickySessions = new Map();
    this.rotationIndex = 0;
    this.cooldownMs = cooldownMs;
    this.ejectAfterConsecutiveFailures = ejectAfterConsecutiveFailures;
    this.ejectAfterBlockCount = ejectAfterBlockCount;

    for (const proxy of proxies) this.addProxy(proxy);
  }

  // tier: 'residential' | 'datacenter' (or any caller-defined label — this
  // module treats tier as opaque metadata, available for callers/tests to
  // prefer one tier over another, but does not hard-code provider behavior).
  addProxy({ id, url, tier = 'datacenter' }) {
    if (!id || !url) throw new Error('addProxy requires both id and url.');
    this.entries.set(id, {
      id,
      url,
      tier,
      status: 'active', // 'active' | 'cooling_down' | 'ejected'
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      blockCount: 0,
      latencySamples: [],
      cooldownUntil: null,
      lastUsedAt: null
    });
  }

  removeProxy(id) {
    this.entries.delete(id);
    for (const [sessionKey, proxyId] of this.stickySessions.entries()) {
      if (proxyId === id) this.stickySessions.delete(sessionKey);
    }
  }

  size() {
    return this.entries.size;
  }

  getHealth(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const total = entry.successCount + entry.failureCount;
    return {
      id: entry.id,
      tier: entry.tier,
      status: entry.status,
      successCount: entry.successCount,
      failureCount: entry.failureCount,
      successRate: total === 0 ? null : entry.successCount / total,
      avgLatencyMs: entry.latencySamples.length
        ? entry.latencySamples.reduce((a, b) => a + b, 0) / entry.latencySamples.length
        : null,
      blockCount: entry.blockCount,
      consecutiveFailures: entry.consecutiveFailures,
      cooldownUntil: entry.cooldownUntil
    };
  }

  _recoverExpiredCooldowns(now) {
    for (const entry of this.entries.values()) {
      if (entry.status === 'cooling_down' && entry.cooldownUntil !== null && entry.cooldownUntil <= now) {
        entry.status = 'active';
        entry.cooldownUntil = null;
      }
    }
  }

  _availableEntries(now) {
    this._recoverExpiredCooldowns(now);
    return [...this.entries.values()].filter((entry) => entry.status === 'active');
  }

  // Per-request rotation by default (round robin over currently-healthy
  // proxies). Pass sessionKey to get sticky behavior: the same proxy is
  // reused for that key until it becomes unusable, at which point a new
  // one is selected and re-stuck to that key.
  selectProxy({ sessionKey = null, now = Date.now() } = {}) {
    this._recoverExpiredCooldowns(now);

    if (sessionKey && this.stickySessions.has(sessionKey)) {
      const stuckId = this.stickySessions.get(sessionKey);
      const stuckEntry = this.entries.get(stuckId);
      if (stuckEntry && stuckEntry.status === 'active') {
        stuckEntry.lastUsedAt = now;
        return { ...stuckEntry };
      }
      this.stickySessions.delete(sessionKey);
    }

    const available = this._availableEntries(now);
    if (available.length === 0) return null;

    const entry = available[this.rotationIndex % available.length];
    this.rotationIndex += 1;
    entry.lastUsedAt = now;

    if (sessionKey) this.stickySessions.set(sessionKey, entry.id);

    return { ...entry };
  }

  reportSuccess(id, { latencyMs = null, now = Date.now() } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.successCount += 1;
    entry.consecutiveFailures = 0;
    if (typeof latencyMs === 'number') {
      entry.latencySamples.push(latencyMs);
      if (entry.latencySamples.length > 50) entry.latencySamples.shift();
    }
    if (entry.status === 'cooling_down' && (entry.cooldownUntil === null || entry.cooldownUntil <= now)) {
      entry.status = 'active';
      entry.cooldownUntil = null;
    }
  }

  // blocked: true for 403 / 429 / CAPTCHA-classified responses — these
  // trigger a cooldown in addition to the failure count, since a block is a
  // stronger signal than a generic network error.
  reportFailure(id, { blocked = false, now = Date.now() } = {}) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.failureCount += 1;
    entry.consecutiveFailures += 1;

    if (blocked) {
      entry.blockCount += 1;
      entry.status = 'cooling_down';
      entry.cooldownUntil = now + this.cooldownMs;
    }

    if (
      entry.consecutiveFailures >= this.ejectAfterConsecutiveFailures ||
      entry.blockCount >= this.ejectAfterBlockCount
    ) {
      entry.status = 'ejected';
      entry.cooldownUntil = null;
    }
  }

  isExhausted(now = Date.now()) {
    if (this.entries.size === 0) return true;
    return this._availableEntries(now).length === 0;
  }

  snapshot(now = Date.now()) {
    this._recoverExpiredCooldowns(now);
    return [...this.entries.keys()].map((id) => this.getHealth(id));
  }
}

module.exports = { ProxyPool };
