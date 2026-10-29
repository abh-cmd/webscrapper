const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createGuardrails, resetDefaultGuardrails } = require('../src/net/crawl-guardrails');

test('beforeCrawl refuses when the kill switch is engaged, before any network activity', async () => {
  const guardrails = createGuardrails({ env: { CRAWLER_KILL_SWITCH: 'true' } });
  const gate = await guardrails.beforeCrawl({ sourceName: 'example-source', sourceUrl: 'http://127.0.0.1:1/x' });
  assert.equal(gate.allowed, false);
  assert.equal(gate.errorType, 'KILL_SWITCH_ENGAGED');
});

test('beforeCrawl refuses a disabled source', async () => {
  const guardrails = createGuardrails({ env: { DISABLED_SOURCES: 'example-source' } });
  const gate = await guardrails.beforeCrawl({ sourceName: 'example-source', sourceUrl: 'http://127.0.0.1:1/x' });
  assert.equal(gate.allowed, false);
  assert.equal(gate.errorType, 'SOURCE_DISABLED');
});

test('beforeCrawl allows a source that is not disabled, with the kill switch off', async () => {
  const guardrails = createGuardrails({ env: { DISABLED_SOURCES: 'some-other-source' } });
  const gate = await guardrails.beforeCrawl({ sourceName: 'example-source', sourceUrl: 'http://127.0.0.1:1/x', budgetConfig: { globalMax: null, perSource: {} } });
  assert.equal(gate.allowed, true);
});

test('per-domain rate limiting genuinely throttles a configured domain in real time', async () => {
  const guardrails = createGuardrails({ env: {} });
  guardrails.rateLimiter.configureDomain('rate-limited-domain.invalid', { ratePerSecond: 2, burst: 1, concurrency: 5 });

  const t0 = Date.now();
  const gate1 = await guardrails.beforeCrawl({ sourceName: 'x', sourceUrl: 'http://rate-limited-domain.invalid/1', budgetConfig: { globalMax: null, perSource: {} } });
  guardrails.afterCrawl({ domain: gate1.domain, proxyId: gate1.proxyId, success: true });
  const gate2 = await guardrails.beforeCrawl({ sourceName: 'x', sourceUrl: 'http://rate-limited-domain.invalid/2', budgetConfig: { globalMax: null, perSource: {} } });
  const elapsed = Date.now() - t0;

  assert.equal(gate1.allowed, true);
  assert.equal(gate2.allowed, true, 'the second request should eventually be allowed after the bounded wait');
  assert.ok(elapsed >= 400, `expected a real wait for the next token (burst=1 at 2/sec), measured ${elapsed}ms`);
});

test('LIVE: the crawler genuinely routes a real request through a configured local forward proxy', async (t) => {
  const proxyRequestsSeen = [];
  const proxyServer = http.createServer((req, res) => {
    proxyRequestsSeen.push(req.url);
    let target;
    try {
      target = new URL(req.url);
    } catch (error) {
      res.writeHead(400);
      res.end();
      return;
    }
    const upstream = http.request(
      { hostname: target.hostname, port: target.port || 80, path: target.pathname + target.search, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
  t.after(() => proxyServer.close());
  const proxyPort = proxyServer.address().port;

  const guardrails = createGuardrails({
    env: {},
    proxyPoolOptions: { proxies: [{ id: 'live-test-proxy', url: `http://127.0.0.1:${proxyPort}`, tier: 'datacenter' }] }
  });

  const targetUrl = 'http://127.0.0.1:3000/input/fixtures/example-source-product.html';
  const gate = await guardrails.beforeCrawl({ sourceName: 'example-source', sourceUrl: targetUrl, budgetConfig: { globalMax: null, perSource: {} } });
  assert.equal(gate.allowed, true);
  assert.ok(gate.proxy, 'a proxy should have been selected — the pool has exactly one active entry');
  assert.equal(gate.proxy.server, `http://127.0.0.1:${proxyPort}`);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, proxy: gate.proxy });
  const page = await browser.newPage();
  const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  const status = response ? response.status() : null;
  await browser.close();

  assert.equal(status, 200);
  assert.ok(proxyRequestsSeen.some((url) => url.includes('example-source-product.html')), `expected the proxy to have actually seen the request; saw: ${JSON.stringify(proxyRequestsSeen)}`);

  guardrails.afterCrawl({ domain: gate.domain, proxyId: gate.proxyId, success: true, latencyMs: 42 });
  const health = guardrails.proxyPool.getHealth('live-test-proxy');
  assert.equal(health.successCount, 1);
}, { timeout: 30000 });

test('LIVE: runCrawl() itself refuses to run when CRAWLER_KILL_SWITCH=true, via real process.env', async (t) => {
  const { runCrawl } = require('../src/crawler/crawler');
  const original = process.env.CRAWLER_KILL_SWITCH;
  process.env.CRAWLER_KILL_SWITCH = 'true';
  resetDefaultGuardrails();
  t.after(() => {
    if (original === undefined) delete process.env.CRAWLER_KILL_SWITCH;
    else process.env.CRAWLER_KILL_SWITCH = original;
    resetDefaultGuardrails();
  });

  const productInput = require('../input/sample-product.json');
  await assert.rejects(
    () => runCrawl(productInput, productInput.source.url),
    (error) => {
      assert.equal(error.type, 'KILL_SWITCH_ENGAGED');
      return true;
    }
  );
});

test('LIVE: runCrawl() itself refuses once the real Postgres-backed daily budget is exceeded', { skip: !require('../src/db/connection').isDatabaseConfigured() && 'DATABASE_URL not set', timeout: 20000 }, async (t) => {
  const { runCrawl } = require('../src/crawler/crawler');
  const { getPool, closePool } = require('../src/db/connection');
  const pool = getPool();
  await pool.query("DELETE FROM request_budget WHERE source_name = 'example-source';");

  const original = process.env.MAX_REQUESTS_PER_SOURCE_PER_DAY_EXAMPLE_SOURCE;
  process.env.MAX_REQUESTS_PER_SOURCE_PER_DAY_EXAMPLE_SOURCE = '1';
  resetDefaultGuardrails();
  t.after(async () => {
    if (original === undefined) delete process.env.MAX_REQUESTS_PER_SOURCE_PER_DAY_EXAMPLE_SOURCE;
    else process.env.MAX_REQUESTS_PER_SOURCE_PER_DAY_EXAMPLE_SOURCE = original;
    resetDefaultGuardrails();
    await pool.query("DELETE FROM request_budget WHERE source_name = 'example-source';");
  });

  const productInput = require('../input/sample-product.json');
  const first = await runCrawl(productInput, productInput.source.url);
  assert.equal(first.status, 'success', 'the 1st request today is within the budget of 1');

  await assert.rejects(
    () => runCrawl(productInput, productInput.source.url),
    (error) => {
      assert.equal(error.type, 'BUDGET_EXCEEDED');
      return true;
    }
  );
});

test('resetDefaultGuardrails() forces the singleton to be rebuilt from current env on next access', () => {
  resetDefaultGuardrails();
  const { getDefaultGuardrails } = require('../src/net/crawl-guardrails');
  const first = getDefaultGuardrails();
  const second = getDefaultGuardrails();
  assert.equal(first, second, 'without a reset, the same instance is reused');
  resetDefaultGuardrails();
  const third = getDefaultGuardrails();
  assert.notEqual(first, third, 'after a reset, a new instance is created');
});
