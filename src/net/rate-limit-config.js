// Per-domain rate-limit configuration. Two layers, deliberately kept
// separate:
//
// 1. BUILT_IN_PRODUCTION_DEFAULTS — a conservative, documented default
//    (1 req/sec, concurrency 1, no burst) for the four approved production
//    hostnames only. This is baseline politeness/engineering hygiene
//    ("don't hammer a site"), not a business decision — it applies whether
//    or not anyone has configured anything, same as respecting robots.txt.
// 2. RATE_LIMIT_CONFIG (env, optional JSON) — overrides or adds any
//    hostname's limits, including the four defaults above.
//
// Any hostname with no built-in default and no env override (every local
// fixture/test server, e.g. 127.0.0.1) is left UNTHROTTLED by returning
// null here — RateLimiter.configureDomain() is simply never called for it,
// so it falls back to whatever the RateLimiter instance's own constructor
// defaults are. crawler.js constructs that instance with generous defaults
// for exactly this reason — see crawler.js's rateLimiter singleton.

const BUILT_IN_PRODUCTION_DEFAULTS = {
  'www.wine.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'wine.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'www.totalwine.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'totalwine.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'www.wine-searcher.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'wine-searcher.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'www.vivino.com': { ratePerSecond: 1, burst: 1, concurrency: 1 },
  'vivino.com': { ratePerSecond: 1, burst: 1, concurrency: 1 }
};

function loadDomainRateLimitsFromEnv(env = process.env) {
  const merged = { ...BUILT_IN_PRODUCTION_DEFAULTS };

  if (env.RATE_LIMIT_CONFIG) {
    let parsed;
    try {
      parsed = JSON.parse(env.RATE_LIMIT_CONFIG);
    } catch (error) {
      throw new Error(`RATE_LIMIT_CONFIG is set but is not valid JSON: ${error.message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('RATE_LIMIT_CONFIG must be a JSON object mapping hostname -> { ratePerSecond, burst, concurrency }.');
    }
    Object.assign(merged, parsed);
  }

  return merged;
}

function rateLimitForDomain(domain, config) {
  return config[domain] || null;
}

module.exports = { BUILT_IN_PRODUCTION_DEFAULTS, loadDomainRateLimitsFromEnv, rateLimitForDomain };
