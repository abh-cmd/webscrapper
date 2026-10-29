const test = require('node:test');
const assert = require('node:assert/strict');

const { RateLimiter } = require('../src/net/rate-limiter');
const { TokenBucket } = require('../src/net/token-bucket');
const {
  computeBackoffMs,
  parseRetryAfterMs,
  isRetryableHttpStatus,
  isRetryableErrorType
} = require('../src/net/backoff');

test('token bucket: allows up to its burst capacity immediately, then blocks', () => {
  const bucket = new TokenBucket({ ratePerSecond: 1, burst: 2, now: 0 });
  assert.equal(bucket.tryConsume(1, 0), true);
  assert.equal(bucket.tryConsume(1, 0), true);
  assert.equal(bucket.tryConsume(1, 0), false);
});

test('token bucket: refills over time at the configured rate', () => {
  const bucket = new TokenBucket({ ratePerSecond: 2, burst: 2, now: 0 });
  bucket.tryConsume(2, 0);
  assert.equal(bucket.tryConsume(1, 400), false); // only 0.8 tokens refilled
  assert.equal(bucket.tryConsume(1, 600), true); // 1.2 tokens refilled by t=600ms
});

test('per-domain rate limiting: a configured domain is limited independently of others', () => {
  const limiter = new RateLimiter();
  // High burst so the token bucket itself is never the limiting factor here
  // — this test isolates concurrency, not the rate/burst behavior (that's
  // covered separately below).
  limiter.configureDomain('wine.com', { ratePerSecond: 1, burst: 10, concurrency: 1 });
  limiter.configureDomain('totalwine.com', { ratePerSecond: 1, burst: 10, concurrency: 5 });

  assert.equal(limiter.canProceed({ domain: 'wine.com', sourceName: 'wine-com', now: 0 }).allowed, true);
  limiter.beginRequest('wine.com');
  const secondWineCom = limiter.canProceed({ domain: 'wine.com', sourceName: 'wine-com', now: 0 });
  assert.equal(secondWineCom.allowed, false);
  assert.equal(secondWineCom.reason, 'CONCURRENCY_LIMIT');

  // totalwine.com is unaffected by wine.com's exhausted concurrency slot.
  const totalWine = limiter.canProceed({ domain: 'totalwine.com', sourceName: 'total-wine', now: 0 });
  assert.equal(totalWine.allowed, true);
});

test('per-domain rate limiting: exceeding the token bucket rate is rejected with a retry delay', () => {
  const limiter = new RateLimiter();
  limiter.configureDomain('vivino.com', { ratePerSecond: 1, burst: 1, concurrency: 10 });
  limiter.canProceed({ domain: 'vivino.com', sourceName: 'vivino', now: 0 }); // consumes the only token
  const second = limiter.canProceed({ domain: 'vivino.com', sourceName: 'vivino', now: 0 });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'RATE_LIMITED');
  assert.ok(second.retryAfterMs > 0);
});

test('concurrency limiting: beginRequest/endRequest track in-flight count per domain', () => {
  const limiter = new RateLimiter({ defaultConcurrency: 1 });
  limiter.beginRequest('example.com');
  assert.equal(limiter.activeCount('example.com'), 1);
  assert.equal(limiter.canProceed({ domain: 'example.com', now: 0 }).reason, 'CONCURRENCY_LIMIT');
  limiter.endRequest('example.com');
  assert.equal(limiter.activeCount('example.com'), 0);
  assert.equal(limiter.canProceed({ domain: 'example.com', now: 1000 }).allowed, true);
});

test('jitter configuration: jitterDelayMs stays within the configured [min, max] window', () => {
  const limiter = new RateLimiter({ jitterMinMs: 100, jitterMaxMs: 200 });
  for (const fakeRandom of [0, 0.5, 0.999]) {
    const delay = limiter.jitterDelayMs({ random: () => fakeRandom });
    assert.ok(delay >= 100 && delay <= 200, `delay ${delay} out of range for random=${fakeRandom}`);
  }
});

