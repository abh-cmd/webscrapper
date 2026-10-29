// The full ingestion pipeline for a NEWLY SCRAPED product, per the
// requirements document's flow: Extract -> Normalize -> AI enrichment ->
// Review/staging -> (approval happens separately, see
// src/staging/staging-repository.js) -> Master mapping (post-approval
// only, see src/master-data/) -> Production.
//
// This function stops at staging — it deliberately never calls
// productRepo.upsertProduct itself. Only approveStaging() may write to
// `products`, so there is exactly one path by which scraped data can
// reach production, and it always passes through human/backend approval.

const { runCrawl } = require('../crawler/crawler');
const { enrichProduct } = require('../ai/enrichment');
const { stageProduct } = require('../staging/staging-repository');
const { getAiProvider } = require('../ai/provider-factory');

async function ingestProduct(productInput, overrideUrl, { provider } = {}) {
  const aiProvider = provider || getAiProvider();

  const crawlResult = await runCrawl(productInput, overrideUrl);
  if (crawlResult.status !== 'success') {
    return { status: crawlResult.status, crawlResult, staging: null };
  }

  const extractedProduct = crawlResult.product; // normalized, pre-AI-enrichment — this is "the original extracted data"
  const { enriched, aiMetadata } = await enrichProduct(extractedProduct, aiProvider);

  const staging = await stageProduct({
    itemNumber: extractedProduct.item_number,
    runId: crawlResult.run_id,
    sourceSite: extractedProduct.source_site,
    sourceUrl: extractedProduct.source_url,
    rawExtracted: extractedProduct,
    normalized: enriched,
    aiMetadata
  });

  return { status: 'staged', crawlResult, staging };
}

module.exports = { ingestProduct };
