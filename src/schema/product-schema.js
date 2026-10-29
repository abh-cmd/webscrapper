const { safeString, normalizeArray } = require('../utils/normalize');

function createEmptyProductRecord() {
  return {
    item_number: null,
    item_name: null,
    product_name: null,
    brand: null,
    producer: null,
    category: null,
    subcategory: null,
    size: null,
    vintage: null,
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
    source_site: null,
    source_url: null,
    scraped_at: null
  };
}

function normalizeProfessionalRatings(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((rating) => {
      if (!rating || typeof rating !== 'object') {
        return {
          rater: null,
          rating: null,
          description: null
        };
      }

      return {
        rater: safeString(rating.rater),
        rating: safeString(rating.rating),
        description: safeString(rating.description)
      };
    })
    .filter((rating) => {
      const hasContent = rating.rater !== null || rating.rating !== null || rating.description !== null;
      return hasContent || (rating && Object.keys(rating).length > 0);
    });
}

function normalizeProductRecord(input = {}) {
  const record = createEmptyProductRecord();

  record.item_number = safeString(input.item_number);
  record.item_name = safeString(input.item_name);
  record.product_name = safeString(input.product_name) || record.item_name;
  record.brand = safeString(input.brand);
  record.producer = safeString(input.producer);
  record.category = safeString(input.category);
  record.subcategory = safeString(input.subcategory);
  record.size = safeString(input.size);
  record.vintage = safeString(input.vintage);
  record.upc = safeString(input.upc);
  record.sku = safeString(input.sku);
  record.price = safeString(input.price);
  record.currency = safeString(input.currency);
  record.availability_status = safeString(input.availability_status);
  record.product_description = safeString(input.product_description);
  record.food_pairing = safeString(input.food_pairing);
  record.color = safeString(input.color);
  record.aroma = safeString(input.aroma);
  record.taste = safeString(input.taste);
  record.seasons = safeString(input.seasons);
  record.occasions = safeString(input.occasions);
  record.comments = safeString(input.comments);
  record.varietal = safeString(input.varietal);
  record.region = safeString(input.region);
  record.abv = safeString(input.abv);
  record.winemaker_notes = safeString(input.winemaker_notes);
  record.product_highlights = safeString(input.product_highlights);
  record.professional_ratings = normalizeProfessionalRatings(input.professional_ratings || []);

  const imageUrls = normalizeArray(input.image_urls || []);
  record.image_urls = Array.isArray(imageUrls) ? imageUrls.filter((value) => safeString(value)) : [];

  record.source_site = safeString(input.source_site);
  record.source_url = safeString(input.source_url);
  record.scraped_at = safeString(input.scraped_at) || null;

  return record;
}

function summarizeExtraction(record = {}) {
  const fieldNames = Object.keys(createEmptyProductRecord());
  let populatedFields = 0;
  const populatedFieldNames = [];
  const nullFieldNames = [];

  for (const field of fieldNames) {
    const value = record[field];
    const isPopulated = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;

    if (isPopulated) {
      populatedFields += 1;
      populatedFieldNames.push(field);
    } else {
      nullFieldNames.push(field);
    }
  }

  return {
    totalFields: fieldNames.length,
    populatedFields,
    nullFields: fieldNames.length - populatedFields,
    imagesFound: Array.isArray(record.image_urls) ? record.image_urls.length : 0,
    populatedFieldNames,
    nullFieldNames
  };
}

module.exports = {
  createEmptyProductRecord,
  normalizeProfessionalRatings,
  normalizeProductRecord,
  summarizeExtraction
};
