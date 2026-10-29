const { getPool } = require('../db/connection');
const { validateImage } = require('./validate');
const { computeContentHash } = require('./content-hash');
const { averageHashPng } = require('./perceptual-hash');
const { storeBytes } = require('./image-storage');

function imageFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    contentHash: row.content_hash,
    perceptualHash: row.perceptual_hash,
    format: row.format,
    width: row.width,
    height: row.height,
    byteSize: row.byte_size,
    storagePath: row.storage_path,
    firstSeenSourceUrl: row.first_seen_source_url
  };
}

function referenceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    imageId: row.image_id,
    itemNumber: row.item_number,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    role: row.role,
    isPrimary: row.is_primary,
    fetchedAt: row.fetched_at
  };
}

// Validates, then stores the image exactly once by content hash (content-
// hash dedup). If the same bytes were already stored — from this source,
// a different source, or a different product entirely — the existing row
// is returned unchanged rather than writing a duplicate file or row.
async function storeValidatedImage(buffer, { sourceUrl, validation: validationOptions } = {}) {
  const validation = validateImage(buffer, validationOptions);
  if (!validation.valid) {
    return { stored: false, validation };
  }

  const pool = getPool();
  const contentHash = computeContentHash(buffer);

  const existing = await pool.query('SELECT * FROM images WHERE content_hash = $1;', [contentHash]);
  if (existing.rows.length > 0) {
    return { stored: true, deduped: true, validation, image: imageFromRow(existing.rows[0]) };
  }

  const storagePath = storeBytes(buffer, contentHash, validation.format);
  const perceptualHash = validation.format === 'png' ? averageHashPng(buffer) : null;

  const inserted = await pool.query(
    `INSERT INTO images (content_hash, perceptual_hash, format, width, height, byte_size, storage_path, first_seen_source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (content_hash) DO NOTHING
     RETURNING *;`,
    [contentHash, perceptualHash, validation.format, validation.width, validation.height, buffer.length, storagePath, sourceUrl || null]
  );

  if (inserted.rows.length === 0) {
    // Lost a race with a concurrent insert of the same content hash.
    const row = await pool.query('SELECT * FROM images WHERE content_hash = $1;', [contentHash]);
    return { stored: true, deduped: true, validation, image: imageFromRow(row.rows[0]) };
  }

  return { stored: true, deduped: false, validation, image: imageFromRow(inserted.rows[0]) };
}

// Links a stored image to a (product, source, url, role). Re-linking the
// same (item_number, source_name, source_url) updates the existing
// reference rather than creating a duplicate.
async function addImageReference({ imageId, itemNumber, sourceName, sourceUrl, role, isPrimary = false }) {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO image_references (image_id, item_number, source_name, source_url, role, is_primary)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (item_number, source_name, source_url) DO UPDATE SET
       image_id = EXCLUDED.image_id, role = EXCLUDED.role
     RETURNING *;`,
    [imageId, itemNumber, sourceName, sourceUrl, role, isPrimary]
  );
  return referenceFromRow(result.rows[0]);
}

// Exactly one primary image per product, enforced transactionally (and
// backed by the database's own partial unique index as a second line of
// defense): clear any existing primary flag for this product, then set
// the new one.
async function setPrimaryImageReference(itemNumber, imageReferenceId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE image_references SET is_primary = false WHERE item_number = $1 AND is_primary = true;', [itemNumber]);
    const result = await client.query(
      'UPDATE image_references SET is_primary = true WHERE id = $1 AND item_number = $2 RETURNING *;',
      [imageReferenceId, itemNumber]
    );
    await client.query('COMMIT');
    return referenceFromRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getImageReferences(itemNumber) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT ir.*, img.content_hash, img.format, img.width, img.height, img.storage_path
     FROM image_references ir
     JOIN images img ON img.id = ir.image_id
     WHERE ir.item_number = $1
     ORDER BY ir.fetched_at ASC;`,
    [itemNumber]
  );
  return result.rows.map((row) => ({ ...referenceFromRow(row), image: imageFromRow(row) }));
}

// For the frontend Images view (final pass): every stored image plus its
// references (which product/role it's attached to, and whether it's the
// primary), newest first.
async function listImages({ limit = 25, offset = 0 } = {}) {
  const pool = getPool();
  const boundedLimit = Math.min(Math.max(Number(limit) || 25, 1), 200);
  const boundedOffset = Math.max(Number(offset) || 0, 0);

  const result = await pool.query(
    `SELECT i.*,
       COALESCE(json_agg(json_build_object('itemNumber', ir.item_number, 'role', ir.role, 'isPrimary', ir.is_primary))
         FILTER (WHERE ir.id IS NOT NULL), '[]') AS references
     FROM images i
     LEFT JOIN image_references ir ON ir.image_id = i.id
     GROUP BY i.id
     ORDER BY i.created_at DESC
     LIMIT $1 OFFSET $2;`,
    [boundedLimit, boundedOffset]
  );
  const countResult = await pool.query('SELECT COUNT(*)::int AS n FROM images;');

  return {
    images: result.rows.map((row) => ({ ...imageFromRow(row), references: row.references })),
    total: countResult.rows[0].n,
    limit: boundedLimit,
    offset: boundedOffset
  };
}

async function getImageByContentHash(contentHash) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM images WHERE content_hash = $1;', [contentHash]);
  return imageFromRow(result.rows[0]);
}

async function findNearDuplicatesByPerceptualHash(perceptualHash, { maxDistance = 5 } = {}) {
  if (!perceptualHash) return [];
  const { hammingDistance } = require('./perceptual-hash');
  const pool = getPool();
  const result = await pool.query('SELECT * FROM images WHERE perceptual_hash IS NOT NULL;');
  return result.rows
    .map(imageFromRow)
    .filter((image) => image.perceptualHash !== perceptualHash)
    .map((image) => ({ image, distance: hammingDistance(perceptualHash, image.perceptualHash) }))
    .filter((entry) => entry.distance !== null && entry.distance <= maxDistance);
}

module.exports = {
  storeValidatedImage,
  addImageReference,
  setPrimaryImageReference,
  getImageReferences,
  getImageByContentHash,
  findNearDuplicatesByPerceptualHash,
  listImages
};
