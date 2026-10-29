// A safety net that runs on EVERY AI provider's output — deterministic-test
// and http-llm alike — before it is trusted anywhere downstream. Two
// distinct concerns:
//
// 1. Structural validation: is this even a well-formed result? (known
//    schema field, confidence in [0,100], provider/model tags present).
//    A provider that returns garbage must not silently propagate garbage.
// 2. A best-effort "did this introduce a fact that wasn't there before"
//    heuristic for paraphrasing — NOT a semantic fact-checker (that would
//    require another AI call, which defeats the purpose of a safety net),
//    just a concrete, explainable check: no new digit sequences (which is
//    what ABV/vintage/price/quantity claims look like) and no wild length
//    expansion. A provider that fails this is not trusted for this
//    request — enrichment.js falls back to the original text rather than
//    propagating a suspicious rewrite.

const { createEmptyProductRecord } = require('../schema/product-schema');

const KNOWN_FIELDS = new Set(Object.keys(createEmptyProductRecord()));
const NOT_CORRECTABLE_FIELDS = new Set(['item_number', 'source_site', 'source_url', 'scraped_at']);

function extractDigitSequences(text) {
  return new Set((text || '').match(/\d+(\.\d+)?/g) || []);
}

// Returns { valid, reason } — reason is set only when valid is false, and
// is written to be a useful log line, not user-facing copy.
function validateParaphraseResult(result, originalText) {
  if (!result || typeof result !== 'object') return { valid: false, reason: 'Provider returned a non-object result.' };
  if (result.text === null || result.text === undefined) {
    return { valid: true }; // a provider legitimately returning "nothing to paraphrase" is fine
  }
  if (typeof result.text !== 'string') return { valid: false, reason: 'Provider result.text is not a string.' };
  if (!result.provider || typeof result.provider !== 'string') return { valid: false, reason: 'Provider result is missing a provider tag.' };

  if (originalText) {
    const originalDigits = extractDigitSequences(originalText);
    const newDigits = extractDigitSequences(result.text);
    for (const digit of newDigits) {
      if (!originalDigits.has(digit)) {
        return { valid: false, reason: `Paraphrase introduced a number ("${digit}") that was not present in the original text — possible fabricated fact.` };
      }
    }

    if (result.text.length > originalText.length * 2.5) {
      return { valid: false, reason: `Paraphrase is more than 2.5x longer than the original (${result.text.length} vs ${originalText.length} chars) — likely invented content, not a rewrite.` };
    }
  }

  return { valid: true };
}

// Returns { valid, reason, filteredFindings } — filteredFindings drops any
// individual finding that fails structural validation while keeping the
// rest, since one malformed finding from a provider shouldn't discard
// every other genuinely useful one in the same response.
function validateAnalysisResult(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.findings)) {
    return { valid: false, reason: 'Provider result is missing a findings array.', filteredFindings: [] };
  }
  if (!result.provider || typeof result.provider !== 'string') {
    return { valid: false, reason: 'Provider result is missing a provider tag.', filteredFindings: [] };
  }

  const filteredFindings = [];
  const droppedReasons = [];

  for (const finding of result.findings) {
    if (!finding || typeof finding !== 'object') { droppedReasons.push('a finding was not an object'); continue; }
    if (!KNOWN_FIELDS.has(finding.field)) { droppedReasons.push(`unknown field "${finding.field}"`); continue; }
    if (NOT_CORRECTABLE_FIELDS.has(finding.field)) { droppedReasons.push(`a finding targeted the not-correctable field "${finding.field}"`); continue; }
    if (typeof finding.confidence !== 'number' || Number.isNaN(finding.confidence) || finding.confidence < 0 || finding.confidence > 100) {
      droppedReasons.push(`confidence out of range for field "${finding.field}"`);
      continue;
    }
    if (!finding.reason || typeof finding.reason !== 'string') { droppedReasons.push(`missing reason for field "${finding.field}"`); continue; }
    filteredFindings.push(finding);
  }

  return {
    valid: droppedReasons.length === 0,
    reason: droppedReasons.length > 0 ? droppedReasons.join('; ') : null,
    filteredFindings
  };
}

module.exports = { validateParaphraseResult, validateAnalysisResult, KNOWN_FIELDS, NOT_CORRECTABLE_FIELDS };
