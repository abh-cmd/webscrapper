const cheerio = require('cheerio');
const { safeString } = require('../utils/normalize');

// A last-resort adapter for any product URL that ISN'T one of the four
// approved, purpose-built production sources (wine-com, total-wine,
// vivino, wine-searcher). It relies entirely on standards-based signals
// already present on the page — schema.org Product JSON-LD (the same
// mechanism Google/Bing use for product rich results) and OpenGraph meta
// tags — never a site-specific CSS selector, since by definition this
// code has never seen the target site's layout.
//
// This is a generalization of vivino.js's own extraction logic (that
// adapter has always been schema.org/OpenGraph-only, since vivino.com's
// robots.txt has never allowed a real page to be observed to write
// site-specific selectors against). Real robots.txt enforcement and
// anti-bot/HTTP-status classification still apply exactly the same way
// as every other source — this only adds extraction logic for sites that
// previously had none; it changes nothing about compliance.

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

// Embedded application JSON — Mode 6. Falls back to this ONLY when no
// schema.org Product JSON-LD was found. Deliberately narrow: rather than
// guess at arbitrary front-end framework state shapes (Next.js/Nuxt state
// objects vary per-site and would require per-site mapping — indistinguishable
// from writing a new adapter), this supports exactly one real, stable,
// widely-documented convention: Shopify's own product-JSON script tag,
// present verbatim (same field names, same structure) on every default
// Shopify theme regardless of which store it is. Confirmed present via
// direct HTML inspection on real sites (Josh Cellars, Silver Oak) before
// this was written — not a speculative guess at a format that might exist.
// Returns null (not a fabricated empty object) when the tag isn't present,
// so callers can tell "no Shopify product JSON" apart from "empty product".
function extractShopifyProductJson($) {
  const candidates = $('script[id^="ProductJson-"], script[id="ProductJson"], script[data-product-json]').toArray();
  for (const node of candidates) {
    const raw = $(node).html();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && (parsed.title || parsed.variants)) return parsed;
    } catch (error) {
      // not valid JSON in this tag — try the next candidate rather than failing the whole extraction
    }
  }
  return null;
}

// Shopify prices are integer cents (e.g. 4695 = $46.95) — a real, documented
// convention, not a guess. Only applied to values that actually came from
// a Shopify product JSON payload, never to JSON-LD (which is already a
// decimal string) or OpenGraph.
function shopifyCentsToDecimal(cents) {
  if (typeof cents !== 'number') return null;
  return (cents / 100).toFixed(2);
}

function typesOf(item) {
  if (!item || !item['@type']) return [];
  return Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
}

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

// Unlike the four named adapters, a generic target may be crawled with no
// requested item_name at all (an ad hoc "just fetch this URL" run) — in
// that case there is nothing to mismatch against, so it passes rather
// than rejecting.
function isMatchingProduct(productName, requestedItemName) {
  const requestedTokens = tokenize(requestedItemName);
  if (requestedTokens.length === 0) return true;
  const productTokens = tokenize(productName);
  if (productTokens.length === 0) return false;
  return requestedTokens.every((token) => productTokens.includes(token));
}

function findAdditionalProperty(jsonLdProduct, nameKeywords) {
  const props = Array.isArray(jsonLdProduct.additionalProperty) ? jsonLdProduct.additionalProperty : [];
  const match = props.find((prop) => {
    const propName = safeString(prop && prop.name);
    return propName && nameKeywords.test(propName);
  });
  return match ? safeString(match.value) : null;
}

function extractImages(jsonLdProduct, $) {
  const raw = jsonLdProduct ? jsonLdProduct.image : null;
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
    InStock: 'In stock', OutOfStock: 'Out of stock', PreOrder: 'Preorder',
    LimitedAvailability: 'Limited availability', SoldOut: 'Sold out', Discontinued: 'Discontinued'
  };
  return labels[key] || safeString(key);
}

