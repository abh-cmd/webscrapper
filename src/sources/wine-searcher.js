const cheerio = require('cheerio');
const { safeString } = require('../utils/normalize');
const { hostnameMatches } = require('./hostname-utils');

const HOSTNAMES = ['wine-searcher.com'];

function canHandle(url) {
  return hostnameMatches(url, HOSTNAMES);
}

function classifyBlockage({ httpStatus, pageText, title }) {
  const isCaptcha = /px-captcha|perimeterx|press\s*&?\s*hold to confirm|captcha/i.test(`${pageText} ${title}`);
  const isAccessDeniedWording = /access (to this page )?(has been )?denied/i.test(`${pageText} ${title}`);

  if (httpStatus === 429) {
    return { code: 'RATE_LIMITED', message: `Wine-Searcher rate-limited this request (HTTP ${httpStatus}).` };
  }

  if (httpStatus === 401) {
    return { code: 'AUTH_REQUIRED', message: `Wine-Searcher requires authentication to view this page (HTTP ${httpStatus}).` };
  }

  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return { code: 'SOURCE_SERVER_ERROR', message: `Wine-Searcher returned a server error (HTTP ${httpStatus}).` };
  }

  if (httpStatus === 404) {
    return { code: 'PRODUCT_NOT_FOUND', message: `Wine-Searcher returned Not Found (HTTP ${httpStatus}) — no product exists at this URL.` };
  }

  if (isCaptcha || isAccessDeniedWording || httpStatus === 403) {
    const statusPart = typeof httpStatus === 'number' ? `HTTP ${httpStatus}` : 'unknown HTTP status';
    const challengePart = isCaptcha ? ' via a CAPTCHA/PerimeterX anti-bot challenge' : '';
    return { code: 'ACCESS_DENIED', message: `Wine-Searcher denied access to this page${challengePart} (${statusPart}).` };
  }

  return null;
}

function extractJsonLd($) {
  return $('script[type="application/ld+json"]').toArray()
    .map((node) => $(node).html())
    .filter(Boolean)
    .flatMap((raw) => {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (error) {
        return [];
      }
    });
}

function detectPageType({ $, jsonLdBlocks, isSearchResultsUrl }) {
  const hasProductJsonLd = jsonLdBlocks.some((item) => {
    if (!item || !item['@type']) return false;
    const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
    return types.includes('Product');
  });

  if (hasProductJsonLd) return 'PRODUCT_PAGE';
  if (isSearchResultsUrl) return 'LISTING_PAGE';
  return 'UNKNOWN_PAGE';
}

function findSingleMatchingListing($, itemName) {
  const targetTokens = safeString(itemName || '')
    ?.toLowerCase()
    .split(/\s+/)
    .filter(Boolean) || [];

  if (targetTokens.length === 0) return null;

  const anchors = $('a').toArray()
    .map((node) => ({ node, text: safeString($(node).text()) }))
    .filter((entry) => entry.text);

  const matches = anchors.filter((entry) => {
    const text = entry.text.toLowerCase();
    return targetTokens.every((token) => text.includes(token));
  });

  const uniqueByText = Array.from(new Map(matches.map((m) => [m.text.toLowerCase(), m])).values());

  return uniqueByText.length === 1 ? uniqueByText[0] : null;
}

function textOrNull($scope, selectors) {
  for (const selector of selectors) {
    const value = safeString($scope(selector).first().text());
    if (value) return value;
  }
  return null;
}

function extractFromProductPage($, jsonLdBlocks) {
  const fields = {
    brand: null,
    category: null,
    price: null,
    currency: null,
    availability_status: null,
    product_description: null,
    region: null,
    vintage: null,
    varietal: null,
    abv: null,
    image_urls: []
  };

  let productName = textOrNull($, [
    '[data-testid="product-name"]',
    'h1'
  ]);

  const ogTitle = safeString($('meta[property="og:title"]').attr('content'));
  if (!productName && ogTitle) {
    productName = ogTitle;
  }

  for (const item of jsonLdBlocks) {
    if (!item) continue;

    if (item.name && !productName) {
      productName = safeString(item.name);
    }

    if (item.brand && !fields.brand) {
      fields.brand = safeString(typeof item.brand === 'string' ? item.brand : item.brand.name);
    }

    if (item.offers) {
      const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
      for (const offer of offers) {
        if (offer.price && !fields.price) {
          fields.price = safeString(String(offer.price));
        }
        if (offer.priceCurrency && !fields.currency) {
          fields.currency = safeString(offer.priceCurrency);
        }
        if (offer.availability && !fields.availability_status) {
          fields.availability_status = safeString(offer.availability);
        }
      }
    }

    if (item.image) {
      const images = Array.isArray(item.image) ? item.image : [item.image];
      const urls = images
        .map((image) => safeString(typeof image === 'string' ? image : image.url))
        .filter(Boolean);
      if (urls.length > 0) {
        fields.image_urls = Array.from(new Set(urls));
      }
    }
  }

  fields.product_description = textOrNull($, [
    '[data-testid="description"]',
    '.wine-description',
    '.product-description',
    '.description'
  ]);
  fields.region = textOrNull($, ['[data-testid="region"]', '.producer-region', '.region']);
  fields.vintage = textOrNull($, ['[data-testid="vintage"]', '.vintage']);
  fields.varietal = textOrNull($, ['[data-testid="varietal"]', '.grape', '.varietal']);
  fields.abv = textOrNull($, ['[data-testid="abv"]', '.alcohol', '.abv']);
  if (!fields.price) {
    fields.price = textOrNull($, ['[data-testid="price"]', '.price']);
  }
  if (!fields.currency && fields.price) {
    const currencyMatch = fields.price.match(/[A-Z]{3}/);
    if (currencyMatch) fields.currency = currencyMatch[0];
  }
  if (!fields.availability_status) {
    fields.availability_status = textOrNull($, ['[data-testid="availability"]', '.stock-status', '.availability']);
  }

  if (fields.image_urls.length === 0) {
    const domImages = $('img').toArray()
      .map((img) => safeString($(img).attr('src')))
      .filter(Boolean)
      .filter((src) => !src.startsWith('data:'));
    fields.image_urls = Array.from(new Set(domImages));
  }

  return { productName, ...fields };
}

