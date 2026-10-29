const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const deterministicProvider = require('../src/ai/providers/deterministic-test-provider');
const httpLlmProvider = require('../src/ai/providers/http-llm-provider');
const { getAiProvider, NOOP_PROVIDER } = require('../src/ai/provider-factory');

// --- Deterministic test provider (offline, no network) ---

test('deterministic paraphrase: produces text different from the source (not a direct copy)', async () => {
  const result = await deterministicProvider.paraphrase({
    text: 'Notes of black cherry pair well with a delicious, smooth finish.',
    kind: 'description'
  });
  assert.equal(result.provider, 'deterministic-test');
  assert.equal(result.changed, true);
  assert.notEqual(result.text, 'Notes of black cherry pair well with a delicious, smooth finish.');
});

test('deterministic paraphrase: is genuinely deterministic (same input -> same output every time)', async () => {
  const text = 'This full-bodied red has a rich, crisp finish.';
  const a = await deterministicProvider.paraphrase({ text, kind: 'description' });
  const b = await deterministicProvider.paraphrase({ text, kind: 'description' });
  assert.equal(a.text, b.text);
});

test('deterministic paraphrase: null/empty text passes through without fabricating content', async () => {
  const result = await deterministicProvider.paraphrase({ text: null, kind: 'food_pairing' });
  assert.equal(result.text, null);
  assert.equal(result.changed, false);
});

test('deterministic paraphrase: is clearly tagged as non-AI, never confusable with real output', async () => {
  const result = await deterministicProvider.paraphrase({ text: 'A crisp white.', kind: 'description' });
  assert.equal(result.provider, 'deterministic-test');
  assert.match(result.model, /synonym-substitution/);
});

test('deterministic validation: flags a real varietal/color inconsistency with a stated reason', async () => {
  const result = await deterministicProvider.analyzeProduct({
    product_name: 'Test Wine',
    category: 'White Wine',
    varietal: 'Cabernet Sauvignon',
    color: 'Pale straw yellow'
  });
  assert.equal(result.provider, 'deterministic-test');
  const colorFinding = result.findings.find((f) => f.field === 'color');
  assert.ok(colorFinding);
  assert.equal(colorFinding.suggestedValue, 'red');
  assert.ok(colorFinding.confidence > 0 && colorFinding.confidence <= 100);
  assert.match(colorFinding.reason, /Cabernet Sauvignon/);
});

test('deterministic validation: flags a category that contradicts the varietal', async () => {
  const result = await deterministicProvider.analyzeProduct({
    product_name: 'Test Wine',
    category: 'White Wine',
    varietal: 'Merlot'
  });
  const categoryFinding = result.findings.find((f) => f.field === 'category');
  assert.ok(categoryFinding);
});

test('deterministic validation: a consistent, complete record produces no findings (never fabricates issues)', async () => {
  const result = await deterministicProvider.analyzeProduct({
    product_name: 'Consistent Wine',
    category: 'Red Wine',
    varietal: 'Merlot',
    color: 'Deep ruby red'
  });
  assert.deepEqual(result.findings, []);
});

test('deterministic validation: flags missing required fields', async () => {
  const result = await deterministicProvider.analyzeProduct({ product_name: null, category: null });
  assert.equal(result.findings.filter((f) => f.confidence === 100).length, 2);
});

// --- Provider factory ---

test('provider factory: defaults to the deterministic test provider (never silently calls a real paid API)', () => {
  const provider = getAiProvider({});
  assert.equal(provider, deterministicProvider);
});

test('provider factory: AI_PROVIDER=none returns a genuine no-op (paraphrase passthrough, no findings)', async () => {
  const provider = getAiProvider({ AI_PROVIDER: 'none' });
  assert.equal(provider, NOOP_PROVIDER);
  const result = await provider.paraphrase({ text: 'Unchanged text.', kind: 'description' });
  assert.equal(result.text, 'Unchanged text.');
  assert.equal(result.changed, false);
});

test('provider factory: AI_PROVIDER=http selects the real HTTP provider', () => {
  assert.equal(getAiProvider({ AI_PROVIDER: 'http' }), httpLlmProvider);
});

test('provider factory: an unrecognized AI_PROVIDER value throws clearly rather than silently defaulting', () => {
  assert.throws(() => getAiProvider({ AI_PROVIDER: 'not-a-real-provider' }));
});

// --- http-llm-provider: real HTTP request/response shape, against a
// local mock server standing in for the API (NOT a real LLM, and never
// claimed to be one — this proves the wiring, not real AI quality). ---

function startMockLlmServer(responder) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsedRequest = JSON.parse(body);
      responder(parsedRequest, req, res);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('http-llm-provider: requires AI_API_BASE_URL and AI_API_KEY, never silently proceeds without them', () => {
  assert.throws(() => httpLlmProvider.requireConfig({}));
  assert.throws(() => httpLlmProvider.requireConfig({ AI_API_BASE_URL: 'http://x' }));
});

test('http-llm-provider: paraphrase sends the expected request shape and parses the response', async (t) => {
  let capturedRequest = null;
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    capturedRequest = parsedRequest;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'A rewritten description.' } }] }));
  });
  t.after(() => server.close());
  const port = server.address().port;

  const env = { AI_API_BASE_URL: `http://127.0.0.1:${port}`, AI_API_KEY: 'test-key-not-real', AI_MODEL: 'test-model' };
  const result = await httpLlmProvider.paraphrase({ text: 'Original description.', kind: 'description' }, env);

  assert.equal(result.text, 'A rewritten description.');
  assert.equal(result.provider, 'http-llm');
  assert.equal(result.model, 'test-model');
  assert.equal(capturedRequest.model, 'test-model');
  assert.ok(capturedRequest.messages.some((m) => m.content.includes('Original description.')));
});

test('http-llm-provider: analyzeProduct sends the product and parses structured findings', async (t) => {
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({ findings: [{ field: 'color', currentValue: 'White', suggestedValue: 'Rosé', confidence: 92, reason: 'test reason' }] })
        }
      }]
    }));
  });
  t.after(() => server.close());
  const port = server.address().port;

  const env = { AI_API_BASE_URL: `http://127.0.0.1:${port}`, AI_API_KEY: 'test-key-not-real' };
  const result = await httpLlmProvider.analyzeProduct({ item_number: 'WO-1', color: 'White' }, env);

  assert.equal(result.provider, 'http-llm');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].suggestedValue, 'Rosé');
});

test('http-llm-provider: a non-2xx response rejects with a classifiable error, not a silent empty result', async (t) => {
  const server = await startMockLlmServer((parsedRequest, req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid api key (test)' }));
  });
  t.after(() => server.close());
  const port = server.address().port;

  const env = { AI_API_BASE_URL: `http://127.0.0.1:${port}`, AI_API_KEY: 'wrong-key' };
  await assert.rejects(
    () => httpLlmProvider.paraphrase({ text: 'x', kind: 'description' }, env),
    (error) => {
      assert.equal(error.statusCode, 401);
      return true;
    }
  );
});
