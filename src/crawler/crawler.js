process.env.CRAWLEE_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.APIFY_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.CRAWLEE_SYSTEM_INFO_V2 = 'false';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { PlaywrightCrawler, Configuration } = require('crawlee');
const { crawlerConfig } = require('../config/crawler-config');
const {
  logSection,
  logCrawlHeader,
  logSimple,
  logExtractionChecklist,
  logExtractionSummary,
  logFailureResult,
  writeJson,
  createRunId
} = require('../utils/logging');
const { handleRequest } = require('./request-handler');
const { summarizeExtraction } = require('../schema/product-schema');
const { resolveSource } = require('../sources/source-registry');
const { runPageAction } = require('./page-actions');
const { checkRobotsCompliance } = require('../compliance/robots-checker');
const { getDefaultGuardrails } = require('../net/crawl-guardrails');
const { redactSecrets } = require('../utils/redact');

function makeFailureResult(runId, sourceName, sourceUrl, errorType, errorMessage) {
  return {
    run_id: runId,
    source: sourceName,
    source_url: sourceUrl,
    status: 'failed',
    error_type: errorType,
    error_message: redactSecrets(errorMessage),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: 0
  };
}

function finalizeFailure({ runId, sourceName, sourceUrl, startedAt, httpStatus, errorInfo }) {
  // Never let a secret (a proxy credential embedded in a connection-error
  // message, an API key, etc.) reach a report file or the terminal — see
  // src/utils/redact.js. This is the single choke point every failure
  // path (crawl error, ACCESS_DENIED, ROBOTS_DISALLOWED, guardrail
  // refusal) funnels through, so redacting once here covers all of them.
  const safeMessage = redactSecrets(errorInfo.message);

  const report = {
    run_id: runId,
    source: sourceName,
    source_url: sourceUrl,
    status: 'failed',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    pages_attempted: 1,
    pages_succeeded: 0,
    pages_failed: 1,
    items_extracted: 0,
    http_status: typeof errorInfo.httpStatus === 'number' ? errorInfo.httpStatus : (httpStatus ?? null),
    product: null,
    error: {
      type: errorInfo.type,
      message: safeMessage
    }
  };

  writeJson(path.join(crawlerConfig.outputDirs.reports, `${runId}.json`), report);

  logFailureResult({
    errorType: errorInfo.type,
    errorMessage: safeMessage,
    sourceName,
    sourceUrl,
    runId
  });

  return report;
}

function finalizeSuccess({ runId, sourceName, sourceUrl, startedAt, httpStatus, result, itemNumber, rawHtml }) {
  const finishedAt = Date.now();
  const summary = summarizeExtraction(result.data);
  const pageType = result.meta?.pageType || null;
  const matchedListing = typeof result.meta?.matchedListing === 'boolean' ? result.meta.matchedListing : null;

  const report = {
    run_id: runId,
    source: sourceName,
    source_url: sourceUrl,
    status: 'success',
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: finishedAt - startedAt,
    pages_attempted: 1,
    pages_succeeded: 1,
    pages_failed: 0,
    items_extracted: 1,
    http_status: httpStatus ?? null,
    page_type: pageType,
    matched_listing: matchedListing,
    extraction_summary: {
      total_fields: summary.totalFields,
      populated_fields: summary.populatedFields,
      null_fields: summary.nullFields,
      images_found: summary.imagesFound
    },
    product: result.data,
    error: null
  };

  const resultFile = path.join(crawlerConfig.outputDirs.results, `${itemNumber}.json`);
  const reportFile = path.join(crawlerConfig.outputDirs.reports, `${runId}.json`);

  writeJson(resultFile, result.data);
  writeJson(reportFile, report);

  if (rawHtml !== null && rawHtml !== undefined) {
    const rawFile = path.join(crawlerConfig.outputDirs.raw, `${itemNumber}.html`);
    fs.writeFileSync(rawFile, rawHtml, 'utf8');
  }

  if (pageType) {
    logSimple(`Page type: ${pageType.toUpperCase().replace('-', '/')}`);
  }

  logExtractionChecklist(result.data);

  logSection('RESULT');
  logSimple('Status: SUCCESS');
  logSimple('');
  logExtractionSummary(summary);
  logSimple(`Duration: ${report.duration_ms} ms`);
  logSimple('');
  logSimple('Result:');
  logSimple(path.relative(process.cwd(), resultFile));
  logSimple('');
  logSimple('Report:');
  logSimple(path.relative(process.cwd(), reportFile));

  return report;
}

