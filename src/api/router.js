// A minimal hand-rolled router — no framework dependency, consistent with
// this project's existing style (a from-scratch PNG decoder, a from-
// scratch robots.txt parser). A handful of REST routes doesn't need
// Express; it needs a method+path match and a JSON in/out convention.

const { URL } = require('node:url');

function compilePath(pattern) {
  const paramNames = [];
  const regexSource = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexSource}$`), paramNames };
}

function createRouter() {
  const routes = []; // { method, compiled, handler }

  function add(method, pattern, handler) {
    routes.push({ method, compiled: compilePath(pattern), handler });
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      request.on('data', (chunk) => {
        total += chunk.length;
        if (total > 5 * 1024 * 1024) {
          reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(Object.assign(new Error(`Invalid JSON body: ${error.message}`), { statusCode: 400 }));
        }
      });
      request.on('error', reject);
    });
  }

  function sendJson(response, statusCode, payload) {
    const body = JSON.stringify(payload, null, 2);
    response.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  }

  async function handle(request, response) {
    const parsedUrl = new URL(request.url, 'http://internal');
    const pathname = decodeURIComponent(parsedUrl.pathname);

    for (const route of routes) {
      if (route.method !== request.method) continue;
      const match = pathname.match(route.compiled.regex);
      if (!match) continue;

      const params = {};
      route.compiled.paramNames.forEach((name, index) => { params[name] = match[index + 1]; });
      const query = Object.fromEntries(parsedUrl.searchParams.entries());

      try {
        const body = (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH')
          ? await readBody(request)
          : {};
        const result = await route.handler({ params, query, body, request });
        if (result?.rawBody) {
          response.writeHead(result.statusCode || 200, {
            'Content-Type': result.contentType || 'application/octet-stream',
            'Content-Length': result.body.length
          });
          response.end(result.body);
        } else {
          sendJson(response, result?.statusCode || 200, result?.body ?? result ?? {});
        }
      } catch (error) {
        const statusCode = error.statusCode || 500;
        if (statusCode >= 500) console.error('[api]', request.method, pathname, error);
        sendJson(response, statusCode, { error: error.publicMessage || error.message });
      }
      return true;
    }
    return false;
  }

  return {
    get: (pattern, handler) => add('GET', pattern, handler),
    post: (pattern, handler) => add('POST', pattern, handler),
    handle,
    sendJson
  };
}

module.exports = { createRouter };
