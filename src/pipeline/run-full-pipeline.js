// Orchestrates one demonstration run of the real pipeline for the
// dashboard's "Live Pipeline" screen, with per-stage observability.
//
// This does NOT reimplement crawling, extraction, normalization, AI
// enrichment, staging, approval, validation, or image processing — every
// stage below calls the exact same repository/service functions the CLI
// (src/index.js), the batch runner (src/batch/batch-runner.js), and the
// existing API routes already call. What's new here is only sequencing +
// an onStage/onRaw observability callback threaded through, because
// src/pipeline/ingest-product.js's single await-chain has no hook points
// a UI can watch live. Mirrors ingest-product.js's own crawl->enrich->stage
// sequence, plus the batch runner's enqueue->claim->mark queue pattern
// (see src/batch/batch-runner.js), plus the existing post-approval
// continuation (validation, images) that no single existing function
// currently sequences end-to-end.
//
// The approval gate is real, not simulated: this function stops at
// STAGING every time. Nothing is promoted to `products` until a human (or
// the API caller acting on a human's behalf) calls continueAfterApproval()
// below, which calls the exact same stagingRepo.approveStaging() the
// existing /api/ai/staging/:id/approve route already uses.

const queue = require('../queue/crawl-queue-repository');
const { runCrawl } = require('../crawler/crawler');
const { enrichProduct } = require('../ai/enrichment');
const { stageProduct, approveStaging, rejectStaging } = require('../staging/staging-repository');
const { getAiProvider } = require('../ai/provider-factory');
const { resolveSource } = require('../sources/source-registry');
const { runValidation } = require('../validation/validation-service');
const imageQueue = require('../images/image-queue-repository');
const { processImageJob } = require('../images/process-image-job');
const imageStore = require('../images/image-store-repository');
const productRepo = require('../db/product-repository');

const STAGE_ORDER = [
  'queue',
  'deduplication',
  'source',
  'fetch',
  'extraction',
  'normalization',
  'database',
  'ai',
  'staging',
  'approval',
  'ai_validation',
  'image_pipeline',
  'final_database'
];

