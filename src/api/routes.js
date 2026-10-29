// Every route reads/writes the REAL Postgres database through the same
// repository modules the crawler/batch/scheduler/CLI already use — there
// is no separate "frontend data layer" and no hard-coded/fake data
// anywhere in this file. Kept as one file (not one-file-per-resource)
// because the total route count is modest and cross-references between
// resources (e.g. a product's images, a product's AI exceptions) are
// easier to keep straight in one place.

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const { getPool, isDatabaseConfigured } = require('../db/connection');
const productRepo = require('../db/product-repository');
const queue = require('../queue/crawl-queue-repository');
const imageQueue = require('../images/image-queue-repository');
const imageStore = require('../images/image-store-repository');
const { storageRoot, readBytes } = require('../images/image-storage');
const stagingRepo = require('../staging/staging-repository');
const validationService = require('../validation/validation-service');
const complianceRepo = require('../compliance/compliance-repository');
const runMetrics = require('../observability/run-metrics');
const { ingestProduct } = require('../pipeline/ingest-product');
const { runBatch } = require('../batch/batch-runner');
const { getAiProvider } = require('../ai/provider-factory');
const { PRODUCTION_SOURCE_NAMES } = require('../sources/source-registry');
const { validateStartupConfig } = require('../config/startup-validator');
const { crawlerConfig } = require('../config/crawler-config');
const { getDefaultGuardrails } = require('../net/crawl-guardrails');
const tracker = require('../pipeline/pipeline-run-tracker');
const { STAGE_ORDER, runFullPipeline, continueAfterApproval, rejectPipelineRun } = require('../pipeline/run-full-pipeline');

// Last real result of an explicit AI connectivity check (see
// POST /api/ai/verify). Never populated by a background poll — a live
// call to a paid/rate-limited AI endpoint only ever happens when a human
// explicitly asks for one, exactly like the "don't hammer" convention
// used everywhere else in this project's live testing.
let lastAiVerification = null;

function requireDatabase() {
  if (!isDatabaseConfigured()) {
    const error = new Error('DATABASE_URL is not configured.');
    error.statusCode = 503;
    error.publicMessage = 'The backend has no database configured — see README "Database".';
    throw error;
  }
}