async function runDirectPlaywright(productInput, sourceUrl, runId, sourceName, sourceConfig, proxy, onStage = () => {}, adapter = null) {
  const startedAt = Date.now();
  let httpStatus = null;

  try {
    logSimple('Request started');
    onStage('fetch', 'running', { url: sourceUrl });
    const browser = await chromium.launch({ headless: crawlerConfig.headless, ...(proxy ? { proxy } : {}) });
    const page = await browser.newPage();
    const fetchStartedAt = Date.now();
    const response = await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: crawlerConfig.runTimeoutMs });
    httpStatus = response ? response.status() : null;

    // Many modern product pages render their actual content (name, price,
    // schema.org JSON-LD) client-side, after domcontentloaded fires. A
    // bounded, best-effort wait for the page to go quiet gives that a
    // chance to finish before extraction reads the DOM — this is generic
    // browser behavior, not tied to any one site, and never hangs
    // indefinitely (a page with constant background activity, e.g.
    // analytics polling, just falls through after the timeout).
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    if (typeof httpStatus === 'number') {
      logSimple(`HTTP status: ${httpStatus}`);
    }
    logSimple('Page loaded');
    onStage('fetch', 'completed', { url: sourceUrl, httpStatus, durationMs: Date.now() - fetchStartedAt });

    const pageActionResult = await runPageAction({
      page,
      sourceAdapter: adapter,
      sourceConfig,
      context: {
        productInput,
        sourceConfig,
        sourceName,
        sourceUrl,
        httpStatus,
        pageActionConfig: sourceConfig.pageAction || sourceConfig.page_action || null
      }
    });
    if (pageActionResult?.applied) {
      logSimple('Page action completed');
    }

    const result = await handleRequest({
      request: { url: sourceUrl },
      page,
      context: {
        productInput,
        sourceConfig,
        sourceName,
        sourceUrl,
        httpStatus,
        onStage,
        sourceAdapter: adapter
      }
    });

    if (!result.success) {
      const rawHtml = await page.content();
      await browser.close();

      const failureReport = finalizeFailure({
        runId,
        sourceName,
        sourceUrl,
        startedAt,
        httpStatus,
        errorInfo: result.error
      });

      const err = new Error(result.error.message);
      err.type = result.error.type;
      err.httpStatus = result.error.httpStatus;
      err.challengeType = result.error.challengeType || null;
      err.report = failureReport;
      err.rawHtmlForDebug = rawHtml;
      throw err;
    }

    const rawHtml = await page.content();
    await browser.close();

    const report = finalizeSuccess({
      runId,
      sourceName,
      sourceUrl,
      startedAt,
      httpStatus,
      result,
      itemNumber: productInput.item_number,
      rawHtml
    });

    return {
      run_id: runId,
      source: sourceName,
      source_url: sourceUrl,
      status: report.status,
      http_status: report.http_status,
      product: report.product,
      error: report.error,
      duration_ms: report.duration_ms
    };
  } catch (error) {
    if (error.report) {
      throw error;
    }

    onStage('fetch', 'failed', { url: sourceUrl, error: error.message });

    finalizeFailure({
      runId,
      sourceName,
      sourceUrl,
      startedAt,
      httpStatus,
      errorInfo: {
        type: error.type || error.name || 'CrawlerError',
        message: error.message,
        httpStatus: typeof error.httpStatus === 'number' ? error.httpStatus : httpStatus
      }
    });

    throw error;
  }
}