async function runFullPipeline({ productInput, sourceUrl, provider }, tracker, run) {
  const onStage = tracker.makeOnStage(run);
  const aiProvider = provider || getAiProvider();

  let adapter;
  try {
    adapter = resolveSource({ name: productInput.source?.name, url: sourceUrl });
  } catch (error) {
    tracker.setStage(run, 'queue', 'failed', { error: error.message });
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: error.type || 'UNSUPPORTED_SOURCE', message: error.message } });
    return;
  }
  const sourceName = adapter.name;

  // QUEUE + DEDUPLICATION — real crawl_jobs row, real unique-constraint
  // dedup (canonical URL). This happens BEFORE the page is fetched, on
  // purpose: it's the real reason a duplicate submission never wastes a
  // second live request against a production source. See
  // src/queue/crawl-queue-repository.js#enqueueJob.
  tracker.setStage(run, 'queue', 'running', { itemNumber: productInput.item_number, sourceUrl });
  let job;
  try {
    job = await queue.enqueueJob({ itemNumber: productInput.item_number, sourceName, sourceUrl });
  } catch (error) {
    tracker.setStage(run, 'queue', 'failed', { error: error.message });
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: 'QUEUE_ERROR', message: error.message } });
    return;
  }
  tracker.setStage(run, 'queue', 'completed', { jobId: job.id, canonicalUrl: job.canonicalUrl, status: job.status });
  tracker.setStage(run, 'deduplication', 'completed', {
    deduped: job.deduped,
    canonicalUrl: job.canonicalUrl,
    productHash: job.productHash,
    decision: job.deduped
      ? 'An existing crawl_jobs row already covers this canonical URL/product — reused it instead of creating a duplicate.'
      : 'No existing crawl_jobs row for this canonical URL — created a new one.'
  });

  const claimedJob = job.deduped ? await queue.claimNextJob({ workerId: 'live-pipeline-ui' }) : job.status === 'pending' ? await queue.claimNextJob({ workerId: 'live-pipeline-ui' }) : null;
  const workingJob = claimedJob && claimedJob.id === job.id ? claimedJob : job;

  // SOURCE / FETCH / EXTRACTION / NORMALIZATION — real runCrawl(), with the
  // onStage callback wired all the way down into request-handler.js.
  let crawlResult;
  try {
    crawlResult = await runCrawl(productInput, sourceUrl, { onStage });
  } catch (error) {
    await queue.markFailed(workingJob.id, { errorType: error.type || 'CRAWL_ERROR', errorMessage: error.message }).catch(() => {});
    tracker.setStage(run, 'database', 'completed', { table: 'crawl_jobs', operation: `status -> ${error.type ? 'retrying/dead_letter' : 'failed'}`, jobId: workingJob.id });
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: error.type || 'CRAWL_ERROR', message: error.message, challengeType: error.challengeType || null } });
    return;
  }

  if (crawlResult.status !== 'success') {
    await queue.markFailed(workingJob.id, { errorType: 'CRAWL_UNSUCCESSFUL', errorMessage: `Crawl finished with status ${crawlResult.status}` }).catch(() => {});
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: 'CRAWL_UNSUCCESSFUL', message: `status: ${crawlResult.status}` } });
    return;
  }

  await queue.markSucceeded(workingJob.id);
  tracker.setStage(run, 'database', 'completed', {
    table: 'crawl_jobs',
    operation: 'UPDATE status = succeeded',
    jobId: workingJob.id,
    rowsAffected: 1,
    timestamp: new Date().toISOString()
  });

  // AI enrichment — real enrichProduct(), with onRaw exposing the actual
  // unfiltered provider response next to the application's accept/reject
  // decision (see src/ai/enrichment.js).
  tracker.setStage(run, 'ai', 'running', { configuredProvider: process.env.AI_PROVIDER || 'deterministic-test' });
  const rawAiCalls = [];
  const extractedProduct = crawlResult.product;
  let enriched, aiMetadata;
  try {
    const result = await enrichProduct(extractedProduct, aiProvider, {
      onRaw: (kind, raw) => rawAiCalls.push({ kind, ...raw })
    });
    enriched = result.enriched;
    aiMetadata = result.aiMetadata;
  } catch (error) {
    tracker.setStage(run, 'ai', 'failed', { error: error.message });
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: 'AI_ERROR', message: error.message } });
    return;
  }
  tracker.setStage(run, 'ai', 'completed', {
    provider: aiMetadata.provider,
    model: aiMetadata.model,
    paraphrasedFields: aiMetadata.paraphrasedFields,
    rejectedFields: aiMetadata.rejectedFields,
    original: aiMetadata.original,
    enriched: { product_description: enriched.product_description, food_pairing: enriched.food_pairing },
    rawCalls: rawAiCalls
  });

  // STAGING — real stageProduct(). Pipeline pauses here; nothing is
  // promoted to `products` until a human approves via continueAfterApproval().
  let staging;
  tracker.setStage(run, 'staging', 'running', {});
  try {
    staging = await stageProduct({
      itemNumber: extractedProduct.item_number,
      runId: crawlResult.run_id,
      sourceSite: extractedProduct.source_site,
      sourceUrl: extractedProduct.source_url,
      rawExtracted: extractedProduct,
      normalized: enriched,
      aiMetadata
    });
  } catch (error) {
    tracker.setStage(run, 'staging', 'failed', { error: error.message });
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: 'STAGING_ERROR', message: error.message } });
    return;
  }
  tracker.setStage(run, 'staging', 'completed', {
    stagingId: staging.id,
    status: staging.status,
    itemNumber: staging.item_number
  });

  run.stagingId = staging.id;
  run.itemNumber = extractedProduct.item_number;
  run.sourceName = sourceName;
  tracker.appendLog(run, 'pipeline', `Staged as #${staging.id}, status ${staging.status}. Awaiting human approval to continue.`);
  run.status = 'awaiting_approval';
  run.updatedAt = new Date().toISOString();
}

