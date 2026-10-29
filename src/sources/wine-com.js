const cheerio = require('cheerio');
const { safeString } = require('../utils/normalize');
const { hostnameMatches } = require('./hostname-utils');

const HOSTNAMES = ['wine.com'];

function canHandle(url) {
  return hostnameMatches(url, HOSTNAMES);
}

// Every real automated request to wine.com during Phase 4 inspection (a
// search page and a real product page pulled from wine.com's own public
// sitemap.xml) returned an identical DataDome anti-bot challenge before any
// application content was served. Wine.com's real DOM has never been
// observed, so this adapter deliberately does NOT contain guessed
// wine.com-specific CSS selectors. Extraction instead relies only on
// generic, standards-based signals (schema.org JSON-LD, OpenGraph) that are
// explicitly sanctioned as the primary extraction source for this phase —
// not a fallback invented in place of real selectors.
function classifyAccessFailure({ httpStatus, pageText, title }) {
  const combined = `${pageText} ${title}`;
  const isDataDomeChallenge = /datadome|captcha-delivery\.com|please enable js and disable any ad ?blocker/i.test(combined);

  if (httpStatus === 429) {
    return { code: 'RATE_LIMITED', message: `Wine.com rate-limited this request (HTTP ${httpStatus}).` };
  }
  if (httpStatus === 401) {
    return { code: 'AUTH_REQUIRED', message: `Wine.com requires authentication to view this page (HTTP ${httpStatus}).` };
  }
  if (typeof httpStatus === 'number' && httpStatus >= 500) {
    return { code: 'SOURCE_SERVER_ERROR', message: `Wine.com returned a server error (HTTP ${httpStatus}).` };
  }
  if (httpStatus === 404) {
    return { code: 'PRODUCT_NOT_FOUND', message: `Wine.com returned Not Found (HTTP ${httpStatus}) — no product exists at this URL.` };
  }
  if (isDataDomeChallenge || httpStatus === 403) {
    const challengePart = isDataDomeChallenge ? ' via a DataDome anti-bot challenge' : '';
    return { code: 'ACCESS_DENIED', message: `Wine.com denied access to this page${challengePart} (HTTP ${httpStatus ?? 'unknown'}).` };
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

function typesOf(item) {
  if (!item || !item['@type']) return [];
  return Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
}

// Page-type detection relies only on the standardized schema.org @type
// vocabulary, never on guessed wine.com URL/path conventions (which were
// never confirmed, since every URL tested returned the same anti-bot block).
function detectPageType(jsonLdBlocks) {
  const hasProduct = jsonLdBlocks.some((item) => typesOf(item).includes('Product'));
  if (hasProduct) return 'PRODUCT_PAGE';

  const hasListing = jsonLdBlocks.some((item) => {
    const types = typesOf(item);
    return types.includes('ItemList') || types.includes('CollectionPage') || types.includes('SearchResultsPage');
  });
  if (hasListing) return 'LISTING_PAGE';

  return 'UNKNOWN_PAGE';
}

function tokenize(value) {
  return safeString(value || '')
    ?.toLowerCase()
    .split(/\s+/)
    .filter(Boolean) || [];
}

function isMatchingProduct(productName, requestedItemName) {
  const requestedTokens = tokenize(requestedItemName);
  const productTokens = tokenize(productName);
  if (requestedTokens.length === 0 || productTokens.length === 0) return false;
  return requestedTokens.every((token) => productTokens.includes(token));
}

// Generic scan of schema.org Product's standard additionalProperty
// (PropertyValue) mechanism — not a wine.com-specific selector. Sites that
// expose structured wine attributes (size, vintage, varietal, region, ABV,
// tasting notes, food pairing) commonly do so this way; if wine.com does
// not, these simply stay null, which is the correct behavior here.
function findAdditionalProperty(jsonLdProduct, nameKeywords) {
  const props = Array.isArray(jsonLdProduct.additionalProperty) ? jsonLdProduct.additionalProperty : [];
  const match = props.find((prop) => {
    const propName = safeString(prop && prop.name);
    return propName && nameKeywords.test(propName);
  });
  return match ? safeString(match.value) : null;
}

function extractImages(jsonLdProduct, $) {
  const raw = jsonLdProduct.image;
  let images = [];
  if (Array.isArray(raw)) {
    images = raw.map((img) => (typeof img === 'string' ? img : img && img.url));
  } else if (typeof raw === 'string') {
    images = [raw];
  } else if (raw && raw.url) {
    images = [raw.url];
  }

  images = images.map((url) => safeString(url)).filter(Boolean);

  if (images.length === 0) {
    const ogImage = safeString($('meta[property="og:image"]').attr('content'));
    if (ogImage) images = [ogImage];
  }

  return Array.from(new Set(images));
}

function extractAvailability(offer) {
  if (!offer || !offer.availability) return null;
  const key = String(offer.availability).split('/').pop();
  const labels = {
    InStock: 'In stock',
    OutOfStock: 'Out of stock',
    PreOrder: 'Preorder',
    LimitedAvailability: 'Limited availability',
    SoldOut: 'Sold out',
    Discontinued: 'Discontinued'
  };
  return labels[key] || safeString(key);
}

async function extractWineComProduct({ page, context = {} } = {}) {
  if (!page || typeof page.content !== 'function') {
    throw new Error('Wine.com adapter requires a page object with content().');
  }

  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const pageText = $('body').text();
    const title = safeString($('title').first().text()) || '';
    const httpStatus = typeof context.httpStatus === 'number' ? context.httpStatus : null;

    const accessFailure = classifyAccessFailure({ httpStatus, pageText, title });
    if (accessFailure) {
      const err = new Error(accessFailure.message);
      err.type = accessFailure.code;
      err.httpStatus = httpStatus;
      throw err;
    }

    const jsonLdBlocks = extractJsonLd($);
    const pageType = detectPageType(jsonLdBlocks);

    if (pageType === 'LISTING_PAGE') {
      const err = new Error(`Wine.com URL resolved to a listing/search page, not a single product page, for "${context.item_name || 'the requested item'}".`);
      err.type = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    if (pageType === 'UNKNOWN_PAGE') {
      const err = new Error('Could not determine whether this Wine.com page is a product page or a listing page (no recognizable schema.org Product/ItemList data present).');
      err.type = 'PAGE_TYPE_UNKNOWN';
      throw err;
    }

    const jsonLdProduct = jsonLdBlocks.find((item) => typesOf(item).includes('Product'));

    const ogTitle = safeString($('meta[property="og:title"]').attr('content'));
    const productName = safeString(jsonLdProduct.name) || ogTitle || safeString($('h1').first().text());

    if (!isMatchingProduct(productName, context.item_name)) {
      const err = new Error(`Wine.com product page found ("${productName}") does not match the requested item ("${context.item_name}").`);
      err.type = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const offerRaw = jsonLdProduct.offers;
    const offer = Array.isArray(offerRaw) ? offerRaw[0] : offerRaw;

    const product = {
      item_number: context.item_number || null,
      item_name: context.item_name || null,
      product_name: productName,
      brand: safeString(jsonLdProduct.brand && (jsonLdProduct.brand.name || jsonLdProduct.brand)) || null,
      producer: safeString(jsonLdProduct.manufacturer && (jsonLdProduct.manufacturer.name || jsonLdProduct.manufacturer)) || null,
      category: safeString(jsonLdProduct.category) || null,
      subcategory: null,
      size: safeString(context.size) || findAdditionalProperty(jsonLdProduct, /size|bottle/i),
      vintage: safeString(context.vintage) || findAdditionalProperty(jsonLdProduct, /vintage|year/i),
      upc: safeString(jsonLdProduct.gtin13 || jsonLdProduct.gtin12 || jsonLdProduct.gtin) || null,
      sku: safeString(jsonLdProduct.sku || jsonLdProduct.mpn) || null,
      price: offer ? safeString(String(offer.price ?? '')) : null,
      currency: offer ? safeString(offer.priceCurrency) : null,
      availability_status: extractAvailability(offer),
      product_description: safeString(jsonLdProduct.description) || safeString($('meta[property="og:description"]').attr('content')),
      food_pairing: findAdditionalProperty(jsonLdProduct, /food ?pairing/i),
      color: findAdditionalProperty(jsonLdProduct, /colou?r|appearance/i),
      aroma: findAdditionalProperty(jsonLdProduct, /aroma|nose/i),
      taste: findAdditionalProperty(jsonLdProduct, /taste|palate/i),
      seasons: null,
      occasions: null,
      comments: null,
      varietal: findAdditionalProperty(jsonLdProduct, /varietal|grape/i),
      region: findAdditionalProperty(jsonLdProduct, /region|appellation/i),
      abv: findAdditionalProperty(jsonLdProduct, /abv|alcohol/i),
      winemaker_notes: findAdditionalProperty(jsonLdProduct, /winemaker/i),
      product_highlights: findAdditionalProperty(jsonLdProduct, /highlight/i),
      // schema.org `review` blocks on e-commerce pages are typically customer
      // reviews, not professional critic scores (e.g. Wine Spectator), and
      // there is no generic, reliable way to tell them apart without having
      // seen wine.com's real markup. Left empty rather than mislabeling
      // customer reviews as professional ratings.
      professional_ratings: [],
      image_urls: extractImages(jsonLdProduct, $),
      source_site: 'wine-com',
      source_url: context.sourceUrl || null,
      scraped_at: new Date().toISOString()
    };

    product.__meta = { pageType, matchedListing: true };

    return product;
  } catch (error) {
    if (error.type) throw error;
    const wrapped = new Error(`Wine.com extraction failed unexpectedly: ${error.message}`);
    wrapped.type = 'EXTRACTION_FAILED';
    throw wrapped;
  }
}

module.exports = {
  name: 'wine-com',
  hostnames: HOSTNAMES,
  canHandle,
  extract: extractWineComProduct,
  classifyAccessFailure,
  detectPageType,
  isMatchingProduct
};
