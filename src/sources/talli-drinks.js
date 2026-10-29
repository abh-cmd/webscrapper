const cheerio = require('cheerio');
const { safeString } = require('../utils/normalize');

// DEV/TEST-ONLY ADAPTER.
// Talli Drinks is not one of the project's approved production sources
// (Wine.com, Total Wine, Vivino, Wine-Searcher). This adapter exists solely
// to validate the crawl/extract/normalize pipeline against a real,
// accessible wine product page. Selectors below were written from the
// actual DOM of one specific page (a Wix storefront) and are not intended
// to generalize to other Talli Drinks products or other Wix stores.

const AVAILABILITY_LABELS = {
  InStock: 'In stock',
  OutOfStock: 'Out of stock',
  PreOrder: 'Preorder',
  LimitedAvailability: 'Limited availability',
  SoldOut: 'Sold out',
  Discontinued: 'Discontinued'
};

function classifyHttpFailure(httpStatus) {
  if (typeof httpStatus !== 'number' || httpStatus < 400) return null;

  if (httpStatus === 404) {
    return { code: 'NOT_FOUND', message: `Talli Drinks returned Not Found (HTTP ${httpStatus}).` };
  }
  if (httpStatus === 429) {
    return { code: 'RATE_LIMITED', message: `Talli Drinks rate-limited this request (HTTP ${httpStatus}).` };
  }
  if (httpStatus === 403 || httpStatus === 401) {
    return { code: 'ACCESS_DENIED', message: `Talli Drinks denied access to this page (HTTP ${httpStatus}).` };
  }
  if (httpStatus >= 500) {
    return { code: 'SOURCE_SERVER_ERROR', message: `Talli Drinks returned a server error (HTTP ${httpStatus}).` };
  }
  return { code: 'HTTP_ERROR', message: `Talli Drinks returned an unexpected HTTP status (${httpStatus}).` };
}

function extractProductJsonLd($) {
  const blocks = $('script[type="application/ld+json"]').toArray()
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

  return blocks.find((item) => item && item['@type'] === 'Product') || null;
}

// The page's "Info Section" accordion is a repeated pair of
// [data-hook="info-section-title"] / [data-hook="info-section-description"]
// elements, matched by DOM order. Each description is a series of
// <p><strong>Label:</strong> value</p> lines.
function parseInfoSections($) {
  const titles = $('[data-hook="info-section-title"]').toArray().map((el) => safeString($(el).text()));
  const descriptionNodes = $('[data-hook="info-section-description"]').toArray();

  return titles.map((title, index) => {
    const descNode = descriptionNodes[index];
    const rawText = descNode ? safeString($(descNode).text()) : null;

    const pairs = descNode
      ? $(descNode).find('p').toArray()
        .map((p) => safeString($(p).text()))
        .filter(Boolean)
        .map((line) => {
          const match = line.match(/^([^:]{1,40}):\s*(.+)$/s);
          return match ? { label: match[1].trim().toLowerCase(), value: match[2].trim() } : null;
        })
        .filter(Boolean)
      : [];

    return { title: title || '', rawText, pairs };
  });
}

function findSection(sections, keyword) {
  return sections.find((section) => section.title.toLowerCase().includes(keyword)) || null;
}

function findPairValue(section, labelKeyword) {
  if (!section) return null;
  const pair = section.pairs.find((p) => p.label.includes(labelKeyword));
  return pair ? pair.value : null;
}

async function extractTalliDrinksTestProduct({ page, context = {} } = {}) {
  if (!page || typeof page.content !== 'function') {
    throw new Error('Talli Drinks test adapter requires a page object with content().');
  }

  const httpStatus = typeof context.httpStatus === 'number' ? context.httpStatus : null;
  const httpFailure = classifyHttpFailure(httpStatus);
  if (httpFailure) {
    const err = new Error(httpFailure.message);
    err.type = httpFailure.code;
    err.httpStatus = httpStatus;
    throw err;
  }

  const html = await page.content();
  const $ = cheerio.load(html);

  const productJsonLd = extractProductJsonLd($);
  const sections = parseInfoSections($);

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
    source_site: 'talli-drinks-test',
    source_url: context.sourceUrl || null,
    scraped_at: new Date().toISOString()
  };

  product.product_name = safeString($('[data-hook="product-title"]').first().text())
    || (productJsonLd && safeString(productJsonLd.name))
    || safeString($('h1').first().text());

  product.product_description = (productJsonLd && safeString(productJsonLd.description))
    || safeString($('[data-hook="description"]').first().text());

  if (productJsonLd && productJsonLd.offers) {
    const offer = Array.isArray(productJsonLd.offers) ? productJsonLd.offers[0] : productJsonLd.offers;
    if (offer && offer.priceCurrency) {
      product.currency = safeString(offer.priceCurrency);
    }
    if (offer && offer.availability) {
      const key = String(offer.availability).split('/').pop();
      product.availability_status = AVAILABILITY_LABELS[key] || safeString(key);
    }
  }

  const priceText = safeString($('[data-hook="product-price"]').first().text());
  if (priceText) {
    const amountMatch = priceText.match(/([\d,]+(?:\.\d{1,2})?)/);
    if (amountMatch) {
      product.price = amountMatch[1].replace(/,/g, '');
    }
  }

  if (productJsonLd && Array.isArray(productJsonLd.image)) {
    product.image_urls = productJsonLd.image
      .map((image) => safeString(typeof image === 'string' ? image : image.contentUrl))
      .filter(Boolean);
  }
  if (product.image_urls.length === 0) {
    const ogImage = safeString($('meta[property="og:image"]').attr('content'));
    if (ogImage) product.image_urls = [ogImage];
  }

  const abvSection = findSection(sections, 'abv');
  if (abvSection && abvSection.rawText) {
    const abvMatch = abvSection.rawText.match(/(\d+(?:\.\d+)?\s*%)/);
    if (abvMatch) product.abv = abvMatch[1].replace(/\s+/g, '');
  }

  const tastingSection = findSection(sections, 'tasting');
  if (tastingSection) {
    product.color = findPairValue(tastingSection, 'appearance');
    product.aroma = findPairValue(tastingSection, 'aroma');
    const palate = findPairValue(tastingSection, 'palate');
    const finish = findPairValue(tastingSection, 'finish');
    if (palate && finish) {
      product.taste = `Palate: ${palate} Finish: ${finish}`;
    } else {
      product.taste = palate || finish || null;
    }
  }

  const foodSection = findSection(sections, 'food pairing');
  if (foodSection && foodSection.rawText) {
    product.food_pairing = foodSection.rawText;
  }

  const regionSection = findSection(sections, 'region');
  if (regionSection) {
    product.region = findPairValue(regionSection, 'region');
    product.varietal = findPairValue(regionSection, 'grape');
    product.producer = findPairValue(regionSection, 'winery');
  }

  product.__meta = { pageType: 'product-page', matchedListing: true };

  return product;
}

module.exports = {
  extractTalliDrinksTestProduct
};
