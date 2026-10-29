const { TokenBucket } = require('./token-bucket');

// Per-domain token-bucket rate limiting + concurrency limiting + a global
// kill switch + per-source enable/disable flags. Pure decision logic:
// `canProceed` answers "is this request allowed right now", callers are
// responsible for actually waiting/retrying based on the answer.

class RateLimiter {
  constructor({
    defaultRatePerSecond = 1,
    defaultBurst = null,
    defaultConcurrency = 1,
    jitterMinMs = 0,
    jitterMaxMs = 250
  } = {}) {
    this.defaults = { defaultRatePerSecond, defaultBurst, defaultConcurrency, jitterMinMs, jitterMaxMs };
    this.buckets = new Map();
    this.domainConfig = new Map();
    this.activeCounts = new Map();
    this.sourceEnabled = new Map();
    this.killSwitchEngaged = false;
  }

  configureDomain(domain, { ratePerSecond, burst, concurrency } = {}) {
    this.domainConfig.set(domain, {
      ratePerSecond: ratePerSecond ?? this.defaults.defaultRatePerSecond,
      burst: burst ?? this.defaults.defaultBurst,
      concurrency: concurrency ?? this.defaults.defaultConcurrency
    });
    this.buckets.delete(domain); // re-created lazily with the new config
  }

  _bucketFor(domain, now) {
    if (!this.buckets.has(domain)) {
      const config = this.domainConfig.get(domain) || {};
      this.buckets.set(domain, new TokenBucket({
        ratePerSecond: config.ratePerSecond ?? this.defaults.defaultRatePerSecond,
        burst: config.burst ?? this.defaults.defaultBurst,
        now
      }));
    }
    return this.buckets.get(domain);
  }

  _concurrencyLimitFor(domain) {
    const config = this.domainConfig.get(domain);
    return config?.concurrency ?? this.defaults.defaultConcurrency;
  }

  setKillSwitch(engaged) {
    this.killSwitchEngaged = Boolean(engaged);
  }

  setSourceEnabled(sourceName, enabled) {
    this.sourceEnabled.set(sourceName, Boolean(enabled));
  }

  isSourceEnabled(sourceName) {
    return this.sourceEnabled.get(sourceName) ?? true;
  }

  // Does not consume a token or reserve concurrency — call beginRequest()
  // immediately after a true `allowed` result, and endRequest() when done.
  canProceed({ domain, sourceName, now = Date.now() }) {
    if (this.killSwitchEngaged) {
      return { allowed: false, reason: 'KILL_SWITCH_ENGAGED' };
    }
    if (sourceName && !this.isSourceEnabled(sourceName)) {
      return { allowed: false, reason: 'SOURCE_DISABLED' };
    }

    const active = this.activeCounts.get(domain) || 0;
    const limit = this._concurrencyLimitFor(domain);
    if (active >= limit) {
      return { allowed: false, reason: 'CONCURRENCY_LIMIT' };
    }

    const bucket = this._bucketFor(domain, now);
    if (!bucket.tryConsume(1, now)) {
      return { allowed: false, reason: 'RATE_LIMITED', retryAfterMs: bucket.msUntilAvailable(1, now) };
    }

    return { allowed: true };
  }

  beginRequest(domain) {
    this.activeCounts.set(domain, (this.activeCounts.get(domain) || 0) + 1);
  }

  endRequest(domain) {
    this.activeCounts.set(domain, Math.max(0, (this.activeCounts.get(domain) || 0) - 1));
  }

  activeCount(domain) {
    return this.activeCounts.get(domain) || 0;
  }

  // Randomized delay to add before dispatching a request, so requests
  // don't all fire in lockstep. Injectable `random` for deterministic tests.
  jitterDelayMs({ random = Math.random } = {}) {
    const { jitterMinMs, jitterMaxMs } = this.defaults;
    if (jitterMaxMs <= jitterMinMs) return jitterMinMs;
    return Math.round(jitterMinMs + random() * (jitterMaxMs - jitterMinMs));
  }
}

module.exports = { RateLimiter };
