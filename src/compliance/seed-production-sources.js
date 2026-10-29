#!/usr/bin/env node

// Seeds a source_compliance row for each of the four approved production
// sources, with honest, unreviewed defaults (tos_review_status:
// 'not_reviewed', enabled_in_production: false — see
// compliance-repository.js). tos_review_notes records what was actually
// observed during live adapter testing in earlier phases, not a legal
// conclusion. Safe to re-run: seedDefaultSources() never overwrites an
// existing row.

require('dotenv').config();
const { getPool, closePool } = require('../db/connection');
const { PRODUCTION_SOURCE_NAMES } = require('../sources/source-registry');
const { seedDefaultSources, upsertSourceCompliance, getSourceCompliance } = require('./compliance-repository');

const OBSERVED_NOTES = {
  'wine-com': 'Live adapter testing (Phase 4) was blocked by DataDome anti-bot protection. robots.txt not evaluated as a blocker — access was denied before that mattered. Official API availability not evaluated.',
  'total-wine': 'Live adapter testing (Phase 5) was blocked by PerimeterX anti-bot protection. robots.txt not evaluated as a blocker — access was denied before that mattered. Official API availability not evaluated.',
  'vivino': "robots.txt disallows ClaudeBot; the adapter has never been run against a live page as a result (Phase 6). Honored, not overridden — no override sign-off exists.",
  'wine-searcher': 'Live adapter testing (Phase 2/7) was blocked by anti-bot protection on most paths; adapter is hardened against known response shapes but has not achieved a sustained live success. Official API availability not evaluated.'
};

async function main() {
  await seedDefaultSources(PRODUCTION_SOURCE_NAMES);

  for (const sourceName of PRODUCTION_SOURCE_NAMES) {
    const existing = await getSourceCompliance(sourceName);
    if (!existing.tosReviewNotes) {
      await upsertSourceCompliance(sourceName, { tosReviewNotes: OBSERVED_NOTES[sourceName] });
    }
  }

  const rows = await Promise.all(PRODUCTION_SOURCE_NAMES.map(getSourceCompliance));
  console.log('source_compliance seeded for:', rows.map((r) => r.sourceName).join(', '));
  for (const row of rows) {
    console.log(`  ${row.sourceName}: tos_review_status=${row.tosReviewStatus} enabled_in_production=${row.enabledInProduction}`);
  }
}

main()
  .then(() => closePool())
  .catch((error) => {
    console.error('Seeding source_compliance failed:', error.message);
    process.exitCode = 1;
    return closePool();
  });
