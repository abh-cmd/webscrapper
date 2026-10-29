const path = require('node:path');

const rootDir = path.resolve(__dirname, '../..');

const crawlerConfig = {
  runTimeoutMs: Number(process.env.CRAWL_TIMEOUT_MS || 30000),
  headless: String(process.env.PLAYWRIGHT_HEADLESS ?? 'true').toLowerCase() === 'true',
  outputDirs: {
    root: path.join(rootDir, 'output'),
    raw: path.join(rootDir, 'output', 'raw'),
    results: path.join(rootDir, 'output', 'results'),
    reports: path.join(rootDir, 'output', 'reports')
  }
};

module.exports = {
  crawlerConfig
};
