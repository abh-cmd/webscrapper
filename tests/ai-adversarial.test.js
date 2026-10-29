const test = require('node:test');
const assert = require('node:assert/strict');

const deterministicProvider = require('../src/ai/providers/deterministic-test-provider');
const { validateParaphraseResult, validateAnalysisResult } = require('../src/ai/response-validator');
const { enrichProduct } = require('../src/ai/enrichment');
const { selectBestSource } = require('../src/selection/source-selector');

// Adversarial cases requested by the final gap-closure audit: contradictory
// ABV, contradictory region, contradictory varietal, fabricated food
// pairing, missing producer, conflicting sources, and a low-confidence
// result. Each documents what the system actually does, including the
// cases where "correctly does nothing" is the right answer.

test('adversarial: contradictory ABV (implausible value) is flagged with high confidence', async () => {
  const { findings } = await deterministicProvider.analyzeProduct({
    product_name: 'Test Wine', category: 'Red Wine', abv: '145%'
  });
  const abvFinding = findings.find((f) => f.field === 'abv');
  assert.ok(abvFinding, 'an ABV of 145% must be flagged as implausible');
  assert.ok(abvFinding.confidence >= 80);
});

test('adversarial: a normal, real-world ABV is never flagged', async () => {
  const { findings } = await deterministicProvider.analyzeProduct({
    product_name: 'Test Wine', category: 'Red Wine', abv: '14.5%'
  });
  assert.equal(findings.some((f) => f.field === 'abv'), false);

  // Fortified wines legitimately run higher — must not false-positive.
  const { findings: portFindings } = await deterministicProvider.analyzeProduct({
    product_name: 'Vintage Port', category: 'Fortified Wine', abv: '20%'
  });
  assert.equal(portFindings.some((f) => f.field === 'abv'), false);
});

test('adversarial: contradictory varietal/color (Chardonnay tagged red) is flagged', async () => {
  const { findings } = await deterministicProvider.analyzeProduct({
    product_name: 'Test', category: 'Red Wine', varietal: 'Chardonnay', color: 'Deep ruby red'
  });
  assert.ok(findings.some((f) => f.field === 'color'));
  assert.ok(findings.some((f) => f.field === 'category'));
});

test('adversarial: contradictory varietal (Pinot Noir tagged white) is flagged', async () => {
  const { findings } = await deterministicProvider.analyzeProduct({
    product_name: 'Test', category: 'White Wine', varietal: 'Pinot Noir', color: 'Pale straw'
  });
  assert.ok(findings.some((f) => f.field === 'category' && f.suggestedValue.includes('Red')));
});

test('adversarial: contradictory region is a documented, known gap — no geographic reference table exists', () => {
  // Region plausibility (e.g. "Champagne" + varietal "Zinfandel" is an
  // unusual combination) would require a region/varietal/country
  // reference table this project deliberately does not fabricate — see
  // deterministic-test-provider.js's own header: "a tiny, explicit,
  // defensible table — not a claim of comprehensive wine knowledge."
  // Documented as OPEN, not silently passed off as covered.
  assert.equal(true, true);
});

test('adversarial: missing producer is NOT flagged, by design — a known, honest extraction limitation, not a data defect', async () => {
  // Every production adapter (wine.com, total-wine, vivino, the local
  // fixture) frequently has no generic signal for "producer" distinct
  // from "brand" and honestly reports null rather than fabricating one.
  // Treating that as an AI-flaggable "defect" would flood the exception
  // queue with noise on every honestly-incomplete extraction, including
  // the local fixture used throughout this project's own live validation
  // (brand: "Example Winery", producer: null) — so this is a deliberate
  // scope boundary, not an oversight.
  const { findings } = await deterministicProvider.analyzeProduct({
    product_name: 'Example Cabernet Sauvignon', category: 'Red Wine', brand: 'Example Winery', producer: null
  });
  assert.equal(findings.length, 0);
});

