#!/usr/bin/env node

// Startup configuration check as a standalone command — run this before
// deploying to a new machine, or any time environment variables change.
// Exits non-zero on any hard error; warnings are informational only.
// Usage: npm run config:check

require('dotenv').config();
const { validateStartupConfig } = require('./startup-validator');

const result = validateStartupConfig();

if (result.warnings.length > 0) {
  console.log('Warnings:');
  for (const warning of result.warnings) console.log(`  - ${warning}`);
  console.log('');
}

if (result.errors.length > 0) {
  console.error('Errors (must fix before running the system):');
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log('Configuration OK.');
}
