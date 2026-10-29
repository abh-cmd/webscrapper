#!/usr/bin/env node

// Real backend server for the WineOutlet frontend: serves the static UI
// (public/) and a JSON REST API (/api/*) backed by the same repository
// modules the crawler/batch/scheduler use — the same real Postgres
// database, not a mock or a fixture layer built for the frontend.
// Usage: npm run serve (reads PORT from env, default 3100)

process.env.CRAWLEE_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.APIFY_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.CRAWLEE_SYSTEM_INFO_V2 = 'false';

require('dotenv').config();
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createRouter } = require('./router');
const { registerRoutes } = require('./routes');
const { validateStartupConfig } = require('../config/startup-validator');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
// The React/Vite/TypeScript dashboard's built output — a separate static
// root served under /dashboard, entirely additive. The original public/
// SPA (index.html/app.js/styles.css) keeps being served at / exactly as
// before, unchanged, so tests/api-server.integration.test.js's existing
// assertions about / , /app.js, and /styles.css keep passing untouched.
const DASHBOARD_DIR = path.join(__dirname, '..', '..', 'frontend', 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(request, response) {
  const requestedPath = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  // Never serve a path that escapes the public directory.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    response.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    response.end(content);
  });
}

// SPA fallback: any /dashboard/* path that isn't a real built asset (a
// client-side React Router route, e.g. /dashboard/products/WO-123) falls
// back to the app shell, which then renders the right screen client-side.
function serveDashboard(request, response) {
  const requestedPath = request.url.split('?')[0].replace(/^\/dashboard/, '') || '/';
  const withoutTraversal = requestedPath === '/' ? '/index.html' : requestedPath;
  const filePath = path.join(DASHBOARD_DIR, withoutTraversal);
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      // Not a built asset (e.g. a client-route path with no matching file)
      // — fall back to the app shell so client-side routing can handle it.
      const shellPath = path.join(DASHBOARD_DIR, 'index.html');
      fs.readFile(shellPath, (shellError, shellContent) => {
        if (shellError) {
          response.writeHead(404, { 'Content-Type': 'text/plain' });
          response.end('Dashboard not built yet — run `npm run build` inside frontend/.');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(shellContent);
      });
      return;
    }
    const ext = path.extname(filePath);
    response.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    response.end(content);
  });
}

// Builds the server (routes + static file serving) without binding to a
// port — used both by main() below and directly by tests, which bind to
// an ephemeral port (0) instead of the real PORT/3100.
function createServer() {
  const router = createRouter();
  registerRoutes(router);

  return http.createServer(async (request, response) => {
    if (request.url.startsWith('/api/')) {
      const handled = await router.handle(request, response);
      if (!handled) router.sendJson(response, 404, { error: 'No such API route.' });
      return;
    }
    if (request.url === '/dashboard' || request.url.startsWith('/dashboard/') || request.url.startsWith('/dashboard?')) {
      serveDashboard(request, response);
      return;
    }
    serveStatic(request, response);
  });
}

function main() {
  const validation = validateStartupConfig();
  for (const warning of validation.warnings) console.warn(`[config warning] ${warning}`);
  if (!validation.valid) {
    console.error('Configuration errors:');
    for (const error of validation.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer();
  const port = Number(process.env.PORT) || 3100;
  server.listen(port, () => {
    console.log(`WineOutlet backend + frontend listening on http://localhost:${port}`);
  });

  return server;
}

if (require.main === module) main();

module.exports = { main, createServer };
