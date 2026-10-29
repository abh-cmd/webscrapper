const { loadProxiesFromEnv, loadProxyPoolOptionsFromEnv } = require('./proxy-config');

// Provider abstraction for where the proxy LIST comes from, mirroring
// src/ai/provider-factory.js's shape on purpose (env-var-selected,
// safe-by-default, throws on an unrecognized value). Today only one real
// source exists — a static list in PROXY_LIST — but this indirection means
// a future real provider integration (e.g. an API call to Bright Data or
// Oxylabs to fetch a live, rotating credential set) is a second case added
// here, not a redesign of ProxyPool or of anything that calls it.
//
// PROXY_PROVIDER=env-list (default) — reads PROXY_LIST, exactly as before.
// PROXY_PROVIDER=none               — always an empty pool (explicit direct-mode).
// Any other value throws — an unrecognized provider name must never
// silently fall back to "no proxies" as if that were intended.

function getProxyPoolOptions(env = process.env) {
  const selected = env.PROXY_PROVIDER || 'env-list';

  if (selected === 'none') {
    return { proxies: [], cooldownMs: undefined, ejectAfterConsecutiveFailures: undefined, ejectAfterBlockCount: undefined };
  }
  if (selected === 'env-list') {
    return loadProxyPoolOptionsFromEnv(env);
  }

  throw new Error(`Unknown PROXY_PROVIDER: "${selected}". Expected "env-list" or "none". (A real third-party provider integration would be added as a new case here, not a new module.)`);
}

function describeProxyTiers(env = process.env) {
  const proxies = loadProxiesFromEnv(env);
  const byTier = {};
  for (const proxy of proxies) {
    byTier[proxy.tier] = (byTier[proxy.tier] || 0) + 1;
  }
  return byTier;
}

module.exports = { getProxyPoolOptions, describeProxyTiers };
