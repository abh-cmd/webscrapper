// Exponential backoff with jitter, and Retry-After parsing. Pure functions
// — `random` is injectable so tests are deterministic.

function computeBackoffMs({ attempt, baseMs = 500, maxMs = 30000, jitterRatio = 0.2, random = Math.random }) {
  if (attempt < 1) throw new Error('attempt must be >= 1.');
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  const jitterSpan = exponential * jitterRatio;
  const jitter = jitterSpan * (random() * 2 - 1); // +/- jitterSpan
  return Math.max(0, Math.round(exponential + jitter));
}

// Accepts either a delay-in-seconds form ("120") or an HTTP-date form,
// per RFC 7231's Retry-After header. Returns milliseconds, or null if the
// header is absent/unparseable.
function parseRetryAfterMs(headerValue, now = Date.now()) {
  if (headerValue === null || headerValue === undefined || headerValue === '') return null;

  const asSeconds = Number(headerValue);
  if (!Number.isNaN(asSeconds) && String(headerValue).trim() !== '') {
    return Math.max(0, Math.round(asSeconds * 1000));
  }

  const asDateMs = Date.parse(headerValue);
  if (!Number.isNaN(asDateMs)) {
    return Math.max(0, asDateMs - now);
  }

  return null;
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 403, 503]);

function isRetryableHttpStatus(status) {
  if (typeof status !== 'number') return false;
  return RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;
}

// Not every classified error type is worth retrying: a page that
// legitimately doesn't exist, or a page whose type/product could not be
// resolved, will not resolve itself on retry.
const RETRYABLE_ERROR_TYPES = new Set(['ACCESS_DENIED', 'RATE_LIMITED', 'SOURCE_SERVER_ERROR', 'NETWORK_ERROR', 'EXTRACTION_FAILED']);
const NON_RETRYABLE_ERROR_TYPES = new Set(['PRODUCT_NOT_FOUND', 'PAGE_TYPE_UNKNOWN', 'UNSUPPORTED_SOURCE', 'NOT_IMPLEMENTED', 'ValidationError']);

function isRetryableErrorType(errorType) {
  if (RETRYABLE_ERROR_TYPES.has(errorType)) return true;
  if (NON_RETRYABLE_ERROR_TYPES.has(errorType)) return false;
  // Unknown error types default to retryable-with-limit, since an
  // unrecognized failure is more likely transient than permanent — the
  // max-retry-count ceiling still applies regardless.
  return true;
}

module.exports = {
  computeBackoffMs,
  parseRetryAfterMs,
  isRetryableHttpStatus,
  isRetryableErrorType,
  RETRYABLE_ERROR_TYPES,
  NON_RETRYABLE_ERROR_TYPES
};