function classifyAccessFailure({ httpStatus, pageText, title }, hostname) {
  const combined = `${pageText} ${title}`;
  // Split what was one combined regex into two, so a CAPTCHA challenge is
  // distinguishable from generic bot-detection wording in the reported
  // detail (challengeType) — the error.type itself stays ACCESS_DENIED for
  // both, unchanged, so nothing that already asserts on error.type breaks.
  const isCaptchaWording = /captcha|are you a robot|i'?m not a robot/i.test(combined);
  const isBotChallengeWording = isCaptchaWording || /bot detection|automated (access|requests?)|unusual traffic|checking your browser|verify you are human/i.test(combined);
  const isAccessDeniedWording = /access (to this page )?(has been )?denied|forbidden/i.test(combined);

  if (httpStatus === 429) return { code: 'RATE_LIMITED', challengeType: 'RATE_LIMIT', message: `${hostname} rate-limited this request (HTTP ${httpStatus}).` };
  if (httpStatus === 401) return { code: 'AUTH_REQUIRED', challengeType: 'AUTH', message: `${hostname} requires authentication to view this page (HTTP ${httpStatus}).` };
  if (typeof httpStatus === 'number' && httpStatus >= 500) return { code: 'SOURCE_SERVER_ERROR', challengeType: 'SERVER_ERROR', message: `${hostname} returned a server error (HTTP ${httpStatus}).` };
  if (httpStatus === 404) return { code: 'PRODUCT_NOT_FOUND', challengeType: 'NOT_FOUND', message: `${hostname} returned Not Found (HTTP ${httpStatus}) — no product exists at this URL.` };
  if (isBotChallengeWording || isAccessDeniedWording || httpStatus === 403) {
    const challengeType = isCaptchaWording ? 'CAPTCHA' : (isBotChallengeWording ? 'ANTI_BOT' : 'ACCESS_DENIED');
    const challengePart = isBotChallengeWording ? ` via ${isCaptchaWording ? 'a CAPTCHA' : 'an anti-bot'} challenge` : '';
    return { code: 'ACCESS_DENIED', challengeType, message: `${hostname} denied access to this page${challengePart} (HTTP ${httpStatus ?? 'unknown'}).` };
  }
  return null;
}

