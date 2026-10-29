const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { isDatabaseConfigured, getPool, closePool } = require('../src/db/connection');
const skip = !isDatabaseConfigured() && 'DATABASE_URL is not set — see tests/product-repository.integration.test.js for the general pattern.';

const { createServer } = require('../src/api/server');

let server;
let baseUrl;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(`${baseUrl}${path}`, {
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (error) { /* not all responses are JSON (static files) */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('setup: start the real API server on an ephemeral port', { skip }, async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test('LIVE: GET / serves the real frontend HTML', { skip }, async () => {
  const res = await request('GET', '/');
  assert.equal(res.statusCode, 200);
  assert.match(res.raw, /WineOutlet Crawler/);
});

test('LIVE: GET /app.js and /styles.css serve real static assets', { skip }, async () => {
  const js = await request('GET', '/app.js');
  const css = await request('GET', '/styles.css');
  assert.equal(js.statusCode, 200);
  assert.match(js.raw, /api\(/);
  assert.equal(css.statusCode, 200);
  assert.match(css.raw, /--paper/);
});

test('LIVE: a path-traversal attempt against static files is refused', { skip }, async () => {
  const res = await request('GET', '/../../../../etc/passwd');
  assert.notEqual(res.statusCode, 200);
});

test('LIVE: GET /api/dashboard returns real counts from the real database', { skip }, async () => {
  const res = await request('GET', '/api/dashboard');
  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body.totalProducts, 'number');
  assert.ok('crawlQueue' in res.body);
  assert.ok('aiReview' in res.body);
});

test('LIVE: unknown API route returns a real 404, not a crash', { skip }, async () => {
  const res = await request('GET', '/api/does-not-exist');
  assert.equal(res.statusCode, 404);
});

test('LIVE: the full crawl -> stage -> approve loop works through the real HTTP API', { skip }, async (t) => {
  const pool = getPool();
  const ITEM = 'WO-API-INTEGRATION-TEST';
  await pool.query(`DELETE FROM product_staging WHERE item_number = '${ITEM}';`);
  await pool.query(`DELETE FROM products WHERE item_number = '${ITEM}';`);
  t.after(async () => {
    await pool.query(`DELETE FROM product_staging WHERE item_number = '${ITEM}';`);
    await pool.query(`DELETE FROM products WHERE item_number = '${ITEM}';`);
  });

  const sampleInput = require('../input/sample-product.json');
  const crawlRes = await request('POST', '/api/crawls/single', {
    item_number: ITEM, item_name: 'API Integration Test Product', size: '750ml',
    source: { name: 'example-source', url: sampleInput.source.url }
  });
  assert.equal(crawlRes.statusCode, 200);
  assert.equal(crawlRes.body.status, 'staged');
  const stagingId = crawlRes.body.staging.id;

  const notYet = await request('GET', `/api/products/${ITEM}`);
  assert.equal(notYet.statusCode, 404, 'must not be in products before approval');

  const approveRes = await request('POST', `/api/ai/staging/${stagingId}/approve`, { reviewer: 'api-test@wineoutlet' });
  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.body.staging.status, 'approved');

  const nowExists = await request('GET', `/api/products/${ITEM}`);
  assert.equal(nowExists.statusCode, 200);
  assert.equal(nowExists.body.product.item_number, ITEM);
}, { timeout: 20000 });

test('LIVE: rejecting a staging record requires a reviewer and reason, and never promotes it', { skip }, async (t) => {
  const pool = getPool();
  const ITEM = 'WO-API-REJECT-TEST';
  await pool.query(`DELETE FROM product_staging WHERE item_number = '${ITEM}';`);
  await pool.query(`DELETE FROM products WHERE item_number = '${ITEM}';`);
  t.after(async () => {
    await pool.query(`DELETE FROM product_staging WHERE item_number = '${ITEM}';`);
    await pool.query(`DELETE FROM products WHERE item_number = '${ITEM}';`);
  });

  const sampleInput = require('../input/sample-product.json');
  const crawlRes = await request('POST', '/api/crawls/single', {
    item_number: ITEM, item_name: 'API Reject Test Product', size: '750ml',
    source: { name: 'example-source', url: sampleInput.source.url }
  });
  const stagingId = crawlRes.body.staging.id;

  const missingReason = await request('POST', `/api/ai/staging/${stagingId}/reject`, { reviewer: 'api-test@wineoutlet' });
  assert.equal(missingReason.statusCode, 400);

  const rejectRes = await request('POST', `/api/ai/staging/${stagingId}/reject`, { reviewer: 'api-test@wineoutlet', reason: 'test rejection via API' });
  assert.equal(rejectRes.statusCode, 200);
  assert.equal(rejectRes.body.status, 'rejected');

  const stillNotPromoted = await request('GET', `/api/products/${ITEM}`);
  assert.equal(stillNotPromoted.statusCode, 404);
}, { timeout: 20000 });

test('LIVE: GET /api/admin/status reports real table row counts', { skip }, async () => {
  const res = await request('GET', '/api/admin/status');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.database.configured, true);
  assert.equal(typeof res.body.database.tableCounts.products, 'number');
});

test('LIVE: GET /api/sources reflects the real seeded compliance rows', { skip }, async () => {
  const res = await request('GET', '/api/sources');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sources.length, 4);
  assert.ok(res.body.sources.every((s) => s.compliance !== null));
});

test('cleanup: stop the server', { skip }, async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});
