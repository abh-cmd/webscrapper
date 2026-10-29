#!/usr/bin/env node

// CLI entry point for batch / scheduled execution. Any external scheduler
// (cron, Windows Task Scheduler, a CI scheduled job) can invoke this at
// whatever interval is eventually decided — see README "Batch execution".
//
// Usage: npm run batch -- input/batch/products.json
//   where products.json is a JSON array of product inputs (same shape as
//   input/sample-product.json). Safe to re-invoke with the same file after
//   a crash/interruption: enqueueing is deduped by the existing queue, and
//   only outstanding work is processed (see src/batch/batch-runner.js).

process.env.CRAWLEE_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.APIFY_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.CRAWLEE_SYSTEM_INFO_V2 = 'false';

const fs = require('node:fs');
const path = require('node:path');
const { runBatch } = require('./batch-runner');

function readProductInputs(inputArg) {
  const filePath = path.resolve(process.cwd(), inputArg);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${filePath} to contain a JSON array of product inputs.`);
  }
  return parsed;
}

async function main() {
  const inputArg = process.argv[2];
  if (!inputArg) {
    console.error('Usage: npm run batch -- input/batch/products.json');
    process.exitCode = 1;
    return;
  }

  const productInputs = readProductInputs(inputArg);
  console.log(`Batch: enqueueing and draining ${productInputs.length} product(s) from ${inputArg}`);

  const results = await runBatch(productInputs);

  const staged = results.filter((r) => r.status === 'staged');
  const failed = results.filter((r) => r.status === 'failed');

  console.log('');
  console.log('==================================================');
  console.log('BATCH RESULT');
  console.log('==================================================');
  console.log(`Staged: ${staged.length}`);
  console.log(`Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.log('');
    console.log('Failures:');
    for (const f of failed) {
      console.log(`  ${f.itemNumber}: ${f.error?.type || 'UNKNOWN'} — ${f.error?.message || ''}`);
    }
  }

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('');
  console.error('BATCH FAILED');
  console.error(error.message);
  process.exitCode = 1;
});