// The actual Crawlee-attempt-then-direct-Playwright-fallback logic,
// unchanged from before except for accepting a `proxy` option (selected by
// the guardrails layer — see runCrawl). Extracted into its own function so
// runCrawl can wrap it in a try/finally that reports the outcome back to
// the rate limiter and proxy pool regardless of success or failure.
async function performCrawl(productInput, sourceUrl, runId, sourceName, sourceConfig, proxy, onStage = () => {}, adapter = null) {
  logSection('WINE OUTLET PRODUCT CRAWLER');
  logCrawlHeader(runId, productInput.item_number, productInput.item_name, sourceName, sourceUrl);
  logSection('CRAWL');
  logSimple('Request started');

  const startedAt = Date.now();

  try {
    const localConfig = new Configuration({
      systemInfoIntervalMillis: 60000,
      persistStateIntervalMillis: 60000,
      systemInfoV2: false,
      headless: crawlerConfig.headless
    });

    let capturedResult = null;
    let capturedHttpStatus = null;
    let capturedRawHtml = null;
    let capturedFailure = null;

    onStage('fetch', 'running', { url: sourceUrl });

    const crawler = new PlaywrightCrawler({
      launchContext: {
        launchOptions: {
          headless: crawlerConfig.headless,
          ...(proxy ? { proxy } : {})
        }
      },
      maxConcurrency: 1,
      maxRequestRetries: 0,
      requestHandlerTimeoutSecs: 30,
      navigationTimeoutSecs: 30,
      async requestHandler({ request, page, response }) {
        capturedHttpStatus = response ? response.status() : null;
        // See the matching comment in runDirectPlaywright() — same
        // best-effort wait for client-rendered content to settle.
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        if (typeof capturedHttpStatus === 'number') {
          logSimple(`HTTP status: ${capturedHttpStatus}`);
        }
        logSimple('Page loaded');
        onStage('fetch', 'completed', { url: sourceUrl, httpStatus: capturedHttpStatus });

        const pageActionResult = await runPageAction({
          page,
          sourceAdapter: adapter,
          sourceConfig,
          context: {
            productInput,
            sourceConfig,
            sourceName,
            sourceUrl,
            httpStatus: capturedHttpStatus,
            pageActionConfig: sourceConfig.pageAction || sourceConfig.page_action || null
          }
        });
        if (pageActionResult?.applied) {
          logSimple('Page action completed');
        }

        const result = await handleRequest({
          request,
          page,
          context: { productInput, sourceConfig, sourceName, sourceUrl, httpStatus: capturedHttpStatus, onStage, sourceAdapter: adapter }
        });

        capturedRawHtml = await page.content();

        if (!result.success) {
          capturedFailure = result.error;
          throw new Error(result.error.message);
        }

        capturedResult = result;
      }
    }, localConfig);

    try {
      await crawler.run([sourceUrl]);
    } catch (runError) {
      if (capturedFailure) {
        const failureReport = finalizeFailure({
          runId,
          sourceName,
          sourceUrl,
          startedAt,
          httpStatus: capturedHttpStatus,
          errorInfo: capturedFailure
        });
        throw Object.assign(new Error(capturedFailure.message), { report: failureReport });
      }
      throw runError;
    }

    if (capturedFailure) {
      const failureReport = finalizeFailure({
        runId,
        sourceName,
        sourceUrl,
        startedAt,
        httpStatus: capturedHttpStatus,
        errorInfo: capturedFailure
      });
      throw Object.assign(new Error(capturedFailure.message), { report: failureReport });
    }

    if (!capturedResult) {
      throw new Error('Crawlee run completed without producing a result.');
    }

    const report = finalizeSuccess({
      runId,
      sourceName,
      sourceUrl,
      startedAt,
      httpStatus: capturedHttpStatus,
      result: capturedResult,
      itemNumber: productInput.item_number,
      rawHtml: capturedRawHtml
    });

    return {
      run_id: runId,
      source: sourceName,
      source_url: sourceUrl,
      status: report.status,
      http_status: report.http_status,
      product: report.product,
      error: report.error,
      duration_ms: report.duration_ms
    };
  } catch (error) {
    if (error.report) {
      throw error;
    }

    logSimple('Crawlee runtime unavailable in this environment; falling back to direct Playwright execution.');
    return runDirectPlaywright(productInput, sourceUrl, runId, sourceName, sourceConfig, proxy, onStage, adapter);
  }
}

