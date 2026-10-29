const { getPool } = require('../db/connection');

// "robots.txt is honoured by default; any override is per-source,
// config-driven, and requires sign-off recorded on the source's adapter...
// Legal/ToS review per source before it is enabled in production, covering
// image licensing as well as data use. Each adapter records whether the
// source's images may be redistributed or are internal use only."
//
// No source in this project has actually completed a legal/ToS review —
// every row defaults to tos_review_status='not_reviewed' and
// enabled_in_production=false. Nothing here fabricates a sign-off that
// hasn't happened.

function fromRow(row) {
  if (!row) return null;
  return {
    sourceName: row.source_name,
    robotsTxtHonored: row.robots_txt_honored,
    robotsTxtOverride: row.robots_txt_override,
    robotsTxtOverrideReason: row.robots_txt_override_reason,
    robotsTxtOverrideSignedOffBy: row.robots_txt_override_signed_off_by,
    robotsTxtOverrideSignedOffAt: row.robots_txt_override_signed_off_at,
    officialApiAvailable: row.official_api_available,
    officialApiPreferred: row.official_api_preferred,
    tosReviewStatus: row.tos_review_status,
    tosReviewNotes: row.tos_review_notes,
    imageRedistributionStatus: row.image_redistribution_status,
    enabledInProduction: row.enabled_in_production,
    updatedAt: row.updated_at
  };
}

async function upsertSourceCompliance(sourceName, fields = {}) {
  const pool = getPool();
  const current = await getSourceCompliance(sourceName);

  const merged = {
    robots_txt_honored: fields.robotsTxtHonored ?? current?.robotsTxtHonored ?? true,
    robots_txt_override: fields.robotsTxtOverride ?? current?.robotsTxtOverride ?? false,
    robots_txt_override_reason: fields.robotsTxtOverrideReason ?? current?.robotsTxtOverrideReason ?? null,
    robots_txt_override_signed_off_by: fields.robotsTxtOverrideSignedOffBy ?? current?.robotsTxtOverrideSignedOffBy ?? null,
    robots_txt_override_signed_off_at: fields.robotsTxtOverrideSignedOffAt ?? current?.robotsTxtOverrideSignedOffAt ?? null,
    official_api_available: fields.officialApiAvailable ?? current?.officialApiAvailable ?? false,
    official_api_preferred: fields.officialApiPreferred ?? current?.officialApiPreferred ?? false,
    tos_review_status: fields.tosReviewStatus ?? current?.tosReviewStatus ?? 'not_reviewed',
    tos_review_notes: fields.tosReviewNotes ?? current?.tosReviewNotes ?? null,
    image_redistribution_status: fields.imageRedistributionStatus ?? current?.imageRedistributionStatus ?? 'internal_use_only',
    enabled_in_production: fields.enabledInProduction ?? current?.enabledInProduction ?? false
  };

  // A robots.txt override MUST carry a sign-off — this is enforced here,
  // not just documented, per "requires sign-off recorded."
  if (merged.robots_txt_override && (!merged.robots_txt_override_reason || !merged.robots_txt_override_signed_off_by)) {
    throw new Error('A robots.txt override requires both robotsTxtOverrideReason and robotsTxtOverrideSignedOffBy.');
  }
  if (merged.robots_txt_override && !merged.robots_txt_override_signed_off_at) {
    merged.robots_txt_override_signed_off_at = new Date();
  }

  const result = await pool.query(
    `INSERT INTO source_compliance (
       source_name, robots_txt_honored, robots_txt_override, robots_txt_override_reason,
       robots_txt_override_signed_off_by, robots_txt_override_signed_off_at,
       official_api_available, official_api_preferred, tos_review_status, tos_review_notes,
       image_redistribution_status, enabled_in_production, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (source_name) DO UPDATE SET
       robots_txt_honored = EXCLUDED.robots_txt_honored,
       robots_txt_override = EXCLUDED.robots_txt_override,
       robots_txt_override_reason = EXCLUDED.robots_txt_override_reason,
       robots_txt_override_signed_off_by = EXCLUDED.robots_txt_override_signed_off_by,
       robots_txt_override_signed_off_at = EXCLUDED.robots_txt_override_signed_off_at,
       official_api_available = EXCLUDED.official_api_available,
       official_api_preferred = EXCLUDED.official_api_preferred,
       tos_review_status = EXCLUDED.tos_review_status,
       tos_review_notes = EXCLUDED.tos_review_notes,
       image_redistribution_status = EXCLUDED.image_redistribution_status,
       enabled_in_production = EXCLUDED.enabled_in_production,
       updated_at = now()
     RETURNING *;`,
    [
      sourceName, merged.robots_txt_honored, merged.robots_txt_override, merged.robots_txt_override_reason,
      merged.robots_txt_override_signed_off_by, merged.robots_txt_override_signed_off_at,
      merged.official_api_available, merged.official_api_preferred, merged.tos_review_status, merged.tos_review_notes,
      merged.image_redistribution_status, merged.enabled_in_production
    ]
  );
  return fromRow(result.rows[0]);
}

async function getSourceCompliance(sourceName) {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM source_compliance WHERE source_name = $1;', [sourceName]);
  return fromRow(result.rows[0]);
}

async function listSourceCompliance() {
  const pool = getPool();
  const result = await pool.query('SELECT * FROM source_compliance ORDER BY source_name;');
  return result.rows.map(fromRow);
}

// A source may only be used in production once robots.txt is honored (or
// a signed-off override exists) AND legal/ToS review has actually
// approved it — never just because someone flipped enabledInProduction.
async function isSourceProductionReady(sourceName) {
  const compliance = await getSourceCompliance(sourceName);
  if (!compliance) return false;
  const robotsOk = compliance.robotsTxtHonored || (compliance.robotsTxtOverride && compliance.robotsTxtOverrideSignedOffBy);
  return Boolean(robotsOk && compliance.tosReviewStatus === 'approved' && compliance.enabledInProduction);
}

// Ensures a compliance row exists for every known production source, with
// the honest, unreviewed defaults — does not overwrite an existing row.
async function seedDefaultSources(sourceNames) {
  for (const sourceName of sourceNames) {
    const existing = await getSourceCompliance(sourceName);
    if (!existing) await upsertSourceCompliance(sourceName, {});
  }
}

module.exports = {
  upsertSourceCompliance,
  getSourceCompliance,
  listSourceCompliance,
  isSourceProductionReady,
  seedDefaultSources
};
