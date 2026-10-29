#!/usr/bin/env node
// Minimal static file server for local test fixtures — serves the project
// root on port 3000 so paths like /input/fixtures/example-source-product.html
// resolve exactly as the crawler/tests expect. Plain node:http, no
// dependency, meant to run persistently in the background (like the
// Docker Postgres container) for the duration of local development.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FIXTURE_SERVER_PORT) || 3000;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  const requestedPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(ROOT, requestedPath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Fixture static server listening on http://127.0.0.1:${PORT} (root: ${ROOT})`);
});
