const { extractExampleSourceProduct } = require('./example-source');
const wineSearcher = require('./wine-searcher');
const { extractTalliDrinksTestProduct } = require('./talli-drinks');
const wineCom = require('./wine-com');
const totalWine = require('./total-wine');
const vivino = require('./vivino');
const barefoot = require('./barefoot');
const { extractGenericProduct } = require('./generic-adapter');
const { hostnameMatches } = require('./hostname-utils');

// Approved PRODUCTION sources, per project requirements. Each entry follows
// the common adapter contract: { name, hostnames, canHandle(url), extract(context) }.
// All four are now implemented:
//   - wine-searcher (Phase 2), wine-com (Phase 4), total-wine (Phase 5):
//     ACCESS_DENIED against real anti-bot protection (PerimeterX / DataDome
//     / PerimeterX respectively), not fabricated success.
//   - vivino (Phase 6): its own robots.txt explicitly disallows ClaudeBot
//     from every path, so no live request of any kind was made to it (not
//     even a captured block page exists) — extraction logic is generic
//     schema.org parsing, validated only against synthetic fixtures.
// See README for exact status/evidence per source.
const PRODUCTION_SOURCES = {
  'wine-com': { name: 'wine-com', hostnames: wineCom.hostnames, canHandle: wineCom.canHandle, extract: wineCom.extract },
  'total-wine': { name: 'total-wine', hostnames: totalWine.hostnames, canHandle: totalWine.canHandle, extract: totalWine.extract },
  vivino: { name: 'vivino', hostnames: vivino.hostnames, canHandle: vivino.canHandle, extract: vivino.extract },
  'wine-searcher': { name: 'wine-searcher', hostnames: wineSearcher.hostnames, canHandle: wineSearcher.canHandle, extract: wineSearcher.extractWineSearcherProduct }
};

// Browser-interaction source that uses a DOB form submission before the
// generic extraction fallback runs. It is deliberately separate from the
// four approved production sources but still auto-detectable by hostname.
const BROWSER_INTERACTION_SOURCES = {
  flaviar: {
    name: barefoot.name,
    hostnames: barefoot.hostnames,
    canHandle: barefoot.canHandle,
    preparePage: barefoot.preparePage,
    extract: barefoot.extract
  },
  barefoot: {
    name: barefoot.name,
    hostnames: barefoot.hostnames,
    canHandle: barefoot.canHandle,
    preparePage: barefoot.preparePage,
    extract: barefoot.extract
  }
};

// Non-production sources: a local fixture (Phase 1) and a dev/test-only
// integration target (Phase 2 "Test B"). Neither is hostname-detectable —
// they must be selected explicitly by name, never picked up by URL
// auto-detection, and Talli Drinks in particular must never appear
// alongside the four approved production sources above.
const TEST_AND_FIXTURE_SOURCES = {
  'example-source': { name: 'example-source', extract: extractExampleSourceProduct },
  'talli-drinks-test': { name: 'talli-drinks-test', extract: extractTalliDrinksTestProduct }
};

const sourceRegistry = {
  ...PRODUCTION_SOURCES,
  ...BROWSER_INTERACTION_SOURCES,
  ...TEST_AND_FIXTURE_SOURCES
};

const PRODUCTION_SOURCE_NAMES = Object.keys(PRODUCTION_SOURCES);

function throwUnsupportedSource(url) {
  const err = new Error(`Unsupported source: no approved production adapter recognizes this URL: "${url}". Approved sources: ${PRODUCTION_SOURCE_NAMES.join(', ')}.`);
  err.type = 'UNSUPPORTED_SOURCE';
  throw err;
}

// A generic, standards-based adapter for any URL that isn't one of the
// four purpose-built production sources — see generic-adapter.js. Built
// per explicit request: the crawler should be able to attempt ANY site,
// not just the four with hand-written selectors, using schema.org/
// OpenGraph signals instead. Compliance is unaffected: robots.txt and
// anti-bot/HTTP-status handling in crawler.js apply identically regardless
// of which adapter is selected — this only adds extraction logic where
// none previously existed.
function createGenericAdapter(hostname) {
  return {
    name: hostname,
    hostnames: [hostname],
    canHandle: () => true,
    extract: extractGenericProduct,
    isGeneric: true
  };
}

// Hostname -> canonical adapter name, based solely on the URL, independent
// of any explicit source.name. Only the four approved production sources
// are detectable this way (Talli Drinks and the local fixture are not).
function detectSourceNameByUrl(url) {
  for (const name of PRODUCTION_SOURCE_NAMES) {
    const adapter = PRODUCTION_SOURCES[name];
    if (hostnameMatches(url, adapter.hostnames)) {
      return name;
    }
  }
  return null;
}

// Registry entry point used for URL-only routing (no explicit source name).
// A URL matching one of the four approved production sources always uses
// that purpose-built adapter. Any other URL falls back to the generic
// standards-based adapter (see createGenericAdapter above) rather than
// being rejected outright — it may still fail for real reasons (robots.txt,
// anti-bot, no schema.org markup), but it is always attempted.
function getAdapterForUrl(url) {
  const name = detectSourceNameByUrl(url);
  if (name) {
    return sourceRegistry[name];
  }
  for (const adapter of Object.values(BROWSER_INTERACTION_SOURCES)) {
    if (hostnameMatches(url, adapter.hostnames)) {
      return adapter;
    }
  }
  let hostname;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '');
  } catch (error) {
    throwUnsupportedSource(url);
  }
  return createGenericAdapter(hostname);
}

// Registry entry point used by the crawler. Resolution order:
//   1. Explicit sourceConfig.name (existing Phase 1/2 contract) — exact
//      lookup across the full registry (production + test/fixture sources).
//   2. sourceConfig.url, hostname-matched against the approved production
//      sources only. An unrecognized URL is rejected clearly, never
//      silently treated as another source.
//   3. Neither given: falls back to the local fixture (pre-existing
//      default behavior for callers that pass no source information at all).
function resolveSource(sourceConfig = {}) {
  if (sourceConfig.name) {
    if (!sourceRegistry[sourceConfig.name]) {
      const names = Object.keys(sourceRegistry).join(', ');
      const err = new Error(`Unsupported source adapter: "${sourceConfig.name}". Available adapters: ${names}`);
      err.type = 'UNSUPPORTED_SOURCE';
      throw err;
    }
    return sourceRegistry[sourceConfig.name];
  }

  if (sourceConfig.url) {
    return getAdapterForUrl(sourceConfig.url);
  }

  return sourceRegistry['example-source'];
}

module.exports = {
  resolveSource,
  getAdapterForUrl,
  detectSourceNameByUrl,
  sourceRegistry,
  PRODUCTION_SOURCE_NAMES
};
