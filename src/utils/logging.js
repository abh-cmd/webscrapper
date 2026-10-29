const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function logSection(title) {
  console.log('');
  console.log('='.repeat(50));
  console.log(title);
  console.log('='.repeat(50));
}

function logCrawlHeader(runId, itemNumber, itemName, sourceName, sourceUrl) {
  console.log('RUN ID:');
  console.log(runId);
  console.log('');
  console.log('SOURCE:');
  console.log(sourceName);
  console.log('');
  console.log('ITEM:');
  console.log(itemNumber);
  console.log('');
  console.log('PRODUCT:');
  console.log(itemName);
  console.log('');
  console.log('URL:');
  console.log(sourceUrl);
}

function logSimple(message) {
  console.log(message);
}

function logKeyValue(label, value) {
  console.log(`${label}${' '.repeat(Math.max(1, 13 - label.length))}: ${value}`);
}

const CHECKLIST_FIELDS = [
  ['Product Name', 'product_name'],
  ['Producer', 'producer'],
  ['Category', 'category'],
  ['Size', 'size'],
  ['Vintage', 'vintage'],
  ['Varietal', 'varietal'],
  ['Region', 'region'],
  ['ABV', 'abv'],
  ['Description', 'product_description'],
  ['Food Pairing', 'food_pairing'],
  ['Ratings', 'professional_ratings'],
  ['Images', 'image_urls']
];

function logExtractionChecklist(record) {
  logSection('EXTRACTION');
  for (const [label, field] of CHECKLIST_FIELDS) {
    const value = record[field];
    const isPopulated = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
    logKeyValue(label, isPopulated ? '✓' : '-');
  }
}

function logExtractionSummary(summary) {
  logSimple(`Total schema fields: ${summary.totalFields}`);
  logSimple(`Populated fields: ${summary.populatedFields}`);
  logSimple(`Null fields: ${summary.nullFields}`);
  logSimple(`Images found: ${summary.imagesFound}`);
}

function logFailureResult({ errorType, errorMessage, sourceName, sourceUrl, runId }) {
  logSection('RESULT');
  logSimple('Status: FAILED');
  logSimple('');
  logSimple('Error type:');
  logSimple(errorType);
  logSimple('');
  logSimple('Error:');
  logSimple(errorMessage);
  logSimple('');
  logSimple('Source:');
  logSimple(sourceName);
  logSimple('');
  logSimple('URL:');
  logSimple(sourceUrl);
  logSimple('');
  logSimple('Run ID:');
  logSimple(runId);
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function createRunId() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `run_${stamp}`;
}

module.exports = {
  ensureDir,
  logSection,
  logCrawlHeader,
  logSimple,
  logExtractionChecklist,
  logExtractionSummary,
  logFailureResult,
  writeJson,
  createRunId
};