async function runCrawl(productInput, overrideUrl, { onStage = () => {} } = {}) {
  const runId = createRunId();
  const sourceConfig = productInput.source || {};
  const sourceUrl = overrideUrl || sourceConfig.url;

  if (!productInput.item_number || !productInput.item_name || !productInput.size) {
    const failure = makeFailureResult(runId, sourceConfig.name || null, sourceUrl, 'ValidationError', 'Input validation failed: item_number, item_name, and size are required.');
    writeJson(path.join(crawlerConfig.outputDirs.reports, `${runId}.json`), failure);
    throw new Error(failure.error_message);
  }

  if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
    const failure = makeFailureResult(runId, sourceConfig.name || null, sourceUrl, 'ValidationError', 'Invalid source URL: a valid http(s) URL is required.');
    writeJson(path.join(crawlerConfig.outputDirs.reports, `${runId}.json`), failure);
    throw new Error(failure.error_message);
  }

  // Ask the source registry which adapter owns this request. This can come
  // from an explicit source.name (Phase 1/2 contract, unchanged) or, when
  // no name is given, from hostname-based detection against the four
  // approved production sources. An unrecognized source is rejected here,
  // before any network/browser activity, rather than surfacing later as a
  // confusing extraction failure.
  let adapter;
  try {
    adapter = resolveSource({ name: sourceConfig.name, url: sourceUrl });
  } catch (error) {
    onStage('source', 'failed', { url: sourceUrl, error: error.message });
    const failure = makeFailureResult(runId, sourceConfig.name || null, sourceUrl, error.type || 'UNSUPPORTED_SOURCE', error.message);
    writeJson(path.join(crawlerConfig.outputDirs.reports, `${runId}.json`), failure);
    throw error;
  }
  const sourceName = adapter.name;
  const sourceUrlObj = (() => { try { return new URL(sourceUrl); } catch { return null; } })();
  onStage('source', 'completed', {
    url: sourceUrl,
    domain: sourceUrlObj ? sourceUrlObj.hostname : null,
    sourceName,
    requestTimestamp: new Date().toISOString()
  });

  // Real, live robots.txt enforcement — not a one-time manual check. Fails
  // open (allowed) when robots.txt is unreachable/absent/errored, fails
  // closed only on an explicit matching Disallow rule for this
  // user-agent (or the wildcard group). A recorded, signed-off override in
  // source_compliance bypasses this — see src/compliance/robots-checker.js.
  const robotsDecision = await checkRobotsCompliance(sourceUrl, { sourceName });
  if (!robotsDecision.allowed) {
    const message = `robots.txt disallows this path for this crawler (${robotsDecision.matchedRule || 'Disallow: /'}, group "${robotsDecision.group}").`;
    onStage('fetch', 'blocked', { url: sourceUrl, reason: 'ROBOTS_DISALLOWED', message });
    const failure = makeFailureResult(runId, sourceName, sourceUrl, 'ROBOTS_DISALLOWED', message);
    writeJson(path.join(crawlerConfig.outputDirs.reports, `${runId}.json`), failure);
    const err = new Error(message);
    err.type = 'ROBOTS_DISALLOWED';
    throw err;
  }

  // Operational guardrails — kill switch, source disablement, per-source
  // request budget, per-domain rate limiting (with a bounded wait for a
  // free token), and proxy selection. Every check defaults to "allowed"
  // when unconfigured; see src/net/crawl-guardrails.js for exactly what
  // changes (nothing, for any domain that isn't one of the four production
  // hostnames or hasn't been explicitly configured).
  const guardrails = getDefaultGuardrails();
  const gate = await guardrails.beforeCrawl({ sourceName, sourceUrl });
  if (!gate.allowed) {
    onStage('fetch', 'blocked', { url: sourceUrl, reason: gate.errorType, message: gate.errorMessage });
    const failure = makeFailureResult(runId, sourceName, sourceUrl, gate.errorType, gate.errorMessage);
    writeJson(path.join(crawlerConfig.outputDirs.reports, `${runId}.json`), failure);
    const err = new Error(gate.errorMessage);
    err.type = gate.errorType;
    throw err;
  }

  const guardrailStartedAt = Date.now();
  try {
    const result = await performCrawl(productInput, sourceUrl, runId, sourceName, sourceConfig, gate.proxy, onStage, adapter);
    guardrails.afterCrawl({ domain: gate.domain, proxyId: gate.proxyId, success: true, latencyMs: Date.now() - guardrailStartedAt });
    return result;
  } catch (error) {
    const blocked = error.type === 'ACCESS_DENIED' || error.type === 'RATE_LIMITED';
    guardrails.afterCrawl({ domain: gate.domain, proxyId: gate.proxyId, success: false, blocked, latencyMs: Date.now() - guardrailStartedAt });
    throw error;
  }
}

module.exports = {
  runCrawl
};
