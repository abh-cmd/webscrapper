#!/usr/bin/env node

process.env.CRAWLEE_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.APIFY_DISABLE_MEMORY_SNAPSHOT = '1';
process.env.CRAWLEE_SYSTEM_INFO_V2 = 'false';

const fs = require('node:fs');
const path = require('node:path');
const { runCrawl } = require('./crawler/crawler');
const { crawlerConfig } = require('./config/crawler-config');

function ensureOutputDirectories() {
  Object.values(crawlerConfig.outputDirs).forEach((dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
  });
}

function readInputFile(inputArg) {
  const filePath = path.resolve(process.cwd(), inputArg);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  const fileContent = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(fileContent);
}

async function main() {
  ensureOutputDirectories();

  const inputArg = process.argv[2];

  if (!inputArg) {
    console.error('Usage: npm run crawl -- input/sample-product.json');
    console.error('       npm run crawl -- "https://example.com/product"');
    process.exit(1);
  }

  try {
    let productInput;

    if (/^https?:\/\//i.test(inputArg)) {
      productInput = {
        item_number: 'WO-10001',
        item_name: 'Penfolds Superblend 802 B',
        size: '750ml',
        vintage: '2021',
        source: {
          name: 'wine-searcher',
          url: inputArg
        }
      };
    } else {
      productInput = readInputFile(inputArg);
    }

    const result = await runCrawl(productInput, productInput.source?.url);
    console.log('');
    console.log('Crawl completed.');
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('');
    console.error('CRAWL FAILED');
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
