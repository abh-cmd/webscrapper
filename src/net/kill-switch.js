// A global kill switch and a per-source enable/disable list, both
// re-checked on every call (not cached at startup) so an operator can
// engage either by setting an environment variable and restarting the
// process — no code change required. Both default to "everything allowed"
// so an unconfigured deployment behaves exactly as before this module
// existed.

function isKillSwitchEngaged(env = process.env) {
  return env.CRAWLER_KILL_SWITCH === 'true';
}

function loadDisabledSources(env = process.env) {
  if (!env.DISABLED_SOURCES) return new Set();
  return new Set(
    env.DISABLED_SOURCES.split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  );
}

function isSourceDisabled(sourceName, env = process.env) {
  if (!sourceName) return false;
  return loadDisabledSources(env).has(sourceName.toLowerCase());
}

module.exports = { isKillSwitchEngaged, loadDisabledSources, isSourceDisabled };
