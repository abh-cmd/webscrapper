// The AI provider contract every provider implementation must satisfy.
// This file is documentation-as-code (JSDoc), not itself an
// implementation — see providers/deterministic-test-provider.js and
// providers/http-llm-provider.js.
//
// paraphrase({ text, kind }) -> Promise<{ text, changed, provider, model }>
//   kind is 'description' | 'food_pairing'. Must never fabricate content
//   not present in the source text — restructure/reword only.
//
// analyzeProduct(product) -> Promise<{ findings: Finding[], provider, model }>
//   Finding: { field, currentValue, suggestedValue, confidence (0-100), reason }
//   Must never invent a finding without a concrete, stated reason. A
//   provider with nothing to flag returns findings: [].

module.exports = {};
