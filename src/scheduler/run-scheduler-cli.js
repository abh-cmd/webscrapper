#!/usr/bin/env node

// Real process entry point for the optional in-process scheduler.
// Requires SCHEDULE_INTERVAL_MINUTES and SCHEDULE_BATCH_FILE to be set —
// refresh cadence is an open business decision (see README), so this
// process does nothing and exits with a clear message if either is unset,
// rather than assuming a cadence nobody configured.
//
// Usage: npm run schedule
// (reads SCHEDULE_INTERVAL_MINUTES / SCHEDULE_BATCH_FILE from .env)

process.env.CRAWLEE_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.APIFY_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.CRAWLEE_SYSTEM_INFO_V2 = 'false';

const { createSchedulerFromEnv } = require('./scheduler');
const { validateStartupConfig } = require('../config/startup-validator');

function main() {
  const validation = validateStartupConfig();
  if (!validation.valid) {
    console.error('Configuration errors — fix these before starting the scheduler:');
    for (const error of validation.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  for (const warning of validation.warnings) console.warn(`[config warning] ${warning}`);

  const scheduler = createSchedulerFromEnv();
  if (!scheduler) {
    console.error('SCHEDULE_INTERVAL_MINUTES and/or SCHEDULE_BATCH_FILE are not set.');
    console.error('Refresh cadence is an open business decision (see README "Business configuration") — set both to enable the scheduler.');
    process.exitCode = 1;
    return;
  }

  console.log(`Scheduler starting: every ${process.env.SCHEDULE_INTERVAL_MINUTES} minute(s), batch file ${process.env.SCHEDULE_BATCH_FILE}`);
  scheduler.start();

  process.on('SIGINT', () => {
    console.log('\nStopping scheduler...');
    scheduler.stop();
    process.exit(0);
  });
}

main();