test('global kill switch: engaging it blocks every domain/source immediately', () => {
  const limiter = new RateLimiter();
  limiter.configureDomain('wine.com', { ratePerSecond: 100, concurrency: 100 });
  limiter.setKillSwitch(true);
  const result = limiter.canProceed({ domain: 'wine.com', sourceName: 'wine-com', now: 0 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'KILL_SWITCH_ENGAGED');
});

test('global kill switch: disengaging it restores normal behavior', () => {
  const limiter = new RateLimiter();
  limiter.configureDomain('wine.com', { ratePerSecond: 100, concurrency: 100 });
  limiter.setKillSwitch(true);
  limiter.setKillSwitch(false);
  assert.equal(limiter.canProceed({ domain: 'wine.com', sourceName: 'wine-com', now: 0 }).allowed, true);
});

test('per-source enable/disable: a disabled source is blocked even if its domain has capacity', () => {
  const limiter = new RateLimiter();
  limiter.configureDomain('vivino.com', { ratePerSecond: 100, concurrency: 100 });
  limiter.setSourceEnabled('vivino', false);
  const result = limiter.canProceed({ domain: 'vivino.com', sourceName: 'vivino', now: 0 });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'SOURCE_DISABLED');
});

test('per-source enable/disable: sources default to enabled unless explicitly disabled', () => {
  const limiter = new RateLimiter();
  limiter.configureDomain('wine.com', { ratePerSecond: 100, concurrency: 100 });
  assert.equal(limiter.isSourceEnabled('wine-com'), true);
});

test('exponential backoff: delay grows with attempt number, capped at maxMs', () => {
  const noJitter = () => 0.5; // random()=0.5 -> jitter offset of 0 with the +/- formula
  const a1 = computeBackoffMs({ attempt: 1, baseMs: 100, maxMs: 10000, jitterRatio: 0, random: noJitter });
  const a2 = computeBackoffMs({ attempt: 2, baseMs: 100, maxMs: 10000, jitterRatio: 0, random: noJitter });
  const a3 = computeBackoffMs({ attempt: 3, baseMs: 100, maxMs: 10000, jitterRatio: 0, random: noJitter });
  assert.equal(a1, 100);
  assert.equal(a2, 200);
  assert.equal(a3, 400);

  const capped = computeBackoffMs({ attempt: 20, baseMs: 100, maxMs: 5000, jitterRatio: 0, random: noJitter });
  assert.equal(capped, 5000);
});

test('exponential backoff: jitter varies the delay within the configured ratio, deterministically per injected random', () => {
  const high = computeBackoffMs({ attempt: 3, baseMs: 100, maxMs: 10000, jitterRatio: 0.5, random: () => 1 });
  const low = computeBackoffMs({ attempt: 3, baseMs: 100, maxMs: 10000, jitterRatio: 0.5, random: () => 0 });
  assert.ok(high > low);
});

test('Retry-After handling: numeric seconds form is parsed to milliseconds', () => {
  assert.equal(parseRetryAfterMs('120'), 120000);
});

test('Retry-After handling: HTTP-date form is parsed relative to now', () => {
  const now = Date.parse('2026-08-28T00:00:00.000Z');
  const future = new Date(now + 5000).toUTCString();
  const ms = parseRetryAfterMs(future, now);
  assert.ok(ms >= 4900 && ms <= 5100);
});

test('Retry-After handling: missing/unparseable header returns null', () => {
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs(''), null);
  assert.equal(parseRetryAfterMs('not-a-valid-value'), null);
});

test('retryable HTTP status classification: 429/403/503/5xx are retryable, other 4xx are not', () => {
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(403), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(500), true);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableHttpStatus(400), false);
});

test('retryable error-type classification: PRODUCT_NOT_FOUND/PAGE_TYPE_UNKNOWN/UNSUPPORTED_SOURCE are not retryable', () => {
  assert.equal(isRetryableErrorType('ACCESS_DENIED'), true);
  assert.equal(isRetryableErrorType('RATE_LIMITED'), true);
  assert.equal(isRetryableErrorType('PRODUCT_NOT_FOUND'), false);
  assert.equal(isRetryableErrorType('PAGE_TYPE_UNKNOWN'), false);
  assert.equal(isRetryableErrorType('UNSUPPORTED_SOURCE'), false);
  assert.equal(isRetryableErrorType('NOT_IMPLEMENTED'), false);
});
