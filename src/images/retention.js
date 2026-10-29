const fs = require('node:fs');
const { getPool } = require('../db/connection');

// Configurable image retention/cleanup. Deliberately narrow scope, per the
// requirements document's own "Open items" list ("Confirm image storage
// backend, retention policy and derivative sizes" is explicitly listed as
// unconfirmed): there is no invented retention period here.
// IMAGE_RETENTION_DAYS must be set for cleanup to do anything at all —
// with it unset, findExpiredImages()/cleanupExpiredImages() are inert,
// matching the same "expose configuration, don't invent a business
// decision" approach used for MAX_REQUESTS_PER_SOURCE_PER_DAY.
//
// Derivative images (Background-Removed, Watermarked): NOT implemented —
// see README "Specification conflicts". This module only manages the
// Standard/original image already acquired by Block 3, so that whichever
// storage backend/retention window is eventually decided, the mechanism
// (find-expired, delete-file, delete-row, leave-referenced-images-alone)
// doesn't need to be redesigned later.

function loadRetentionDaysFromEnv(env = process.env) {
  if (env.IMAGE_RETENTION_DAYS === undefined) return null;
  const days = Number(env.IMAGE_RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`IMAGE_RETENTION_DAYS="${env.IMAGE_RETENTION_DAYS}" must be a positive number of days.`);
  return days;
}

// An image is eligible for cleanup only if it is BOTH older than the
// retention window AND has no remaining image_references row — an image
// still attached to a live product is never deleted regardless of age,
// since "retention" here means "stop paying to store things nothing
// points to anymore," not "delete old product photos."
async function findExpiredImages({ retentionDays, now = new Date() } = {}) {
  if (!retentionDays) return [];
  const pool = getPool();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await pool.query(
    `SELECT i.id, i.content_hash, i.storage_path, i.created_at
     FROM images i
     LEFT JOIN image_references ir ON ir.image_id = i.id
     WHERE i.created_at < $1
     GROUP BY i.id
     HAVING COUNT(ir.id) = 0
     ORDER BY i.created_at ASC;`,
    [cutoff]
  );
  return result.rows;
}

// dryRun (default true) reports what WOULD be deleted without touching
// anything — cleanup is a destructive operation and must be opted into
// explicitly, not the default behavior of merely calling this function.
async function cleanupExpiredImages({ retentionDays = null, env = process.env, dryRun = true, now = new Date() } = {}) {
  const days = retentionDays ?? loadRetentionDaysFromEnv(env);
  if (!days) return { enabled: false, deleted: [], dryRun };

  const expired = await findExpiredImages({ retentionDays: days, now });
  const pool = getPool();
  const deleted = [];

  for (const image of expired) {
    if (!dryRun) {
      try {
        if (fs.existsSync(image.storage_path)) fs.unlinkSync(image.storage_path);
      } catch (error) {
        console.warn(`[image-retention] failed to delete file ${image.storage_path}: ${error.message}`);
        continue;
      }
      await pool.query('DELETE FROM images WHERE id = $1;', [image.id]);
    }
    deleted.push({ id: image.id, contentHash: image.content_hash, storagePath: image.storage_path, ageInDays: Math.floor((now - new Date(image.created_at)) / (24 * 60 * 60 * 1000)) });
  }

  return { enabled: true, retentionDays: days, dryRun, deleted };
}

module.exports = { loadRetentionDaysFromEnv, findExpiredImages, cleanupExpiredImages };
