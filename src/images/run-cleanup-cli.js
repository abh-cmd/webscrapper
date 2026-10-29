#!/usr/bin/env node

// Real process entry point for image retention cleanup. Defaults to a dry
// run — pass --apply to actually delete anything. Requires
// IMAGE_RETENTION_DAYS to be set (see src/images/retention.js for why no
// default retention period is invented).
// Usage: npm run image:cleanup [-- --apply]

require('dotenv').config();
const { cleanupExpiredImages } = require('./retention');
const { closePool } = require('../db/connection');

async function main() {
  const apply = process.argv.includes('--apply');
  const result = await cleanupExpiredImages({ dryRun: !apply });

  if (!result.enabled) {
    console.log('IMAGE_RETENTION_DAYS is not set — image cleanup is disabled. Nothing to do.');
    return;
  }

  console.log(`Retention: ${result.retentionDays} day(s) | mode: ${result.dryRun ? 'DRY RUN (pass --apply to actually delete)' : 'APPLY'}`);
  console.log(`${result.dryRun ? 'Would delete' : 'Deleted'} ${result.deleted.length} unreferenced, expired image(s):`);
  for (const image of result.deleted) {
    console.log(`  - ${image.contentHash.slice(0, 16)}... (${image.ageInDays} days old) ${image.storagePath}`);
  }
}

main()
  .then(() => closePool())
  .catch((error) => {
    console.error('Image cleanup failed:', error.message);
    process.exitCode = 1;
    return closePool();
  });