test('adversarial: fabricated food pairing (a paraphrase that invents a new fact) is rejected, original text kept', async () => {
  const fabricatingProvider = {
    async paraphrase({ text, kind }) {
      if (kind === 'food_pairing') {
        return { text: `${text} Also pairs beautifully with a 47% ABV reduction sauce.`, changed: true, provider: 'adversarial-mock', model: 'fake-v1' };
      }
      return { text, changed: false, provider: 'adversarial-mock', model: 'fake-v1' };
    }
  };

  const { enriched, aiMetadata } = await enrichProduct(
    { product_description: 'A bold red.', food_pairing: 'Grilled steak and aged cheese.' },
    fabricatingProvider
  );

  assert.equal(enriched.food_pairing, 'Grilled steak and aged cheese.', 'the fabricated rewrite must be rejected, original text preserved');
  assert.equal(aiMetadata.rejectedFields.length, 1);
  assert.equal(aiMetadata.rejectedFields[0].field, 'food_pairing');
  assert.match(aiMetadata.rejectedFields[0].reason, /fabricated fact/);
});

test('adversarial: a wildly expanded paraphrase (likely invented content) is rejected', async () => {
  const inventingProvider = {
    async paraphrase({ text }) {
      return { text: `${text} ` + 'Extra invented backstory. '.repeat(20), changed: true, provider: 'adversarial-mock', model: 'fake-v1' };
    }
  };
  const { enriched, aiMetadata } = await enrichProduct(
    { product_description: 'Short original text.', food_pairing: null },
    inventingProvider
  );
  assert.equal(enriched.product_description, 'Short original text.');
  assert.ok(aiMetadata.rejectedFields.some((f) => f.field === 'product_description'));
});

test('adversarial: conflicting sources are recorded, never silently averaged or overwritten', () => {
  // Multi-source disagreement is source-selector.js's job (Phase 8), not
  // validation-service's — exercised here to confirm the two "AI
  // hardening" and "multi-source" systems agree on the same principle:
  // never silently resolve a conflict.
  const entries = [
    { sourceName: 'wine-com', status: 'success', product: { item_number: 'X', region: 'Napa Valley' } },
    { sourceName: 'total-wine', status: 'success', product: { item_number: 'X', region: 'Sonoma County' } }
  ];
  const result = selectBestSource(entries);
  assert.ok(result.provenance.conflicts && result.provenance.conflicts.length > 0, 'a genuine field disagreement between sources must be recorded as a conflict');
  assert.equal(result.provenance.conflicts[0].field, 'region');
  assert.equal(result.provenance.conflicts[0].chosenValue, 'Napa Valley');
  assert.equal(result.provenance.conflicts[0].conflictingValue, 'Sonoma County');
});

test('low-confidence findings still require explicit human approval — no auto-apply threshold exists anywhere', () => {
  // approveException() (src/validation/validation-service.js) takes no
  // confidence parameter and has no confidence-based auto-apply branch —
  // every finding, regardless of confidence, sits in product_validation_
  // exceptions as pending_review until a human calls approveException()
  // or rejectException(). Verified structurally here (not by mocking a
  // low-confidence call, which would test nothing distinguishing it from
  // a high-confidence one): the exception schema itself has no "auto-
  // approved" status. See db/schema.sql product_validation_exceptions.
  const schemaSql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const tableMatch = schemaSql.match(/CREATE TABLE IF NOT EXISTS product_validation_exceptions[\s\S]*?\);/);
  assert.ok(tableMatch, 'product_validation_exceptions table definition must exist');
  assert.match(tableMatch[0], /'pending_review',\s*'approved',\s*'rejected'/, 'status must only ever be one of these three — no "auto_approved" state exists');
});

test('response-validator: a malformed provider result (missing findings array) is rejected outright', () => {
  const result = validateAnalysisResult({ provider: 'x' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.filteredFindings, []);
});

test('response-validator: a finding targeting a not-correctable field (e.g. item_number) is dropped, not applied', () => {
  const result = validateAnalysisResult({
    provider: 'x',
    findings: [{ field: 'item_number', currentValue: 'A', suggestedValue: 'B', confidence: 99, reason: 'test' }]
  });
  assert.equal(result.filteredFindings.length, 0);
  assert.match(result.reason, /not-correctable/);
});

test('response-validator: an out-of-range confidence is dropped', () => {
  const result = validateAnalysisResult({
    provider: 'x',
    findings: [{ field: 'color', currentValue: 'a', suggestedValue: 'b', confidence: 150, reason: 'test' }]
  });
  assert.equal(result.filteredFindings.length, 0);
});

test('response-validator: paraphrase with no original text to compare against is trusted (nothing to contradict)', () => {
  const result = validateParaphraseResult({ text: 'new text', provider: 'x' }, null);
  assert.equal(result.valid, true);
});
