const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// Streaming image fetch: aborts as soon as the response exceeds maxBytes
// (never buffers an unlimited body), honors a timeout, follows redirects
// up to maxRedirects, sets Referer, and supports conditional GET via
// ETag/Last-Modified (a 304 response short-circuits with notModified:true
// and no body is downloaded at all).

function fetchImage(imageUrl, {
  refererUrl = null,
  etag = null,
  lastModified = null,
  timeoutMs = 15000,
  maxRedirects = 5,
  maxBytes = 20 * 1024 * 1024,
  headers = {}
} = {}) {
  return new Promise((resolve, reject) => {
    function doRequest(currentUrl, redirectsLeft) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (error) {
        reject(Object.assign(new Error(`Invalid image URL: ${currentUrl}`), { code: 'INVALID_URL' }));
        return;
      }

      const client = parsed.protocol === 'https:' ? https : http;
      const reqHeaders = { ...headers };
      if (refererUrl) reqHeaders.Referer = refererUrl;
      if (etag) reqHeaders['If-None-Match'] = etag;
      if (lastModified) reqHeaders['If-Modified-Since'] = lastModified;

      const req = client.get(currentUrl, { headers: reqHeaders, timeout: timeoutMs }, (res) => {
        if (res.statusCode === 304) {
          res.resume();
          resolve({ notModified: true, statusCode: 304 });
          return;
        }

        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(Object.assign(new Error('Too many redirects'), { code: 'TOO_MANY_REDIRECTS' }));
            return;
          }
          const location = res.headers.location;
          if (!location) {
            reject(new Error('Redirect response had no Location header'));
            return;
          }
          const nextUrl = new URL(location, currentUrl).toString();
          doRequest(nextUrl, redirectsLeft - 1);
          return;
        }

        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(Object.assign(new Error(`Image fetch failed with HTTP ${res.statusCode}`), {
            code: 'HTTP_ERROR',
            statusCode: res.statusCode
          }));
          return;
        }

        const chunks = [];
        let total = 0;
        let aborted = false;

        res.on('data', (chunk) => {
          if (aborted) return;
          total += chunk.length;
          if (total > maxBytes) {
            aborted = true;
            req.destroy();
            reject(Object.assign(new Error('Image exceeds the maximum allowed size'), { code: 'MAX_SIZE_EXCEEDED' }));
            return;
          }
          chunks.push(chunk);
        });

        res.on('end', () => {
          if (aborted) return;
          resolve({
            notModified: false,
            statusCode: res.statusCode,
            buffer: Buffer.concat(chunks),
            etag: res.headers.etag || null,
            lastModified: res.headers['last-modified'] || null,
            contentType: res.headers['content-type'] || null
          });
        });

        res.on('error', (error) => {
          if (!aborted) reject(error);
        });
      });

      req.on('timeout', () => {
        req.destroy(Object.assign(new Error('Image fetch timed out'), { code: 'TIMEOUT' }));
      });
      req.on('error', reject);
    }

    doRequest(imageUrl, maxRedirects);
  });
}

module.exports = { fetchImage };
