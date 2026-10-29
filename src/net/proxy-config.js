// Builds proxy pool configuration from environment variables — never from
// hard-coded credentials in source. No proxy provider is actually
// configured for this project as of this batch; PROXY_LIST is simply
// unset in every environment this has run in, and loadProxiesFromEnv()
// correctly returns an empty list in that case (an empty, honestly-empty
// pool, not a fabricated one).
//
// Expected format (JSON array in PROXY_LIST):
//   PROXY_LIST=[{"id":"p1","url":"http://user:pass@host:port","tier":"residential"}]

function loadProxiesFromEnv(env = process.env) {
  const raw = env.PROXY_LIST;
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`PROXY_LIST is set but is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error('PROXY_LIST must be a JSON array of { id, url, tier } objects.');
  }

  return parsed.map((entry, index) => {
    if (!entry.id || !entry.url) {
      throw new Error(`PROXY_LIST[${index}] is missing a required "id" or "url" field.`);
    }
    return { id: entry.id, url: entry.url, tier: entry.tier || 'datacenter' };
  });
}

function loadProxyPoolOptionsFromEnv(env = process.env) {
  return {
    proxies: loadProxiesFromEnv(env),
    cooldownMs: env.PROXY_COOLDOWN_MS ? Number(env.PROXY_COOLDOWN_MS) : undefined,
    ejectAfterConsecutiveFailures: env.PROXY_EJECT_AFTER_CONSECUTIVE_FAILURES
      ? Number(env.PROXY_EJECT_AFTER_CONSECUTIVE_FAILURES)
      : undefined,
    ejectAfterBlockCount: env.PROXY_EJECT_AFTER_BLOCK_COUNT ? Number(env.PROXY_EJECT_AFTER_BLOCK_COUNT) : undefined
  };
}

module.exports = {
  loadProxiesFromEnv,
  loadProxyPoolOptionsFromEnv
};
