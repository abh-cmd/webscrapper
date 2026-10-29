// Wires the AI provider's paraphrase() into the normalized-record shape.
// Per the requirements document: "Do not directly copy the Product
// Description & Food Pairing from the source website... All other fields
// can be extracted directly from the source where available." — so only
// these two fields are ever paraphrased; everything else in the
// normalized record passes through completely unchanged.

const { validateParaphraseResult } = require('./response-validator');

// A provider result that fails the response-validator safety net (a
// malformed shape, or a paraphrase that appears to have invented a fact —
// see response-validator.js) is never trusted: the original, verbatim
// source text is kept instead, and the rejection is recorded in
// aiMetadata.rejectedFields so it stays visible, not silently swallowed.
//
// A provider that THROWS (network failure, timeout, HTTP error, malformed
// JSON — the real HTTP provider's failure modes, see http-llm-provider.js)
// is handled the same way: the source text was already real and correct
// before AI ever got involved, so an AI outage falls back to it rather
// than crashing the ingest pipeline. The crawl's own data is never lost
// because the AI stage failed.
// onRaw(kind, rawResultOrError) is a purely observational side-channel —
// it never changes what this function returns or how a rejection is
// decided. It exists so a caller (the live-pipeline UI) can display the
// actual, unfiltered provider response next to the application's
// accept/reject decision, without this function's own contract changing
// for any existing caller (both params are optional, default no-ops).
async function safeParaphrase(provider, { text, kind }, onRaw = () => {}) {
  let result;
  try {
    result = await provider.paraphrase({ text, kind });
    onRaw(kind, { ok: true, response: result });
  } catch (error) {
    onRaw(kind, { ok: false, error: { type: error.type || error.name || 'error', message: error.message } });
    return {
      text,
      changed: false,
      provider: 'unavailable',
      model: null,
      kind,
      rejected: true,
      rejectionReason: `AI provider call failed (${error.type || error.name || 'error'}): ${error.message}`
    };
  }

  const validation = validateParaphraseResult(result, text);
  if (!validation.valid) {
    return {
      text,
      changed: false,
      provider: result?.provider || 'unknown',
      model: result?.model || null,
      kind,
      rejected: true,
      rejectionReason: validation.reason
    };
  }
  return result;
}

async function enrichProduct(normalizedProduct, provider, { onRaw } = {}) {
  const rawCallback = onRaw || (() => {});
  const descriptionResult = await safeParaphrase(provider, { text: normalizedProduct.product_description, kind: 'description' }, rawCallback);
  const foodPairingResult = await safeParaphrase(provider, { text: normalizedProduct.food_pairing, kind: 'food_pairing' }, rawCallback);

  const enriched = {
    ...normalizedProduct,
    product_description: descriptionResult.text,
    food_pairing: foodPairingResult.text
  };

  const paraphrasedFields = [];
  if (descriptionResult.changed) paraphrasedFields.push('product_description');
  if (foodPairingResult.changed) paraphrasedFields.push('food_pairing');

  const rejectedFields = [];
  if (descriptionResult.rejected) rejectedFields.push({ field: 'product_description', reason: descriptionResult.rejectionReason });
  if (foodPairingResult.rejected) rejectedFields.push({ field: 'food_pairing', reason: foodPairingResult.rejectionReason });

  // Report whichever call actually reached the provider, in case one of
  // the two fields failed (provider: 'unavailable') while the other one
  // succeeded — the metadata should reflect the real provider that did
  // the work, not just whichever of the two calls happens to be listed first.
  const reportedResult = descriptionResult.provider !== 'unavailable' ? descriptionResult : foodPairingResult;

  return {
    enriched,
    aiMetadata: {
      provider: reportedResult.provider,
      model: reportedResult.model,
      paraphrasedFields,
      rejectedFields,
      original: {
        product_description: normalizedProduct.product_description,
        food_pairing: normalizedProduct.food_pairing
      }
    }
  };
}

module.exports = { enrichProduct };
