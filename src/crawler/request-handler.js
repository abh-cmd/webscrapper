const { logSimple } = require('../utils/logging');
const { resolveSource } = require('../sources/source-registry');
const { normalizeProductRecord } = require('../schema/product-schema');

async function handleRequest({ request, page, context }) {
  const sourceConfig = context.sourceConfig || {};
  // Prefer the name already resolved upstream by the crawler (which may
  // have come from hostname-based URL detection rather than an explicit
  // sourceConfig.name); fall back to the pre-Phase-3 formula for any other
  // caller that invokes handleRequest directly.
  const sourceName = context.sourceName || sourceConfig.name || 'example-source';
  const item = context.productInput || {};
  const onStage = context.onStage || (() => {});

  try {
    onStage('extraction', 'running', { sourceName, url: sourceConfig.url });
    // Prefer the adapter object already resolved upstream by crawler.js
    // (which may be a dynamically-built generic adapter for a hostname
    // that isn't one of the four named production sources, and therefore
    // isn't a lookup key in the static registry — see source-registry.js
    // createGenericAdapter()). Re-resolving by name here is only a
    // fallback for callers that invoke handleRequest directly without
    // going through crawler.js's resolution.
    const sourceAdapter = context.sourceAdapter || resolveSource({ name: sourceName });
    const rawData = await sourceAdapter.extract({
      page,
      context: {
        ...context,
        item_number: item.item_number,
        size: item.size,
        vintage: item.vintage,
        sourceName,
        sourceUrl: sourceConfig.url
      }
    });

    if (!rawData || typeof rawData !== 'object') {
      throw new Error('Extraction returned no data');
    }

    logSimple('Extraction started');

    const meta = rawData.__meta || null;
    onStage('extraction', 'completed', { raw: rawData });

    onStage('normalization', 'running', {});
    const normalized = normalizeProductRecord({
      ...rawData,
      item_number: item.item_number || rawData.item_number,
      item_name: item.item_name || rawData.item_name,
      size: item.size || rawData.size,
      vintage: item.vintage || rawData.vintage,
      source_site: sourceName,
      source_url: sourceConfig.url,
      scraped_at: new Date().toISOString()
    });
    onStage('normalization', 'completed', { raw: rawData, normalized });

    logSimple('Extraction completed');
    return {
      success: true,
      data: normalized,
      rawData,
      meta,
      sourceName,
      sourceUrl: sourceConfig.url
    };
  } catch (error) {
    logSimple(`Extraction failed: ${error.message}`);
    onStage('extraction', 'failed', { error: error.message, challengeType: error.challengeType || null });
    return {
      success: false,
      error: {
        type: error.type || error.name || 'ExtractionError',
        message: error.message,
        httpStatus: typeof error.httpStatus === 'number' ? error.httpStatus : null,
        challengeType: error.challengeType || null
      }
    };
  }
}

module.exports = {
  handleRequest
};
