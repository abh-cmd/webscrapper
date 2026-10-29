const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const httpLlmProvider = require('../src/ai/providers/http-llm-provider');
const { enrichProduct } = require('../src/ai/enrichment');

// This file specifically hardens the REAL HTTP provider's failure
// handling — Part 7/9 of the final AI-integration pass: 401/403/429/500,
// timeout, malformed/invalid JSON, retry behavior (bounded, not
// indefinite), and that a thrown provider error never crashes the ingest
// pipeline. Every server here is a real local HTTP server; nothing is
// mocked at the function-call level.

function startMockLlmServer(responder) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let parsedRequest = null;
      try { parsedRequest = JSON.parse(body); } catch (error) { /* some tests deliberately send garbage back, not forward */ }
      responder(parsedRequest, req, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function envFor(port, overrides = {}) {
  return { AI_API_BASE_URL: `http://127.0.0.1:${port}`, AI_API_KEY: 'test-key-not-real', AI_MODEL: 'test-model', ...overrides };
}

// ---------- Non-retryable client errors: fail on the first attempt ----------

for (const status of [400, 401, 403, 404]) {
  test(`http-llm-provider: HTTP ${status} fails immediately, no retry (retrying a bad request/key can't help)`, async (t) => {
    let requestCount = 0;
    const server = await startMockLlmServer((parsedRequest, req, res) => {
      requestCount += 1;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `simulated ${status}` }));
    });
    t.after(() => server.close());

    await assert.rejects(
      () => httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, envFor(server.address().port, { AI_MAX_RETRIES: '3' })),
      (error) => { assert.equal(error.statusCode, status); return true; }
    );
    assert.equal(requestCount, 1, `HTTP ${status} must not be retried`);
  });
}

// ---------- Retryable server/rate-limit errors: retry, then succeed ----------

test('http-llm-provider: HTTP 429 is retried and eventually succeeds', async (t) => {
  let requestCount = 0;
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    requestCount += 1;
    if (requestCount < 3) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '0' });
      res.end(JSON.stringify({ error: 'rate limited (test)' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  t.after(() => server.close());

  const result = await httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, envFor(server.address().port, { AI_MAX_RETRIES: '3' }));
  assert.equal(result.text, 'ok');
  assert.equal(requestCount, 3, 'expected 2 failures then a success — genuine retries, not a single lucky call');
});

test('http-llm-provider: HTTP 500 is retried and eventually succeeds', async (t) => {
  let requestCount = 0;
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    requestCount += 1;
    if (requestCount < 2) {
      res.writeHead(500);
      res.end('internal error (test)');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  t.after(() => server.close());

  const result = await httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, envFor(server.address().port, { AI_MAX_RETRIES: '2' }));
  assert.equal(result.text, 'ok');
  assert.equal(requestCount, 2);
});

test('http-llm-provider: retries are bounded, not indefinite — gives up after AI_MAX_RETRIES', async (t) => {
  let requestCount = 0;
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    requestCount += 1;
    res.writeHead(503);
    res.end('always unavailable (test)');
  });
  t.after(() => server.close());

  await assert.rejects(
    () => httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, envFor(server.address().port, { AI_MAX_RETRIES: '2' })),
    (error) => { assert.equal(error.statusCode, 503); return true; }
  );
  assert.equal(requestCount, 3, 'exactly 1 initial attempt + 2 retries, then give up — never indefinite');
});

test('http-llm-provider: a real request timeout is classified and eventually fails cleanly (bounded retries)', async (t) => {
  const server = await startMockLlmServer(() => {
    // Never respond — forces a real timeout, not a simulated one.
  });
  t.after(() => server.close());

  const start = Date.now();
  await assert.rejects(
    () => httpLlmProvider.paraphrase(
      { text: 'x', kind: 'description' },
      envFor(server.address().port, { AI_REQUEST_TIMEOUT_MS: '200', AI_MAX_RETRIES: '1' })
    ),
    (error) => { assert.equal(error.type, 'AI_TIMEOUT'); return true; }
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `a 200ms timeout with 1 retry must not take anywhere near 5s (took ${elapsed}ms)`);
});

// ---------- Malformed / invalid responses fail safely, not silently ----------

test('http-llm-provider: a response body that is not JSON at all is classified as AI_MALFORMED_RESPONSE', async (t) => {
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>not json</html>');
  });
  t.after(() => server.close());

  await assert.rejects(
    () => httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, envFor(server.address().port)),
    (error) => { assert.equal(error.type, 'AI_MALFORMED_RESPONSE'); return true; }
  );
});

