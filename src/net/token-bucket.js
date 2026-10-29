// Classic token-bucket rate limiter. Pure, deterministic given an
// injectable `now` — no timers, no real waiting, fully unit-testable.

class TokenBucket {
  constructor({ ratePerSecond, burst = null, now = Date.now() }) {
    if (!(ratePerSecond > 0)) throw new Error('ratePerSecond must be a positive number.');
    this.ratePerSecond = ratePerSecond;
    this.capacity = burst != null ? burst : ratePerSecond;
    this.tokens = this.capacity;
    this.lastRefill = now;
  }

  _refill(now) {
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSecond);
      this.lastRefill = now;
    }
  }

  tryConsume(count = 1, now = Date.now()) {
    this._refill(now);
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  msUntilAvailable(count = 1, now = Date.now()) {
    this._refill(now);
    if (this.tokens >= count) return 0;
    const deficit = count - this.tokens;
    return Math.ceil((deficit / this.ratePerSecond) * 1000);
  }
}

module.exports = { TokenBucket };
