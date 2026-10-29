const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { runCrawl } = require('../src/crawler/crawler');
const { clearRobotsCache } = require('../src/compliance/robots-checker');

// A controlled, live proof (real local HTTP server, real runCrawl, real
// robots.txt fetch over the wire — nothing mocked or stubbed) that the
// crawler genuinely refuses a robots.txt-disallowed path BEFORE fetching
// it, and genuinely proceeds when the path is allowed.

function makeServer({ robotsBody, pageHitCounterRef }) {
  return http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(robotsBody);
      return;
    }
    pageHitCounterRef.count += 1;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body><h1>Test Product</h1></body></html>');
  });
}

test('runCrawl refuses a robots.txt-disallowed path before ever fetching it', async (t) => {
  clearRobotsCache();
  const pageHitCounter = { count: 0 };
  const server = makeServer({
    robotsBody: 'User-agent: ClaudeBot\nDisallow: /blocked\n',
    pageHitCounterRef: pageHitCounter
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const productInput = {
    item_number: 'WO-ROBOTS-TEST-1',
    item_name: 'Robots Test Product',
    size: '750ml',
    source: { name: 'example-source', url: `http://127.0.0.1:${port}/blocked/product` }
  };

  await assert.rejects(
    () => runCrawl(productInput, productInput.source.url),
    (error) => {
      assert.equal(error.type, 'ROBOTS_DISALLOWED');
      return true;
    }
  );

  assert.equal(pageHitCounter.count, 0, 'the actual product page must never be requested once robots.txt disallows it');
});

test('runCrawl proceeds normally when robots.txt allows the path', async (t) => {
  clearRobotsCache();
  const pageHitCounter = { count: 0 };
  const server = makeServer({
    robotsBody: 'User-agent: ClaudeBot\nDisallow: /blocked\nAllow: /open\n',
    pageHitCounterRef: pageHitCounter
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  const productInput = {
    item_number: 'WO-ROBOTS-TEST-2',
    item_name: 'Robots Test Product',
    size: '750ml',
    source: { name: 'example-source', url: `http://127.0.0.1:${port}/open/product` }
  };

  const result = await runCrawl(productInput, productInput.source.url);
  assert.equal(result.status, 'success');
  assert.equal(pageHitCounter.count, 1, 'an allowed path must actually be fetched');
});
