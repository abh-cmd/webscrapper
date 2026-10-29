const { createEmptyProductRecord, summarizeExtraction } = require('../schema/product-schema');
const { PRODUCTION_SOURCE_NAMES } = require('../sources/source-registry');

// This is the decision layer that runs AFTER source-specific extraction and
// normalization. It is not a scraper and not an adapter — it takes already
// -normalized results from one or more source adapters for the SAME Wine
// Outlet product and decides which data to use. Everything here is a pure,
// deterministic function: no network calls, no AI, no fuzzy matching.

// No explicit source-priority policy exists anywhere in this project's
// documentation. In the absence of one, this uses the order the four
// approved production sources are consistently listed in across every
// phase's requirements (Wine.com, Total Wine, Vivino, Wine-Searcher) as the
// documented tie-break priority — not an arbitrarily invented business
// rule. If the project later defines an explicit priority, replace this
// constant; nothing else in this module should need to change.
const DEFAULT_SOURCE_PRIORITY = [...PRODUCTION_SOURCE_NAMES];

// Fields that identify WHICH source/request produced a record, not a
// product attribute. These are never backfilled from a secondary source —
// doing so would misattribute where the merged data actually came from.
// item_number/item_name are Wine Outlet's own input-supplied identifiers,
// not source-derived, so they are excluded from field-level merging too.
const NON_MERGEABLE_FIELDS = new Set(['item_number', 'item_name', 'source_site', 'source_url', 'scraped_at']);

function isPopulated(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined;
}

function priorityIndex(sourceName, priorityOrder) {
  const index = priorityOrder.indexOf(sourceName);
  return index === -1 ? priorityOrder.length : index;
}

// Ranks successful, product-bearing entries by completeness (most populated
// fields wins), tie-broken by the documented source priority, then by
// source name for total determinism if both are somehow still equal.
function rankEntries(successEntries, priorityOrder) {
  return [...successEntries].sort((a, b) => {
    const completenessA = summarizeExtraction(a.product).populatedFields;
    const completenessB = summarizeExtraction(b.product).populatedFields;
    if (completenessB !== completenessA) return completenessB - completenessA;

    const priorityA = priorityIndex(a.sourceName, priorityOrder);
    const priorityB = priorityIndex(b.sourceName, priorityOrder);
    if (priorityA !== priorityB) return priorityA - priorityB;

    return a.sourceName.localeCompare(b.sourceName);
  });
}

function summarizeAttempt(entry) {
  return {
    sourceName: entry.sourceName,
    status: entry.status,
    errorType: entry.status === 'failed' ? (entry.error && entry.error.type) || null : null
  };
}

// entries: array of { sourceName, status: 'success' | 'failed', product: normalizedRecord | null, error: { type, message } | null }
// options.priorityOrder: optional override of DEFAULT_SOURCE_PRIORITY (for testing or future configurability)
function selectBestSource(entries = [], options = {}) {
  const priorityOrder = options.priorityOrder || DEFAULT_SOURCE_PRIORITY;
  const attempted = entries.map(summarizeAttempt);

  const successEntries = entries.filter((entry) => entry.status === 'success' && entry.product);

  if (successEntries.length === 0) {
    return {
      status: 'NO_USABLE_SOURCE',
      product: null,
      provenance: null,
      attempted
    };
  }

  const ranked = rankEntries(successEntries, priorityOrder);
  const primary = ranked[0];

  const merged = { ...createEmptyProductRecord(), ...primary.product };
  const fieldSources = {};
  const conflicts = [];

  for (const field of Object.keys(createEmptyProductRecord())) {
    if (NON_MERGEABLE_FIELDS.has(field)) continue;
    if (isPopulated(merged[field])) {
      fieldSources[field] = primary.sourceName;
    }
  }

  for (let i = 1; i < ranked.length; i += 1) {
    const entry = ranked[i];
    for (const field of Object.keys(createEmptyProductRecord())) {
      if (NON_MERGEABLE_FIELDS.has(field)) continue;
      const candidateValue = entry.product[field];
      if (!isPopulated(candidateValue)) continue;

      if (!isPopulated(merged[field])) {
        // Partial-data case: fill a gap the higher-ranked source(s) left null.
        merged[field] = candidateValue;
        fieldSources[field] = entry.sourceName;
        continue;
      }

      // Both this source and the already-chosen source have an explicit,
      // non-null value for this field. If they differ, that is a genuine
      // conflict — document it, but do not average or guess: the
      // already-chosen (higher-ranked) value wins, per the deterministic
      // priority rule.
      const chosenValue = merged[field];
      const valuesDiffer = Array.isArray(chosenValue) || Array.isArray(candidateValue)
        ? JSON.stringify(chosenValue) !== JSON.stringify(candidateValue)
        : chosenValue !== candidateValue;

      if (valuesDiffer) {
        conflicts.push({
          field,
          chosenSource: fieldSources[field],
          chosenValue,
          conflictingSource: entry.sourceName,
          conflictingValue: candidateValue
        });
      }
    }
  }

  return {
    status: 'SUCCESS',
    product: merged,
    provenance: {
      primarySource: primary.sourceName,
      ranking: ranked.map((entry) => entry.sourceName),
      fieldSources,
      conflicts
    },
    attempted
  };
}

module.exports = {
  selectBestSource,
  rankEntries,
  DEFAULT_SOURCE_PRIORITY
};
