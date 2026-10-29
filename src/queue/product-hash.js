const crypto = require('node:crypto');

// Product-identity hash for deduplication, per the explicit requirement:
// UPC/SKU + size. Deliberately NOT item_number — this hash exists to
// recognize "this is physically the same product" across different
// sources/URLs, independent of Wine Outlet's own catalog identifier.
//
// Requires at least one of upc/sku (an identifier alone with no
// identifier is not a meaningful product-identity signal); returns null
// otherwise rather than hashing size alone.
function computeProductHash({ upc, sku, size }) {
  const normalizedUpc = (upc || '').trim().toLowerCase();
  const normalizedSku = (sku || '').trim().toLowerCase();
  const normalizedSize = (size || '').trim().toLowerCase();

  if (!normalizedUpc && !normalizedSku) return null;

  const basis = `${normalizedUpc}|${normalizedSku}|${normalizedSize}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

module.exports = { computeProductHash };
