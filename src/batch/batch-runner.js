// "Runs on a schedule and supports on-demand runs for a single product or
// batch... Reuse the existing queue. Do not create a second queue
// architecture. All scheduled/batch jobs must be resumable."
//
// Single-product on-demand: already existed (src/index.js /
// src/pipeline/ingest-product.js — one product, run directly).
//
// Batch: this file. It enqueues every product into the SAME crawl_jobs
// table Block 2 already built, then drains that queue via the same
// claim/retry/dead-letter machinery. Resumability comes from the existing
// queue's claim/retry mechanism (already proven under a simulated crash —
// tests/crawl-queue.integration.test.js #10), not new code: re-invoking
// runBatch() with the same product list after a crash/restart re-enqueues
// (deduped, no-ops for anything already pending/succeeded) and only
// processes what's still outstanding.
//
// Note: crawl_jobs intentionally does not persist item_name/size/vintage
// (that would duplicate the caller's own input data into the queue table
// for no benefit) — so draining requires the same product input list the
// batch was submitted with. A job claimed with no matching input in that
// list fails clearly (MISSING_PRODUCT_INPUT) rather than guessing.
//
// Scheduled execution: the requirements document's own "Open items" list
// leaves refresh cadence unconfirmed ("Confirm refresh cadence
// (daily/weekly)"). Rather than invent a cadence, this exposes a plain,
// schedule-agnostic entry point (npm run batch) that any external
// scheduler (cron, Windows Task Scheduler, a CI scheduled job, etc.) can
// invoke at whatever interval is eventually decided — see README.

const queue = require('../queue/crawl-queue-repository');
const { ingestProduct } = require('../pipeline/ingest-product');
const { getAiProvider } = require('../ai/provider-factory');

// Enqueues a list of product inputs (same shape as input/*.json) into the
// existing crawl_jobs queue. Uses the queue's own dedup (canonical URL /
// product hash), so submitting the same batch twice is safe.
async function enqueueBatch(productInputs) {
  const enqueued = [];
  for (const productInput of productInputs) {
    if (!productInput.source || !productInput.source.url) {
      throw new Error(`Product ${productInput.item_number || '(unknown)'} has no source.url to enqueue.`);
    }
    const job = await queue.enqueueJob({
      itemNumber: productInput.item_number,
      sourceName: productInput.source.name,
      sourceUrl: productInput.source.url
    });
    enqueued.push(job);
  }
  return enqueued;
}

// Drains the queue for pending/retrying work, running each claimed job
// through the full ingest pipeline (crawl -> AI enrich -> stage).
// productInputs must include the full input (item_name, size, vintage,
// source) for every item_number that might be claimed — see the file
// header for why. Stops when no more claimable work exists.
async function runBatchFromQueue(productInputs, { workerId = `batch-${process.pid}`, maxItems = Infinity, provider = null } = {}) {
  const productInputsByItemNumber = new Map(productInputs.map((p) => [p.item_number, p]));
  const aiProvider = provider || getAiProvider();
  const results = [];

  while (results.length < maxItems) {
    const job = await queue.claimNextJob({ workerId });
    if (!job) break;

    const productInput = productInputsByItemNumber.get(job.itemNumber);
    if (!productInput) {
      await queue.markFailed(job.id, {
        errorType: 'MISSING_PRODUCT_INPUT',
        errorMessage: `No product input was supplied for item_number "${job.itemNumber}" while draining the queue.`
      });
      results.push({ jobId: job.id, itemNumber: job.itemNumber, status: 'failed', error: { type: 'MISSING_PRODUCT_INPUT' } });
      continue;
    }

    try {
      const result = await ingestProduct(productInput, job.sourceUrl, { provider: aiProvider });

      if (result.status === 'staged') {
        await queue.markSucceeded(job.id);
        results.push({ jobId: job.id, itemNumber: job.itemNumber, status: 'staged', stagingId: result.staging.id });
      } else {
        const errorInfo = result.crawlResult.error || { type: 'EXTRACTION_FAILED', message: 'Unknown failure' };
        await queue.markFailed(job.id, { errorType: errorInfo.type, errorMessage: errorInfo.message });
        results.push({ jobId: job.id, itemNumber: job.itemNumber, status: 'failed', error: errorInfo });
      }
    } catch (error) {
      await queue.markFailed(job.id, { errorType: error.type || 'EXTRACTION_FAILED', errorMessage: error.message });
      results.push({ jobId: job.id, itemNumber: job.itemNumber, status: 'failed', error: { type: error.type || 'EXTRACTION_FAILED', message: error.message } });
    }
  }

  return results;
}

// Convenience: enqueue + immediately drain, for a simple on-demand batch
// submission (the common CLI case). Safe to call again after a
// crash/restart with the same productInputs list — see file header.
async function runBatch(productInputs, options = {}) {
  await enqueueBatch(productInputs);
  return runBatchFromQueue(productInputs, options);
}

module.exports = { enqueueBatch, runBatchFromQueue, runBatch };
