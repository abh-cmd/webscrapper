// A deterministic, NON-AI stand-in implementing the same interface a real
// LLM provider would. Exists so the paraphrasing/validation pipeline can
// be built, wired, and tested end to end without a configured API key —
// per instructions, this must never be mistaken for or reported as real
// AI output. Every result is tagged { provider: 'deterministic-test' } so
// it is always traceable and can never silently pass as genuine AI
// enrichment.
//
// Paraphrasing: a fixed synonym-substitution table — genuinely
// deterministic (same input always produces the same output), genuinely
// different from the source text (proving "not a direct copy" end to
// end), but explicitly NOT semantic rewriting. A real provider (see
// http-llm-provider.js) would do materially better paraphrasing; this
// only proves the pipeline works.
//
// Validation: real, rule-based consistency checks (not fabricated) —
// e.g. a wine varietal implying a color that contradicts the stored
// color. Genuinely useful on its own, and exactly the kind of check that
// doesn't require a real LLM call.

const SYNONYM_RULES = [
  [/\bnotes of\b/gi, 'hints of'],
  [/\bflavou?rs? of\b/gi, 'flavor notes of'],
  [/\bpairs? well with\b/gi, 'is a great match for'],
  [/\bpairs? with\b/gi, 'complements'],
  [/\bdelicious\b/gi, 'enjoyable'],
  [/\bsmooth\b/gi, 'silky'],
  [/\bfull-bodied\b/gi, 'rich and full-bodied'],
  [/\bcrisp\b/gi, 'bright and crisp'],
  [/\brich\b/gi, 'lush'],
  [/\bfinish\b/gi, 'aftertaste'],
  [/\bgreat\b/gi, 'excellent'],
  [/\bbold\b/gi, 'assertive'],
  [/\bexcellent\b/gi, 'outstanding']
];

async function paraphrase({ text, kind }) {
  if (!text) {
    return { text: null, changed: false, provider: 'deterministic-test', model: 'synonym-substitution-v1' };
  }

  let rewritten = text;
  for (const [pattern, replacement] of SYNONYM_RULES) {
    rewritten = rewritten.replace(pattern, replacement);
  }

  return {
    text: rewritten,
    changed: rewritten !== text,
    provider: 'deterministic-test',
    model: 'synonym-substitution-v1',
    kind
  };
}

// Grape varieties that are unambiguously one color family. A tiny,
// explicit, defensible table — not a claim of comprehensive wine
// knowledge, just enough to demonstrate a genuine (if narrow) consistency
// check without an LLM.
const VARIETAL_COLOR_EXPECTATIONS = {
  'cabernet sauvignon': 'red',
  merlot: 'red',
  'pinot noir': 'red',
  malbec: 'red',
  syrah: 'red',
  shiraz: 'red',
  zinfandel: 'red',
  sangiovese: 'red',
  chardonnay: 'white',
  'sauvignon blanc': 'white',
  riesling: 'white',
  'pinot grigio': 'white',
  'pinot gris': 'white',
  moscato: 'white',
  gewurztraminer: 'white'
};

function colorFamilyOf(colorText) {
  if (!colorText) return null;
  const lower = colorText.toLowerCase();
  if (/\bred\b|ruby|garnet|crimson/.test(lower)) return 'red';
  if (/\bwhite\b|straw|golden|pale yellow/.test(lower)) return 'white';
  if (/ros[ée]|pink|salmon/.test(lower)) return 'rose';
  return null;
}

async function analyzeProduct(product) {
  const findings = [];

  // Required-field completeness (a real, if simple, consistency check).
  for (const field of ['product_name', 'category']) {
    if (!product[field]) {
      findings.push({
        field,
        currentValue: null,
        suggestedValue: null,
        confidence: 100,
        reason: `${field} is missing entirely — every catalog product needs this field.`
      });
    }
  }

  // Varietal vs. color consistency.
  if (product.varietal && product.color) {
    const varietalKey = product.varietal.toLowerCase().trim();
    const expectedFamily = VARIETAL_COLOR_EXPECTATIONS[varietalKey];
    const actualFamily = colorFamilyOf(product.color);
    if (expectedFamily && actualFamily && expectedFamily !== actualFamily) {
      findings.push({
        field: 'color',
        currentValue: product.color,
        suggestedValue: expectedFamily,
        confidence: 85,
        reason: `Varietal "${product.varietal}" is conventionally a ${expectedFamily} wine grape, but color is recorded as "${product.color}".`
      });
    }
  }

  // Varietal vs. category consistency (same signal, different field).
  if (product.varietal && product.category) {
    const varietalKey = product.varietal.toLowerCase().trim();
    const expectedFamily = VARIETAL_COLOR_EXPECTATIONS[varietalKey];
    const categoryLower = product.category.toLowerCase();
    if (expectedFamily === 'red' && categoryLower.includes('white')) {
      findings.push({
        field: 'category',
        currentValue: product.category,
        suggestedValue: product.category.replace(/white/i, 'Red'),
        confidence: 80,
        reason: `Varietal "${product.varietal}" is conventionally a red wine grape, but category is "${product.category}".`
      });
    }
    if (expectedFamily === 'white' && categoryLower.includes('red')) {
      findings.push({
        field: 'category',
        currentValue: product.category,
        suggestedValue: product.category.replace(/red/i, 'White'),
        confidence: 80,
        reason: `Varietal "${product.varietal}" is conventionally a white wine grape, but category is "${product.category}".`
      });
    }
  }

  // ABV plausibility. Wine, including fortified styles, does not exceed
  // roughly 24% ABV — a value outside a generous [0, 24] range is far more
  // likely a scraping/OCR/unit error (e.g. "14.5" captured as "145", or a
  // stray percent sign) than a real bottle. Deliberately generous bounds:
  // this is a sanity check, not a style-specific rule (a 10.5% Moscato and
  // a 20% fortified Port are both valid, so this never fires on real data
  // — only on values no wine could plausibly have).
  if (product.abv) {
    const parsed = Number(String(product.abv).replace('%', '').trim());
    if (!Number.isNaN(parsed) && (parsed < 0 || parsed > 24)) {
      findings.push({
        field: 'abv',
        currentValue: product.abv,
        suggestedValue: null,
        confidence: 90,
        reason: `ABV "${product.abv}" is outside the plausible range for wine (0-24%) — likely a scraping or unit error, not a real value.`
      });
    }
  }

  return { findings, provider: 'deterministic-test', model: 'rule-based-consistency-v1' };
}

module.exports = { paraphrase, analyzeProduct, VARIETAL_COLOR_EXPECTATIONS };
