const { getPool } = require('../db/connection');

// "Once the extracted product data has been reviewed and approved for
// Producer, Region, Varietal, Professional rater... Match extracted values
// against the existing Master for each field. If a matching field master
// exists, use the existing master ids. If the master id does not exist,
// create a new record... Master data creation and mapping should only
// occur after the product data has been approved."
//
// This module is only ever called from staging-repository.approveStaging()
// — there is no other call site, so mapping genuinely cannot happen before
// approval. Matching is case-insensitive/whitespace-normalized.

const MASTER_TABLES = {
  producer: 'master_producers',
  region: 'master_regions',
  varietal: 'master_varietals',
  professional_rater: 'master_professional_raters'
};

function normalizeName(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getOrCreateMaster(kind, name) {
  const tableName = MASTER_TABLES[kind];
  if (!tableName) throw new Error(`Unknown master data kind: "${kind}". Expected one of: ${Object.keys(MASTER_TABLES).join(', ')}.`);

  const normalized = normalizeName(name);
  if (!normalized) return null;

  const pool = getPool();

  const existing = await pool.query(`SELECT id FROM ${tableName} WHERE normalized_name = $1;`, [normalized]);
  if (existing.rows.length > 0) return existing.rows[0].id;

  try {
    const inserted = await pool.query(
      `INSERT INTO ${tableName} (name, normalized_name) VALUES ($1, $2) RETURNING id;`,
      [name.trim(), normalized]
    );
    return inserted.rows[0].id;
  } catch (error) {
    if (error.code !== '23505') throw error; // lost a race with a concurrent create -> look it up
    const raced = await pool.query(`SELECT id FROM ${tableName} WHERE normalized_name = $1;`, [normalized]);
    return raced.rows[0].id;
  }
}

// Maps an already-approved, already-promoted product's Producer/Region/
// Varietal/Professional-Rater values to master records, creating them if
// absent, and links the product row to the resulting IDs.
async function mapApprovedProductToMasterData(product) {
  const producerId = await getOrCreateMaster('producer', product.producer);
  const regionId = await getOrCreateMaster('region', product.region);
  const varietalId = await getOrCreateMaster('varietal', product.varietal);

  const pool = getPool();
  await pool.query(
    `UPDATE products
     SET producer_master_id = $2, region_master_id = $3, varietal_master_id = $4, updated_at = now()
     WHERE item_number = $1;`,
    [product.item_number, producerId, regionId, varietalId]
  );

  const raterLinks = [];
  for (const rating of product.professional_ratings || []) {
    if (!rating || !rating.rater) continue;
    const raterId = await getOrCreateMaster('professional_rater', rating.rater);
    if (!raterId) continue;

    await pool.query(
      `INSERT INTO product_rater_links (item_number, rater_name, rater_master_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (item_number, rater_name) DO UPDATE SET rater_master_id = EXCLUDED.rater_master_id;`,
      [product.item_number, rating.rater, raterId]
    );
    raterLinks.push({ raterName: rating.rater, raterMasterId: raterId });
  }

  return { producerId, regionId, varietalId, raterLinks };
}

module.exports = { getOrCreateMaster, mapApprovedProductToMasterData, MASTER_TABLES, normalizeName };
