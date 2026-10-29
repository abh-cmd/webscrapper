const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { fetchImage } = require('../src/images/image-fetcher');
const { solidColorPng } = require('./helpers/png-fixture');

// Real HTTP requests against a real local server — per instructions,
// "use local HTTP fixtures rather than relying on live external image
// servers." Nothing here touches the actual internet.

const IMAGE_BYTES = solidColorPng(10, 10, [10, 20, 30]);
let capturedHeaders = null;
let redirectHopCount = 0;

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/image.png') {
      capturedHeaders = req.headers;

      if (req.headers['if-none-match'] === '"abc123"') {
        res.writeHead(304);
        res.end();
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'image/png',
        ETag: '"abc123"',
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT'
      });
      res.end(IMAGE_BYTES);
      return;
    }

    if (req.url === '/slow-image.png') {
      // Never responds -> exercises the timeout path.
      return;
    }

    if (req.url === '/huge-image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      const chunk = Buffer.alloc(1024 * 1024, 1);
      const interval = setInterval(() => {
        if (res.destroyed) {
          clearInterval(interval);
          return;
        }
        res.write(chunk);
      }, 1);
      req.on('close', () => clearInterval(interval));
      return;
    }

    if (req.url === '/redirect-forever') {
      redirectHopCount += 1;
      res.writeHead(302, { Location: '/redirect-forever' });
      res.end();
      return;
    }

    if (req.url === '/redirect-once') {
      res.writeHead(302, { Location: '/image.png' });
      res.end();
      return;
    }

    if (req.url === '/not-found.png') {
      res.writeHead(404);
      res.end('not found');
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('image fetch success: downloads the body and reports headers', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  const result = await fetchImage(`http://127.0.0.1:${port}/image.png`);
  assert.equal(result.notModified, false);
  assert.equal(result.statusCode, 200);
  assert.ok(result.buffer.equals(IMAGE_BYTES));
  assert.equal(result.etag, '"abc123"');
});

test('failed image fetch: a 404 rejects with a classifiable error', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  await assert.rejects(
    () => fetchImage(`http://127.0.0.1:${port}/not-found.png`),
    (error) => {
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.statusCode, 404);
      return true;
    }
  );
});

test('Referer propagation: the product page URL is sent as the Referer header', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  await fetchImage(`http://127.0.0.1:${port}/image.png`, {
    refererUrl: 'https://www.wine.com/product/example/000001'
  });
  assert.equal(capturedHeaders.referer, 'https://www.wine.com/product/example/000001');
});

test('ETag handling: If-None-Match is sent when a known ETag is supplied', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  await fetchImage(`http://127.0.0.1:${port}/image.png`, { etag: '"abc123"' });
  assert.equal(capturedHeaders['if-none-match'], '"abc123"');
});

test('Last-Modified handling: If-Modified-Since is sent when a known Last-Modified is supplied', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  await fetchImage(`http://127.0.0.1:${port}/image.png`, { lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT' });
  assert.equal(capturedHeaders['if-modified-since'], 'Wed, 01 Jan 2025 00:00:00 GMT');
});

test('conditional GET: an unchanged image (matching ETag) is not re-downloaded — server returns 304, no body', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  const result = await fetchImage(`http://127.0.0.1:${port}/image.png`, { etag: '"abc123"' });
  assert.equal(result.notModified, true);
  assert.equal(result.statusCode, 304);
  assert.equal(result.buffer, undefined, 'a 304 response must not carry/allocate an image body');
});

test('redirect configuration: a single redirect is followed to completion', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  const result = await fetchImage(`http://127.0.0.1:${port}/redirect-once`, { maxRedirects: 3 });
  assert.equal(result.statusCode, 200);
  assert.ok(result.buffer.equals(IMAGE_BYTES));
});

test('redirect configuration: exceeding maxRedirects rejects rather than looping forever', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());
  redirectHopCount = 0;

  await assert.rejects(
    () => fetchImage(`http://127.0.0.1:${port}/redirect-forever`, { maxRedirects: 2 }),
    (error) => {
      assert.equal(error.code, 'TOO_MANY_REDIRECTS');
      return true;
    }
  );
  assert.ok(redirectHopCount <= 4, 'must not follow an unbounded number of redirects');
});

test('safety limits: an oversized response is aborted mid-stream, never fully buffered', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  await assert.rejects(
    () => fetchImage(`http://127.0.0.1:${port}/huge-image.png`, { maxBytes: 2 * 1024 * 1024 }),
    (error) => {
      assert.equal(error.code, 'MAX_SIZE_EXCEEDED');
      return true;
    }
  );
});

test('timeout configuration: a request that never responds is aborted after the configured timeout', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  t.after(() => server.close());

  await assert.rejects(
    () => fetchImage(`http://127.0.0.1:${port}/slow-image.png`, { timeoutMs: 300 }),
    (error) => {
      assert.equal(error.code, 'TIMEOUT');
      return true;
    }
  );
});
