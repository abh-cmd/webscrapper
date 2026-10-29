// Ties together every "don't hammer a source" mechanism Block 1 built
// (rate limiter, proxy pool) plus the operational controls this pass adds
// (kill switch, source disablement, request budget) into the two calls
// crawler.js actually needs: one before a request, one after. Before this
// module, RateLimiter and ProxyPool existed and were unit-tested, but
// crawler.js never called either of them — every real crawl bypassed rate
// limiting and proxy selection entirely. That gap is closed here.
//
// Every check defaults to "allowed" when unconfigured, so wiring this into
// crawler.js changes nothing for a deployment that hasn't set any of the
// new environment variables (see .env.example) — see the four production
// hostnames' conservative built-in rate-limit default (rate-limit-config.js)
// for the one intentional exception, which existed as a real, if manual,
// policy in every prior phase's live testing anyway (one request, waited
// for a response, moved on).

const { RateLimiter } = require('./rate-limiter');
const { ProxyPool } = require('./proxy-pool');
const { getProxyPoolOptions } = require('./proxy-provider');
const { loadDomainRateLimitsFromEnv, rateLimitForDomain } = require('./rate-limit-config');
const { isKillSwitchEngaged, isSourceDisabled } = require('./kill-switch');
const { toPlaywrightProxy } = require('./proxy-url');

const MAX_RATE_LIMIT_WAIT_MS = 5000;

function createGuardrails({ env = process.env, rateLimiterOptions = {}, proxyPoolOptions = null } = {}) {
  const rateLimiter = new RateLimiter({
    defaultRatePerSecond: 100000, // effectively unthrottled for any domain with no explicit config
    defaultBurst: 100000,
    defaultConcurrency: 100000,
    jitterMinMs: 0,
    jitterMaxMs: 0,
    ...rateLimiterOptions
  });

  const domainLimits = loadDomainRateLimitsFromEnv(env);
  for (const [domain, limits] of Object.entries(domainLimits)) {
    rateLimiter.configureDomain(domain, limits);
  }

  const proxyPool = new ProxyPool(proxyPoolOptions || getProxyPoolOptions(env));

  async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Called immediately before navigating. Returns either
  // { allowed: true, proxy: <playwright proxy option or undefined>,
  //   proxyId, domain } or { allowed: false, errorType, errorMessage }.
  async function beforeCrawl({ sourceName, sourceUrl, budgetConfig = null }) {
    if (isKillSwitchEngaged(env)) {
      return { allowed: false, errorType: 'KILL_SWITCH_ENGAGED', errorMessage: 'The crawler kill switch (CRAWLER_KILL_SWITCH=true) is engaged. No crawls are permitted until it is disengaged.' };
    }
    if (isSourceDisabled(sourceName, env)) {
      return { allowed: false, errorType: 'SOURCE_DISABLED', errorMessage: `Source "${sourceName}" is disabled via DISABLED_SOURCES.` };
    }

    let domain;
    try {
      domain = new URL(sourceUrl).hostname.toLowerCase();
    } catch (error) {
      return { allowed: false, errorType: 'ValidationError', errorMessage: `Cannot parse hostname from ${sourceUrl}` };
    }

    // Budget: fail OPEN if the DB (or the check itself) is unavailable —
    // a broken budget subsystem must never be the reason a crawl can't run.
    try {
      const { isDatabaseConfigured } = require('../db/connection');
      if (isDatabaseConfigured()) {
        const { recordAndCheckBudget, loadBudgetConfigFromEnv } = require('./request-budget');
        const config = budgetConfig || loadBudgetConfigFromEnv(env);
        const usage = await recordAndCheckBudget(sourceName, { config });
        if (!usage.withinBudget) {
          return { allowed: false, errorType: 'BUDGET_EXCEEDED', errorMessage: `Source "${sourceName}" has used ${usage.count} requests today, exceeding its configured limit of ${usage.max}.` };
        }
      }
    } catch (error) {
      // logged, not thrown — see module header.
      console.warn(`[crawl-guardrails] budget check failed, proceeding without it: ${error.message}`);
    }

    // Rate limit: wait once, bounded, for a token; if still unavailable,
    // fail rather than hang or silently bypass the limiter.
    let decision = rateLimiter.canProceed({ domain, sourceName });
    if (!decision.allowed && decision.reason === 'RATE_LIMITED') {
      await sleep(Math.min(decision.retryAfterMs || 0, MAX_RATE_LIMIT_WAIT_MS));
      decision = rateLimiter.canProceed({ domain, sourceName });
    }
    if (!decision.allowed) {
      return { allowed: false, errorType: `RATE_LIMIT_${decision.reason}`, errorMessage: `Request to "${domain}" was not permitted: ${decision.reason}.` };
    }

    rateLimiter.beginRequest(domain);

    const proxySelection = proxyPool.selectProxy({ sessionKey: sourceName });
    const proxy = proxySelection ? toPlaywrightProxy(proxySelection.url) : undefined;

    return { allowed: true, proxy, proxyId: proxySelection?.id || null, domain };
  }

  // Called after the crawl finishes (success or failure), so the rate
  // limiter releases its concurrency slot and the proxy pool's health
  // tracking reflects what actually happened.
  function afterCrawl({ domain, proxyId, success, blocked, latencyMs }) {
    if (domain) rateLimiter.endRequest(domain);
    if (proxyId) {
      if (success) proxyPool.reportSuccess(proxyId, { latencyMs });
      else proxyPool.reportFailure(proxyId, { blocked: Boolean(blocked) });
    }
  }

  return { rateLimiter, proxyPool, beforeCrawl, afterCrawl };
}

let defaultInstance = null;
function getDefaultGuardrails() {
  if (!defaultInstance) defaultInstance = createGuardrails();
  return defaultInstance;
}

// Exposed for tests/observability that need to reset state between runs —
// production code never needs this.
function resetDefaultGuardrails() {
  defaultInstance = null;
}

module.exports = { createGuardrails, getDefaultGuardrails, resetDefaultGuardrails };
