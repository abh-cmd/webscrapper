const crypto = require('node:crypto');

// Exact-byte content-hash deduplication — works for every format, unlike
// the perceptual hash below which is PNG-only.
function computeContentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { computeContentHash };