async function extractWineSearcherProduct({ page, context = {} } = {}) {
  if (!page || typeof page.content !== 'function') {
    throw new Error('Wine-Searcher adapter requires a page object with content().');
  }

  try {
    return await extractInternal({ page, context });
  } catch (error) {
    if (error.type) throw error;
    const wrapped = new Error(`Wine-Searcher extraction failed unexpectedly: ${error.message}`);
    wrapped.type = 'EXTRACTION_FAILED';
    throw wrapped;
  }
}

async function extractInternal({ page, context }) {
  const html = await page.content();
  const $ = cheerio.load(html);
  const pageText = $('body').text();
  const title = safeString($('title').first().text()) || '';
  const httpStatus = typeof context.httpStatus === 'number' ? context.httpStatus : null;

  const blockage = classifyBlockage({ httpStatus, pageText, title });
  if (blockage) {
    const err = new Error(blockage.message);
    err.type = blockage.code;
    err.httpStatus = httpStatus;
    throw err;
  }

  const jsonLdBlocks = extractJsonLd($);
  const isSearchResultsUrl = /\/find\//i.test(context.sourceUrl || '');
  const pageType = detectPageType({ $, jsonLdBlocks, isSearchResultsUrl });

  if (pageType === 'UNKNOWN_PAGE') {
    const err = new Error('Could not determine whether this Wine-Searcher page is a product page or a search-results page (no recognizable schema.org Product data and the URL is not a /find/ search page).');
    err.type = 'PAGE_TYPE_UNKNOWN';
    throw err;
  }

  const product = {
    item_number: context.item_number || null,
    item_name: context.item_name || null,
    product_name: null,
    brand: null,
    producer: null,
    category: null,
    subcategory: null,
    size: safeString(context.size) || null,
    vintage: safeString(context.vintage) || null,
    upc: null,
    sku: null,
    price: null,
    currency: null,
    availability_status: null,
    product_description: null,
    food_pairing: null,
    color: null,
    aroma: null,
    taste: null,
    seasons: null,
    occasions: null,
    comments: null,
    varietal: null,
    region: null,
    abv: null,
    winemaker_notes: null,
    product_highlights: null,
    professional_ratings: [],
    image_urls: [],
    source_site: 'wine-searcher',
    source_url: context.sourceUrl || null,
    scraped_at: new Date().toISOString()
  };

  let matchedListing = false;

  if (pageType === 'PRODUCT_PAGE') {
    const extracted = extractFromProductPage($, jsonLdBlocks);
    product.product_name = extracted.productName || product.item_name;
    product.item_name = product.item_name || extracted.productName;
    product.brand = extracted.brand;
    product.category = extracted.category;
    product.price = extracted.price;
    product.currency = extracted.currency;
    product.availability_status = extracted.availability_status;
    product.product_description = extracted.product_description;
    product.region = extracted.region;
    product.vintage = extracted.vintage || product.vintage;
    product.varietal = extracted.varietal;
    product.abv = extracted.abv;
    product.image_urls = extracted.image_urls;
    matchedListing = true;
  } else if (pageType === 'LISTING_PAGE') {
    // Unlike the other production adapters, Wine-Searcher's known real URL
    // is itself a /find/ search-results page, so a LISTING_PAGE is not
    // automatically rejected — if exactly one listing's link text matches
    // every word of the requested item name, extraction proceeds from that
    // listing's own DOM subtree only. Zero or multiple matches means the
    // requested product cannot be confidently identified on this page, so
    // the page must not be turned into a fake product record.
    const matched = findSingleMatchingListing($, context.item_name);

    if (!matched) {
      const err = new Error(`Wine-Searcher search-results page did not contain exactly one confident match for "${context.item_name || 'the requested item'}".`);
      err.type = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    matchedListing = true;
    product.product_name = matched.text;

    const href = safeString($(matched.node).attr('href'));
    if (href) {
      const container = $(matched.node).closest('li, tr, .wine-card, [class*="result"], [class*="listing"]');
      const scope = container.length > 0 ? container : $(matched.node).parent();

      product.region = textOrNull((sel) => scope.find(sel), ['.region', '[data-testid="region"]']);
      product.vintage = textOrNull((sel) => scope.find(sel), ['.vintage']) || product.vintage;
      product.price = textOrNull((sel) => scope.find(sel), ['.price', '[data-testid="price"]']);

      const listingImage = scope.find('img').first().attr('src');
      if (safeString(listingImage) && !listingImage.startsWith('data:')) {
        product.image_urls = [safeString(listingImage)];
      }
    }
  }

  product.__meta = { pageType, matchedListing };

  return product;
}

module.exports = {
  extractWineSearcherProduct,
  classifyBlockage,
  detectPageType,
  canHandle,
  hostnames: HOSTNAMES
};
