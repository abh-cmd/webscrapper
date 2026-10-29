const test = require('node:test');
const assert = require('node:assert/strict');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');

const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

test('ingest pipeline: a real crawl (Phase 1 fixture) is enriched and staged, never written directly to products', { skip }, async (t) => {
  const { ingestProduct } = require('../src/pipeline/ingest-product');
  const stagingRepo = require('../src/staging/staging-repository');
  const productRepo = require('../src/db/product-repository');
  const deterministicProvider = require('../src/ai/providers/deterministic-test-provider');

  const pool = getPool();
  // Clean slate: WO-10001 may already exist in `products` from earlier,
  // unrelated demo/test runs in this project. Since the deterministic
  // paraphraser is, by design, deterministic (same source text always
  // produces the same rewritten text — see ai-provider.test.js), a
  // leftover row from a prior run of this exact test could legitimately
  // already carry the same enriched text, making a "not yet promoted"
  // equality check meaningless. Start from a known-empty state instead.
  await productRepo.deleteProductByItemNumber('WO-10001');
  t.after(async () => {
    await pool.query("DELETE FROM product_staging WHERE item_number = 'WO-10001';");
    await closePool();
  });

  const productInput = require('../input/sample-product.json');
  const result = await ingestProduct(productInput, productInput.source.url, { provider: deterministicProvider });

  assert.equal(result.status, 'staged');
  assert.equal(result.crawlResult.status, 'success');
  assert.ok(result.staging.id);
  assert.equal(result.staging.status, 'pending_review');

  // The staged, AI-enriched description must differ from the raw extracted
  // one — proving paraphrasing genuinely ran as part of the pipeline, not
  // just as an isolated unit.
  assert.notEqual(result.staging.normalized.product_description, result.staging.rawExtracted.product_description);
  assert.ok(result.staging.aiMetadata.paraphrasedFields.includes('product_description'));

  // Still not in production — confirmed against the known-empty slate above.
  const notYetInProduction = await productRepo.getProductByItemNumber('WO-10001');
  assert.equal(notYetInProduction, null, 'a pending-review staging record must not appear in products before approval');

  const { product } = await stagingRepo.approveStaging(result.staging.id, { reviewer: 'pipeline-test@example.com' });
  assert.equal(product.product_description, result.staging.normalized.product_description);

  const inProduction = await productRepo.getProductByItemNumber('WO-10001');
  assert.equal(inProduction.product_description, result.staging.normalized.product_description);
});