test('http-llm-provider: a well-formed JSON envelope with no message content is AI_INVALID_RESPONSE_SCHEMA', async (t) => {
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [] }));
  });
  t.after(() => server.close());

  await assert.rejects(
    () => httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, envFor(server.address().port)),
    (error) => { assert.equal(error.type, 'AI_INVALID_RESPONSE_SCHEMA'); return true; }
  );
});

test('http-llm-provider analyzeProduct: model content that is not JSON is AI_MALFORMED_RESPONSE, not a crash', async (t) => {
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'this is prose, not JSON findings' } }] }));
  });
  t.after(() => server.close());

  await assert.rejects(
    () => httpLlmProvider.analyzeProduct({ item_number: 'WO-1' }, envFor(server.address().port)),
    (error) => { assert.equal(error.type, 'AI_MALFORMED_RESPONSE'); return true; }
  );
});

test('http-llm-provider analyzeProduct: valid JSON but missing the "findings" array is AI_INVALID_RESPONSE_SCHEMA', async (t) => {
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ notFindings: true }) } }] }));
  });
  t.after(() => server.close());

  await assert.rejects(
    () => httpLlmProvider.analyzeProduct({ item_number: 'WO-1' }, envFor(server.address().port)),
    (error) => { assert.equal(error.type, 'AI_INVALID_RESPONSE_SCHEMA'); return true; }
  );
});

// ---------- Failure isolation: the ingest pipeline must survive a throwing provider ----------

test('enrichProduct: a provider that throws (simulating a real network/timeout failure) never crashes — falls back to source text', async () => {
  const explodingProvider = {
    async paraphrase() {
      throw Object.assign(new Error('simulated network failure'), { type: 'AI_NETWORK_ERROR' });
    }
  };

  const { enriched, aiMetadata } = await enrichProduct(
    { product_description: 'A bold red wine.', food_pairing: 'Grilled steak.' },
    explodingProvider
  );

  assert.equal(enriched.product_description, 'A bold red wine.', 'original source text must be preserved, not lost');
  assert.equal(enriched.food_pairing, 'Grilled steak.');
  assert.equal(aiMetadata.rejectedFields.length, 2);
  assert.match(aiMetadata.rejectedFields[0].reason, /AI_NETWORK_ERROR|simulated network failure/);
});

const { isDatabaseConfigured } = require('../src/db/connection');
const dbSkip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

test('runValidation: a provider failure on one product does not abort analysis of the rest of the batch', { skip: dbSkip }, async () => {
  const flakyProvider = {
    calls: 0,
    async analyzeProduct(product) {
      this.calls += 1;
      if (product.item_number === 'WO-HARDENING-FAIL') {
        throw Object.assign(new Error('simulated provider outage'), { type: 'AI_NETWORK_ERROR' });
      }
      return { findings: [], provider: 'flaky-test' };
    }
  };

  const validationService = require('../src/validation/validation-service');
  const productRepo = require('../src/db/product-repository');
  const { normalizeProductRecord } = require('../src/schema/product-schema');
  const { getPool, closePool } = require('../src/db/connection');
  const pool = getPool();

  const ITEMS = ['WO-HARDENING-FAIL', 'WO-HARDENING-OK'];
  await pool.query('DELETE FROM product_validation_exceptions WHERE item_number = ANY($1::text[]);', [ITEMS]);
  await pool.query('DELETE FROM products WHERE item_number = ANY($1::text[]);', [ITEMS]);

  for (const itemNumber of ITEMS) {
    await productRepo.upsertProduct(normalizeProductRecord({
      item_number: itemNumber, item_name: 'x', product_name: 'x', category: 'Red Wine',
      source_site: 'example-source', source_url: 'https://example.invalid/x', scraped_at: new Date().toISOString()
    }));
  }

  const created = await validationService.runValidation({ itemNumbers: ITEMS, provider: flakyProvider });

  assert.equal(flakyProvider.calls, 2, 'both products must have been attempted, despite the first one failing');
  assert.equal(created.failed.length, 1);
  assert.equal(created.failed[0].itemNumber, 'WO-HARDENING-FAIL');
  assert.equal(created.failed[0].errorType, 'AI_NETWORK_ERROR');

  await pool.query('DELETE FROM product_validation_exceptions WHERE item_number = ANY($1::text[]);', [ITEMS]);
  await pool.query('DELETE FROM products WHERE item_number = ANY($1::text[]);', [ITEMS]);
  await closePool();
});
