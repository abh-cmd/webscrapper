const cheerio = require('cheerio');
const { safeString } = require('../utils/normalize');

async function extractExampleSourceProduct({ page, context = {} } = {}) {
  if (!page || typeof page.content !== 'function') {
    throw new Error('Example source adapter requires a Playwright page object.');
  }

  const html = await page.content();
  const $ = cheerio.load(html);

  const product = {
    item_number: context.item_number || null,
    item_name: safeString($('[data-test="product-name"]').first().text()) || safeString($('h1').first().text()) || null,
    product_name: safeString($('[data-test="product-name"]').first().text()) || safeString($('h1').first().text()) || null,
    brand: safeString($('[data-test="brand"]').first().text()) || safeString($('.brand').first().text()) || null,
    producer: null,
    category: safeString($('[data-test="category"]').first().text()) || safeString($('.category').first().text()) || null,
    subcategory: safeString($('[data-test="subcategory"]').first().text()) || safeString($('.subcategory').first().text()) || null,
    size: safeString(context.size) || safeString($('[data-test="size"]').first().text()) || null,
    vintage: safeString(context.vintage) || safeString($('[data-test="vintage"]').first().text()) || null,
    upc: safeString($('[data-test="upc"]').first().text()) || null,
    sku: safeString($('[data-test="sku"]').first().text()) || null,
    price: safeString($('[data-test="price"]').first().text()) || safeString($('.price').first().text()) || null,
    currency: safeString($('[data-test="currency"]').first().text()) || 'USD',
    availability_status: safeString($('[data-test="availability"]').first().text()) || 'unknown',
    product_description: safeString($('[data-test="description"]').first().text()) || safeString($('.description').first().text()) || null,
    food_pairing: safeString($('[data-test="food-pairing"]').first().text()) || null,
    color: safeString($('[data-test="color"]').first().text()) || null,
    aroma: safeString($('[data-test="aroma"]').first().text()) || null,
    taste: safeString($('[data-test="taste"]').first().text()) || null,
    seasons: safeString($('[data-test="seasons"]').first().text()) || null,
    occasions: safeString($('[data-test="occasions"]').first().text()) || null,
    comments: safeString($('[data-test="comments"]').first().text()) || null,
    varietal: safeString($('[data-test="varietal"]').first().text()) || null,
    region: safeString($('[data-test="region"]').first().text()) || null,
    abv: safeString($('[data-test="abv"]').first().text()) || null,
    winemaker_notes: safeString($('[data-test="winemaker-notes"]').first().text()) || null,
    product_highlights: safeString($('[data-test="highlights"]').first().text()) || null,
    professional_ratings: [],
    image_urls: [],
    source_site: context.sourceName || 'example-source',
    source_url: context.sourceUrl || null,
    scraped_at: new Date().toISOString()
  };

  const structuredData = [];
  $('script[type="application/ld+json"]').each((index, node) => {
    const raw = $(node).html() || '';
    if (!raw.trim()) return;

    try {
      const parsed = JSON.parse(raw);
      structuredData.push(parsed);
    } catch (error) {
      // Ignore malformed JSON-LD; no fabricated data.
    }
  });

  for (const chunk of structuredData) {
    if (chunk && chunk.name && !product.item_name) {
      product.item_name = safeString(chunk.name);
      product.product_name = safeString(chunk.name);
    }

    if (chunk && chunk.brand && !product.brand) {
      product.brand = safeString(chunk.brand.name || chunk.brand);
    }

    if (chunk && chunk.category && !product.category) {
      product.category = safeString(chunk.category);
    }

    if (chunk && chunk.offers && chunk.offers.price) {
      product.price = safeString(String(chunk.offers.price));
      if (!product.currency && chunk.offers.priceCurrency) {
        product.currency = safeString(chunk.offers.priceCurrency);
      }
    }

    if (chunk && chunk.image && Array.isArray(chunk.image)) {
      product.image_urls = chunk.image
        .map((image) => safeString(typeof image === 'string' ? image : image.url))
        .filter(Boolean);
    }
  }

  const imageUrls = Array.from(new Set((product.image_urls || []).map((url) => safeString(url)).filter(Boolean)));
  product.image_urls = imageUrls;

  return product;
}

module.exports = {
  extractExampleSourceProduct
};