async function extractGenericProduct({ page, context = {} } = {}) {
  if (!page || typeof page.content !== 'function') {
    throw new Error('Generic adapter requires a page object with content().');
  }
  const hostname = context.sourceName || 'this site';

  try {
    const html = await page.content();
    const $ = cheerio.load(html);
    const pageText = $('body').text();
    const title = safeString($('title').first().text()) || '';
    const httpStatus = typeof context.httpStatus === 'number' ? context.httpStatus : null;

    const accessFailure = classifyAccessFailure({ httpStatus, pageText, title }, hostname);
    if (accessFailure) {
      const err = new Error(accessFailure.message);
      err.type = accessFailure.code;
      err.httpStatus = httpStatus;
      err.challengeType = accessFailure.challengeType || null;
      throw err;
    }

    const jsonLdBlocks = extractJsonLd($);
    const pageType = detectPageType(jsonLdBlocks);

    if (pageType === 'LISTING_PAGE') {
      const err = new Error(`This URL resolved to a listing/search page, not a single product page, for "${context.item_name || 'the requested item'}".`);
      err.type = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const jsonLdProduct = jsonLdBlocks.find((item) => typesOf(item).includes('Product'));

    // Mode 6 fallback: only attempted when JSON-LD had no Product block at
    // all — a real, evidence-backed addition (Josh Cellars and Silver Oak
    // were confirmed, by direct HTML inspection, to expose this exact
    // Shopify convention while having no JSON-LD Product). Never runs
    // instead of JSON-LD, only in addition to it, and only for the one
    // stable, documented format this covers.
    const shopifyProduct = jsonLdProduct ? null : extractShopifyProductJson($);

    const ogTitle = safeString($('meta[property="og:title"]').attr('content'));
    const productName = safeString(jsonLdProduct && jsonLdProduct.name)
      || safeString(shopifyProduct && shopifyProduct.title)
      || ogTitle
      || safeString($('h1').first().text());

    if ((pageType === 'UNKNOWN_PAGE' && !shopifyProduct) || !productName) {
      const err = new Error('Could not find any recognizable product data on this page (no schema.org Product JSON-LD, no Shopify product JSON, no OpenGraph title, no <h1>). This site may render its content entirely client-side, or may not expose standard product markup this generic adapter can read.');
      err.type = 'PAGE_TYPE_UNKNOWN';
      throw err;
    }

    if (!isMatchingProduct(productName, context.item_name)) {
      const err = new Error(`Page found ("${productName}") does not match the requested item ("${context.item_name}").`);
      err.type = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const offerRaw = jsonLdProduct && jsonLdProduct.offers;
    const offer = Array.isArray(offerRaw) ? offerRaw[0] : offerRaw;
    const shopifyVariant = shopifyProduct && Array.isArray(shopifyProduct.variants) ? shopifyProduct.variants[0] : null;

    let product;
    if (jsonLdProduct) {
      product = {
        item_number: context.item_number || null,
        item_name: context.item_name || null,
        product_name: productName,
        brand: safeString(jsonLdProduct.brand && (jsonLdProduct.brand.name || jsonLdProduct.brand)) || null,
        producer: safeString(jsonLdProduct.manufacturer && (jsonLdProduct.manufacturer.name || jsonLdProduct.manufacturer)) || null,
        category: safeString(jsonLdProduct.category) || null,
        subcategory: null,
        size: safeString(context.size) || findAdditionalProperty(jsonLdProduct, /size|bottle|volume/i),
        vintage: safeString(context.vintage) || findAdditionalProperty(jsonLdProduct, /vintage|year/i),
        upc: safeString(jsonLdProduct.gtin13 || jsonLdProduct.gtin12 || jsonLdProduct.gtin) || null,
        sku: safeString(jsonLdProduct.sku || jsonLdProduct.mpn) || null,
        price: offer ? safeString(String(offer.price ?? '')) : null,
        currency: offer ? safeString(offer.priceCurrency) : null,
        availability_status: extractAvailability(offer),
        product_description: safeString(jsonLdProduct.description) || safeString($('meta[property="og:description"]').attr('content')) || safeString($('meta[name="description"]').attr('content')),
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
        professional_ratings: [],
        image_urls: extractImages(jsonLdProduct, $),
        source_site: hostname,
        source_url: context.sourceUrl || null,
        scraped_at: new Date().toISOString()
      };
      product.__meta = { pageType, matchedListing: true, extractionMethod: 'generic-schema-org' };
    } else {
      // Shopify path — every field comes from the real payload; anything
      // Shopify's schema doesn't carry (varietal, region, ABV, tasting
      // notes, etc.) stays null, exactly like the JSON-LD path.
      const rawImages = Array.isArray(shopifyProduct.images) ? shopifyProduct.images : [];
      const normalizedImages = rawImages
        .map((img) => safeString(typeof img === 'string' ? img : img && img.src))
        .filter(Boolean)
        .map((url) => (url.startsWith('//') ? `https:${url}` : url));

      product = {
        item_number: context.item_number || null,
        item_name: context.item_name || null,
        product_name: productName,
        brand: safeString(shopifyProduct.vendor) || null,
        producer: null,
        category: safeString(shopifyProduct.type) || null,
        subcategory: null,
        size: safeString(context.size) || null,
        vintage: safeString(context.vintage) || null,
        upc: safeString(shopifyVariant && shopifyVariant.barcode) || null,
        sku: safeString(shopifyVariant && shopifyVariant.sku) || null,
        price: shopifyVariant ? shopifyCentsToDecimal(shopifyVariant.price) : (typeof shopifyProduct.price === 'number' ? shopifyCentsToDecimal(shopifyProduct.price) : null),
        currency: null, // Shopify's ProductJson tag does not itself carry a currency code
        availability_status: (shopifyVariant ? shopifyVariant.available : shopifyProduct.available) === false ? 'Out of stock' : ((shopifyVariant ? shopifyVariant.available : shopifyProduct.available) === true ? 'In stock' : null),
        product_description: safeString(shopifyProduct.description ? shopifyProduct.description.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null),
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
        image_urls: Array.from(new Set(normalizedImages.length ? normalizedImages : (() => {
          const og = safeString($('meta[property="og:image"]').attr('content'));
          return og ? [og] : [];
        })())),
        source_site: hostname,
        source_url: context.sourceUrl || null,
        scraped_at: new Date().toISOString()
      };
      product.__meta = { pageType: 'PRODUCT_PAGE', matchedListing: true, extractionMethod: 'generic-shopify-json' };
    }

    return product;
  } catch (error) {
    if (error.type) throw error;
    const wrapped = new Error(`Generic extraction failed unexpectedly: ${error.message}`);
    wrapped.type = 'EXTRACTION_FAILED';
    throw wrapped;
  }
}

module.exports = {
  extractGenericProduct,
  detectPageType,
  isMatchingProduct
};