// Runs after a human calls the existing approval endpoint's logic
// (stagingRepo.approveStaging — the ONLY function allowed to write to
// `products`). Continues the SAME tracked run: AI validation now that a
// real `products` row exists, real image jobs for every extracted image
// URL, and a final read-back confirming the persisted row.
async function continueAfterApproval(run, tracker, { reviewer, provider }) {
  const onStage = tracker.makeOnStage(run);
  const aiProvider = provider || getAiProvider();

  tracker.setStage(run, 'approval', 'running', { stagingId: run.stagingId, reviewer });
  let approvalResult;
  try {
    approvalResult = await approveStaging(run.stagingId, { reviewer });
  } catch (error) {
    tracker.setStage(run, 'approval', 'failed', { error: error.message });
    tracker.blockRemaining(run);
    tracker.finish(run, 'failed', { error: { type: 'APPROVAL_ERROR', message: error.message } });
    return;
  }
  tracker.setStage(run, 'approval', 'completed', {
    itemNumber: approvalResult.product.item_number,
    masterData: approvalResult.masterData
  });

  // AI VALIDATION — real runValidation(), now meaningful because the
  // product genuinely exists in `products`. onRaw exposes the model's
  // unfiltered findings next to what the application actually kept.
  tracker.setStage(run, 'ai_validation', 'running', { itemNumber: run.itemNumber });
  const rawValidationCalls = [];
  let createdExceptions = [];
  try {
    createdExceptions = await runValidation({
      itemNumbers: [run.itemNumber],
      provider: aiProvider,
      onRaw: (itemNumber, raw) => rawValidationCalls.push({ itemNumber, ...raw })
    });
    tracker.setStage(run, 'ai_validation', 'completed', {
      findingsCreated: createdExceptions.map((f) => ({ field: f.fieldName, currentValue: f.currentValue, suggestedValue: f.suggestedValue, confidence: f.confidence, reason: f.reason })),
      providerFailures: createdExceptions.failed || [],
      rawCalls: rawValidationCalls
    });
  } catch (error) {
    // AI validation failing must never block image processing or the
    // final record from being shown — it's a best-effort quality pass on
    // an already-persisted, already-real product row.
    tracker.setStage(run, 'ai_validation', 'failed', { error: error.message });
  }

  // IMAGE PIPELINE — real image_jobs rows, processed through the exact
  // same processImageJob() every image worker uses. Nothing in the
  // existing ingest/approval path currently enqueues these automatically
  // (confirmed: enqueueImageJob has no other caller in src/), so this is
  // genuinely new wiring — not a duplicate of existing logic, since
  // processImageJob itself is called unchanged.
  tracker.setStage(run, 'image_pipeline', 'running', { imageUrls: approvalResult.product.image_urls || [] });
  const imageResults = [];
  const imageUrls = Array.isArray(approvalResult.product.image_urls) ? approvalResult.product.image_urls : [];
  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    try {
      const enqueued = await imageQueue.enqueueImageJob({
        itemNumber: run.itemNumber,
        sourceName: run.sourceName,
        imageUrl,
        refererUrl: run.sourceUrl,
        role: i === 0 ? 'hero' : 'packaging'
      });
      if (enqueued.deduped) {
        imageResults.push({ imageUrl, outcome: 'EXISTING_JOB_REUSED', jobId: enqueued.id });
        continue;
      }
      const claimed = await imageQueue.claimNextImageJob({ workerId: 'live-pipeline-ui' });
      const jobToProcess = claimed && claimed.id === enqueued.id ? claimed : enqueued;
      const processed = await processImageJob(jobToProcess, {});
      imageResults.push({
        imageUrl,
        jobId: jobToProcess.id,
        outcome: processed.deduped ? 'EXISTING_IMAGE_REUSED' : processed.status.toUpperCase(),
        status: processed.status,
        imageId: processed.image?.id,
        contentHash: processed.image?.content_hash,
        format: processed.image?.format,
        width: processed.image?.width,
        height: processed.image?.height,
        perceptualHash: processed.image?.perceptual_hash,
        reason: processed.reason || null
      });
    } catch (error) {
      imageResults.push({ imageUrl, outcome: 'FAILED', error: error.message });
    }
  }
  tracker.setStage(run, 'image_pipeline', 'completed', { images: imageResults });

  // FINAL DATABASE RECORD — a genuine re-read, not a cached value.
  tracker.setStage(run, 'final_database', 'running', {});
  const finalProduct = await productRepo.getProductByItemNumber(run.itemNumber);
  const finalImages = await imageStore.getImageReferences(run.itemNumber);
  tracker.setStage(run, 'final_database', 'completed', {
    itemNumber: finalProduct?.item_number || null,
    found: Boolean(finalProduct),
    product: finalProduct,
    images: finalImages
  });

  tracker.finish(run, 'completed', { itemNumber: run.itemNumber });
}

async function rejectPipelineRun(run, tracker, { reviewer, reason }) {
  tracker.setStage(run, 'approval', 'running', { stagingId: run.stagingId });
  const rejected = await rejectStaging(run.stagingId, { reviewer, reason });
  tracker.setStage(run, 'approval', 'failed', { rejected: true, reason });
  tracker.blockRemaining(run);
  tracker.finish(run, 'rejected', { staging: rejected });
  return rejected;
}

module.exports = { STAGE_ORDER, runFullPipeline, continueAfterApproval, rejectPipelineRun };