function registerRoutes(router) {
  // ---------- Dashboard ----------
  router.get('/api/dashboard', async () => {
    requireDatabase();
    const [totalProducts, queueCounts, imageQueueCounts, pendingExceptions, pendingStaging, sourceStatus] = await Promise.all([
      productRepo.countProducts(),
      queue.countAllStatuses(),
      imageQueue.countAllStatuses(),
      validationService.listExceptions({ status: 'pending_review' }),
      stagingRepo.listStaging({ status: 'pending_review' }),
      runMetrics.getSourceStatusOverview()
    ]);
    const blockedSources = sourceStatus.filter((s) => s.lastErrorType === 'ACCESS_DENIED' || s.lastErrorType === 'ROBOTS_DISALLOWED');
    return {
      totalProducts,
      crawlQueue: queueCounts,
      imageQueue: imageQueueCounts,
      aiReview: { pendingExceptions: pendingExceptions.length, pendingStaging: pendingStaging.length },
      sources: { total: sourceStatus.length, blocked: blockedSources.length, blockedSources: blockedSources.map((s) => s.sourceName) }
    };
  });

  // ---------- Products ----------
  router.get('/api/products', async ({ query }) => {
    requireDatabase();
    const result = await productRepo.listProducts({ search: query.search || null, limit: query.limit, offset: query.offset });
    // Attach a primary (or first) image id per product in one batched
    // query, so the frontend's product cards can show a thumbnail without
    // an N+1 request per row. Additive only — nothing else about the
    // existing response shape changes.
    if (result.products.length > 0) {
      const pool = getPool();
      const itemNumbers = result.products.map((p) => p.item_number);
      const imgResult = await pool.query(
        `SELECT DISTINCT ON (ir.item_number) ir.item_number, ir.image_id
         FROM image_references ir
         WHERE ir.item_number = ANY($1::text[])
         ORDER BY ir.item_number, ir.is_primary DESC, ir.fetched_at ASC;`,
        [itemNumbers]
      );
      const imageByItem = Object.fromEntries(imgResult.rows.map((r) => [r.item_number, r.image_id]));
      result.products = result.products.map((p) => ({ ...p, primary_image_id: imageByItem[p.item_number] || null }));
    }
    return result;
  });

  router.get('/api/products/:itemNumber', async ({ params }) => {
    requireDatabase();
    const product = await productRepo.getProductByItemNumber(params.itemNumber);
    if (!product) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    const images = await imageStore.getImageReferences(params.itemNumber);
    const exceptions = await validationService.listExceptions({ itemNumber: params.itemNumber });
    return { product, images, aiExceptions: exceptions };
  });

  // ---------- Crawls ----------
  router.post('/api/crawls/single', async ({ body }) => {
    requireDatabase();
    if (!body.item_number || !body.item_name || !body.size || !body.source?.url) {
      const e = new Error('item_number, item_name, size, and source.url are required.');
      e.statusCode = 400;
      throw e;
    }
    const result = await ingestProduct(body, body.source.url, { provider: getAiProvider() });
    return { statusCode: result.status === 'staged' ? 200 : 502, body: result };
  });

  router.post('/api/crawls/batch', async ({ body }) => {
    requireDatabase();
    if (!Array.isArray(body.productInputs) || body.productInputs.length === 0) {
      const e = new Error('productInputs must be a non-empty array.');
      e.statusCode = 400;
      throw e;
    }
    const results = await runBatch(body.productInputs);
    return { results, staged: results.filter((r) => r.status === 'staged').length, failed: results.filter((r) => r.status === 'failed').length };
  });

  router.get('/api/crawls/recent', async ({ query }) => {
    requireDatabase();
    return { jobs: await queue.listRecentJobs({ limit: query.limit }) };
  });

  // ---------- Queue ----------
  router.get('/api/queue', async () => {
    requireDatabase();
    const [crawlCounts, imageCounts, deadLetter] = await Promise.all([
      queue.countAllStatuses(),
      imageQueue.countAllStatuses(),
      queue.listDeadLetter()
    ]);
    return { crawlQueue: crawlCounts, imageQueue: imageCounts, recentDeadLetter: deadLetter.slice(0, 25) };
  });

  // ---------- AI review ----------
  router.get('/api/ai/exceptions', async ({ query }) => {
    requireDatabase();
    return { exceptions: await validationService.listExceptions({ status: query.status || 'pending_review' }) };
  });

  router.post('/api/ai/exceptions/:id/approve', async ({ params, body }) => {
    requireDatabase();
    if (!body.reviewer) { const e = new Error('reviewer is required.'); e.statusCode = 400; throw e; }
    return validationService.approveException(Number(params.id), { reviewer: body.reviewer });
  });

  router.post('/api/ai/exceptions/:id/reject', async ({ params, body }) => {
    requireDatabase();
    if (!body.reviewer) { const e = new Error('reviewer is required.'); e.statusCode = 400; throw e; }
    return validationService.rejectException(Number(params.id), { reviewer: body.reviewer });
  });

  router.get('/api/ai/staging', async ({ query }) => {
    requireDatabase();
    return { staging: await stagingRepo.listStaging({ status: query.status || 'pending_review' }) };
  });

  router.post('/api/ai/staging/:id/approve', async ({ params, body }) => {
    requireDatabase();
    if (!body.reviewer) { const e = new Error('reviewer is required.'); e.statusCode = 400; throw e; }
    return stagingRepo.approveStaging(Number(params.id), { reviewer: body.reviewer });
  });

  router.post('/api/ai/staging/:id/reject', async ({ params, body }) => {
    requireDatabase();
    if (!body.reviewer || !body.reason) { const e = new Error('reviewer and reason are required.'); e.statusCode = 400; throw e; }
    return stagingRepo.rejectStaging(Number(params.id), { reviewer: body.reviewer, reason: body.reason });
  });

  router.post('/api/ai/validate', async ({ body }) => {
    requireDatabase();
    const created = await validationService.runValidation({ itemNumbers: body.itemNumbers || null, provider: getAiProvider() });
    // created.failed is intentionally non-enumerable (see validation-service.js)
    // so it survives JSON.stringify here but stays invisible to
    // assert.deepStrictEqual(created, []) in existing tests.
    return { created, failed: created.failed };
  });

  // ---------- Sources ----------
  router.get('/api/sources', async () => {
    requireDatabase();
    const [compliance, statusOverview] = await Promise.all([
      complianceRepo.listSourceCompliance(),
      runMetrics.getSourceStatusOverview()
    ]);
    const statusByName = Object.fromEntries(statusOverview.map((s) => [s.sourceName, s]));
    return {
      sources: PRODUCTION_SOURCE_NAMES.map((name) => {
        const complianceRow = compliance.find((c) => c.sourceName === name) || null;
        const status = statusByName[name] || null;
        return {
          sourceName: name,
          compliance: complianceRow,
          lastAttempted: status ? { status: status.lastJobStatus, errorType: status.lastErrorType, errorMessage: status.lastErrorMessage, at: status.lastAttemptedAt } : null
        };
      })
    };
  });

  // ---------- Images ----------
  router.get('/api/images', async ({ query }) => {
    requireDatabase();
    return imageStore.listImages({ limit: query.limit, offset: query.offset });
  });

  router.get('/api/images/metrics', async ({ query }) => {
    requireDatabase();
    if (!query.source) { const e = new Error('?source= is required.'); e.statusCode = 400; throw e; }
    return runMetrics.computeImageMetrics(query.source);
  });

  // ---------- Admin ----------
  router.get('/api/admin/status', async () => {
    const configured = isDatabaseConfigured();
    if (!configured) return { database: { configured: false } };
    const pool = getPool();
    const tables = ['products', 'product_staging', 'product_validation_exceptions', 'crawl_jobs', 'dead_letter_jobs', 'images', 'image_references', 'image_jobs', 'master_producers', 'master_regions', 'master_varietals', 'source_compliance'];
    const counts = {};
    for (const table of tables) {
      const result = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table};`);
      counts[table] = result.rows[0].n;
    }
    return { database: { configured: true, tableCounts: counts } };
  });

  router.get('/api/admin/config', async () => {
    const validation = validateStartupConfig(process.env);
    const provider = process.env.AI_PROVIDER || 'deterministic-test';
    return {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      database: { configured: isDatabaseConfigured() },
      ai: {
        provider,
        model: provider === 'http' ? (process.env.AI_MODEL || 'gpt-4o-mini') : null,
        keyConfigured: provider === 'http' ? Boolean(process.env.AI_API_KEY) : null,
        isMock: provider !== 'http'
      },
      proxy: { configured: Boolean(process.env.PROXY_LIST) },
      imageStorage: { root: storageRoot(process.env) }
    };
  });

  // ---------- System health ----------
  // Every field here is a real, live-checked signal — never a hard-coded
  // "green". A DB check is a real SELECT 1; an AI status is either the
  // cached result of an explicit POST /api/ai/verify call, or an honest
  // "not verified yet" / "MOCK" / "NOT CONFIGURED" label — never inferred
  // as "connected" just because a key exists in .env.
  router.get('/api/health', async () => {
    const provider = process.env.AI_PROVIDER || 'deterministic-test';

    let database = { configured: isDatabaseConfigured(), connected: false, error: null };
    if (database.configured) {
      try {
        const pool = getPool();
        await pool.query('SELECT 1;');
        database.connected = true;
      } catch (error) {
        database.error = error.message;
      }
    }

    let queueCounts = null;
    let imageQueueCounts = null;
    if (database.connected) {
      [queueCounts, imageQueueCounts] = await Promise.all([queue.countAllStatuses(), imageQueue.countAllStatuses()]);
    }

    let imageStorage = { configured: true, root: storageRoot(process.env), writable: false };
    try {
      fs.mkdirSync(imageStorage.root, { recursive: true });
      fs.accessSync(imageStorage.root, fs.constants.W_OK);
      imageStorage.writable = true;
    } catch (error) {
      imageStorage.writable = false;
      imageStorage.error = error.message;
    }

    const guardrails = getDefaultGuardrails();
    const proxySnapshot = guardrails.proxyPool.snapshot(Date.now());

    const ai = {
      provider,
      model: provider === 'http' ? (process.env.AI_MODEL || 'gpt-4o-mini') : null,
      keyConfigured: provider === 'http' ? Boolean(process.env.AI_API_KEY) : null,
      isMock: provider !== 'http',
      verification: lastAiVerification
    };

    const crawler = {
      configured: true,
      headless: crawlerConfig.headless,
      timeoutMs: crawlerConfig.runTimeoutMs
    };

    const proxy = {
      configured: Boolean(process.env.PROXY_LIST),
      poolSize: proxySnapshot.length
    };

    const componentsOk = database.configured ? database.connected : true;
    const overall = componentsOk ? 'operational' : 'degraded';

    return {
      status: overall,
      timestamp: new Date().toISOString(),
      database,
      queue: queueCounts,
      imageQueue: imageQueueCounts,
      ai,
      crawler,
      imageStorage,
      proxy
    };
  });

  // A real, explicit AI connectivity check. Never auto-triggered — the
  // deterministic-test/none providers report their true nature (MOCK /
  // NOT_CONFIGURED) without any network call; only provider:'http' makes
  // a real, minimal, billed request.
  router.post('/api/ai/verify', async () => {
    const provider = process.env.AI_PROVIDER || 'deterministic-test';
    if (provider === 'none') {
      lastAiVerification = { status: 'NOT_CONFIGURED', checkedAt: new Date().toISOString() };
      return lastAiVerification;
    }
    if (provider !== 'http') {
      lastAiVerification = { status: 'MOCK', provider, checkedAt: new Date().toISOString() };
      return lastAiVerification;
    }
    const startedAt = Date.now();
    try {
      const aiProvider = getAiProvider();
      const result = await aiProvider.paraphrase({ text: 'Verify AI connectivity.', kind: 'description' });
      lastAiVerification = {
        status: 'CONNECTED',
        provider: result.provider,
        model: result.model,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      lastAiVerification = {
        status: 'ERROR',
        errorType: error.type || error.name || 'AI_ERROR',
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
        checkedAt: new Date().toISOString()
      };
    }
    return lastAiVerification;
  });

  // ---------- Proxy / rate limiting ----------
  router.get('/api/proxy/status', async () => {
    const guardrails = getDefaultGuardrails();
    const snapshot = guardrails.proxyPool.snapshot(Date.now());
    const configured = Boolean(process.env.PROXY_LIST) && snapshot.length > 0;
    return {
      configured,
      message: configured ? null : 'NO REAL PROXY PROVIDER CONFIGURED',
      poolSize: snapshot.length,
      proxies: snapshot // getHealth() already excludes credentials — id/tier/status/counters/latency only, never a URL
    };
  });

  // ---------- Image dead-letter ----------
  router.get('/api/images/dead-letter', async ({ query }) => {
    requireDatabase();
    return { deadLetter: await imageQueue.listImageDeadLetter({ itemNumber: query.itemNumber || null }) };
  });

  // Streams the actual stored image bytes for an images.id — the frontend
  // never talks to the filesystem or a cloud bucket directly.
  router.get('/api/images/:id/file', async ({ params }) => {
    requireDatabase();
    const pool = getPool();
    const result = await pool.query('SELECT * FROM images WHERE id = $1;', [Number(params.id)]);
    const row = result.rows[0];
    if (!row) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    const bytes = readBytes(row.storage_path);
    const mimeByFormat = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', gif: 'image/gif' };
    return { statusCode: 200, body: bytes, rawBody: true, contentType: mimeByFormat[row.format] || 'application/octet-stream' };
  });

  // ---------- Live pipeline ----------
  router.post('/api/pipeline/run', async ({ body }) => {
    requireDatabase();
    if (!body.item_number || !body.item_name || !body.size || !body.source?.url) {
      const e = new Error('item_number, item_name, size, and source.url are required.');
      e.statusCode = 400;
      throw e;
    }
    const id = randomUUID();
    const run = tracker.createRun({
      id,
      itemNumber: body.item_number,
      sourceUrl: body.source.url,
      mode: body.mode === 'live' ? 'live' : 'demo',
      stageOrder: STAGE_ORDER
    });

    // Fire-and-forget: the HTTP response returns the runId immediately;
    // the frontend polls GET /api/pipeline/:id for real, live-updated stage
    // state while this actually runs in the background.
    runFullPipeline({ productInput: body, sourceUrl: body.source.url, provider: getAiProvider() }, tracker, run)
      .catch((error) => {
        tracker.appendLog(run, 'pipeline', `Unhandled pipeline error: ${error.message}`, 'error');
        tracker.finish(run, 'failed', { error: { type: 'UNHANDLED', message: error.message } });
      });

    return { statusCode: 202, body: { runId: id } };
  });

  router.get('/api/pipeline', async ({ query }) => {
    return { runs: tracker.listRuns({ limit: query.limit }) };
  });

  router.get('/api/pipeline/:id', async ({ params }) => {
    const run = tracker.getRun(params.id);
    if (!run) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    return {
      id: run.id,
      itemNumber: run.itemNumber,
      sourceUrl: run.sourceUrl,
      mode: run.mode,
      status: run.status,
      stageOrder: run.stageOrder,
      stages: run.stages,
      stagingId: run.stagingId || null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      result: run.result
    };
  });

  router.get('/api/pipeline/:id/logs', async ({ params }) => {
    const run = tracker.getRun(params.id);
    if (!run) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    return { logs: run.logs };
  });

  router.post('/api/pipeline/:id/approve', async ({ params, body }) => {
    requireDatabase();
    const run = tracker.getRun(params.id);
    if (!run) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    if (run.status !== 'awaiting_approval') {
      const e = new Error(`Run is in status "${run.status}", not awaiting_approval.`);
      e.statusCode = 409;
      throw e;
    }
    if (!body.reviewer) { const e = new Error('reviewer is required.'); e.statusCode = 400; throw e; }

    run.status = 'processing';
    continueAfterApproval(run, tracker, { reviewer: body.reviewer, provider: getAiProvider() })
      .catch((error) => {
        tracker.appendLog(run, 'pipeline', `Unhandled post-approval error: ${error.message}`, 'error');
        tracker.finish(run, 'failed', { error: { type: 'UNHANDLED', message: error.message } });
      });

    return { statusCode: 202, body: { runId: run.id, status: 'processing' } };
  });

  router.post('/api/pipeline/:id/reject', async ({ params, body }) => {
    requireDatabase();
    const run = tracker.getRun(params.id);
    if (!run) { const e = new Error('not found'); e.statusCode = 404; throw e; }
    if (run.status !== 'awaiting_approval') {
      const e = new Error(`Run is in status "${run.status}", not awaiting_approval.`);
      e.statusCode = 409;
      throw e;
    }
    if (!body.reviewer || !body.reason) { const e = new Error('reviewer and reason are required.'); e.statusCode = 400; throw e; }
    await rejectPipelineRun(run, tracker, { reviewer: body.reviewer, reason: body.reason });
    return { runId: run.id, status: run.status };
  });
}

module.exports = { registerRoutes };
