-- Wine Outlet product persistence schema (Phase 9).
--
-- Mirrors the existing 32-field normalized product schema
-- (src/schema/product-schema.js) exactly. item_number is the Wine Outlet
-- product's own identity and is the primary key / upsert conflict target —
-- the external source_url identifies which source record a given crawl
-- came from, not the Wine Outlet product itself (source URLs are not
-- unique or stable identifiers for a product across re-crawls).
--
-- Run via: npm run db:migrate (reads DATABASE_URL from the environment).
-- Safe to run multiple times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS products (
  item_number          TEXT PRIMARY KEY,
  item_name            TEXT,
  product_name         TEXT,
  brand                TEXT,
  producer             TEXT,
  category             TEXT,
  subcategory          TEXT,
  size                 TEXT,
  vintage              TEXT,
  upc                  TEXT,
  sku                  TEXT,
  price                NUMERIC,
  currency             TEXT,
  availability_status  TEXT,
  product_description  TEXT,
  food_pairing         TEXT,
  color                TEXT,
  aroma                TEXT,
  taste                TEXT,
  seasons              TEXT,
  occasions            TEXT,
  comments             TEXT,
  varietal             TEXT,
  region               TEXT,
  abv                  TEXT,
  winemaker_notes      TEXT,
  product_highlights   TEXT,
  professional_ratings JSONB NOT NULL DEFAULT '[]'::jsonb,
  image_urls           JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_site          TEXT,
  source_url           TEXT,
  scraped_at           TIMESTAMPTZ,

  -- DB-only housekeeping metadata, not part of the 32-field product
  -- schema itself (that remains exactly as defined in product-schema.js).
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- price is stored as NUMERIC (no fixed scale, so exact input digits are
-- preserved) rather than TEXT, per the Phase 9 requirement to use
-- appropriate PostgreSQL types where sensible. vintage stays TEXT because
-- it can legitimately hold "NV" (non-vintage), not just a year.
--
-- professional_ratings / image_urls are JSONB, defaulting to an empty
-- JSON array, matching the existing normalizer's array convention
-- (missing array -> [], never null).

-- ============================================================
-- Queue / retries / resumability / raw snapshots / field history.
-- Additive only — the `products` table above and every Phase 9 behavior
-- against it are unchanged.
-- ============================================================

-- The work queue. One row per (product, source) crawl attempt.
-- canonical_url gives URL-level deduplication; product_hash (computed from
-- UPC/SKU + size — see src/queue/product-hash.js) gives product-identity
-- deduplication across different URLs/sources for the same physical
-- product. Both are UNIQUE, but Postgres treats NULLs as distinct from
-- each other in a UNIQUE constraint, so a null product_hash (identifiers
-- not yet known) never collides with anything.
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id                  BIGSERIAL PRIMARY KEY,
  item_number         TEXT NOT NULL,
  source_name         TEXT NOT NULL,
  source_url          TEXT NOT NULL,
  canonical_url       TEXT NOT NULL,
  product_hash        TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'retrying', 'dead_letter')),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 5,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by           TEXT,
  locked_at           TIMESTAMPTZ,
  last_error_type     TEXT,
  last_error_message  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (canonical_url)
);

CREATE UNIQUE INDEX IF NOT EXISTS crawl_jobs_product_hash_unique
  ON crawl_jobs (product_hash) WHERE product_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS crawl_jobs_claim_idx
  ON crawl_jobs (next_attempt_at) WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS crawl_jobs_stale_processing_idx
  ON crawl_jobs (locked_at) WHERE status = 'processing';

-- Permanently-failed jobs, after exhausting retries or hitting a
-- non-retryable error. Kept separate from crawl_jobs so the queue's
-- "claimable work" indexes stay small and so dead letters have their own
-- durable audit trail even if the originating job row is later purged.
CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id             BIGSERIAL PRIMARY KEY,
  crawl_job_id   BIGINT REFERENCES crawl_jobs(id),
  item_number    TEXT NOT NULL,
  source_name    TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  attempts       INT NOT NULL,
  failed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Raw HTML/JSON captured on every successful fetch, kept alongside (never
-- instead of) the normalized product record, so a page can be
-- reprocessed later without re-fetching it.
CREATE TABLE IF NOT EXISTS raw_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  item_number   TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'text/html',
  raw_content   TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS raw_snapshots_item_fetched_idx
  ON raw_snapshots (item_number, fetched_at DESC);

-- Field-level change history (e.g. price over time). One row per changed
-- field per re-crawl — unchanged fields are not logged. Does not replace
-- or alter the canonical `products` row; it is a pure audit trail derived
-- from diffing the previous and new normalized record.
CREATE TABLE IF NOT EXISTS product_field_history (
  id           BIGSERIAL PRIMARY KEY,
  item_number  TEXT NOT NULL,
  field_name   TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  source_site  TEXT,
  run_id       TEXT,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_field_history_lookup_idx
  ON product_field_history (item_number, field_name, changed_at DESC);

-- ============================================================
-- Block 3: image acquisition, validation, storage, deduplication.
-- Images are fetched on their own queue (image_jobs), entirely separate
-- from crawl_jobs — a slow/failed image can never fail or block a
-- product-page crawl job.
-- ============================================================

-- Content-addressed image storage: the same bytes (by sha256) are stored
-- exactly once, however many products/sources reference them.
CREATE TABLE IF NOT EXISTS images (
  id                      BIGSERIAL PRIMARY KEY,
  content_hash            TEXT NOT NULL UNIQUE,
  perceptual_hash         TEXT,                    -- nullable; PNG only (see src/images/perceptual-hash.js)
  format                  TEXT NOT NULL,
  width                   INT,
  height                  INT,
  byte_size               INT NOT NULL,
  storage_path            TEXT NOT NULL,
  first_seen_source_url   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS images_perceptual_hash_idx
  ON images (perceptual_hash) WHERE perceptual_hash IS NOT NULL;

-- Links one stored image to a specific product/source/role. Many
-- references can point at the same images row (that's the dedup payoff).
CREATE TABLE IF NOT EXISTS image_references (
  id            BIGSERIAL PRIMARY KEY,
  image_id      BIGINT NOT NULL REFERENCES images(id),
  item_number   TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('hero', 'label', 'packaging', 'lifestyle', 'placeholder')),
  is_primary    BOOLEAN NOT NULL DEFAULT false,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_number, source_name, source_url)
);

-- At most one primary image per product, enforced by the database itself,
-- not just application logic.
CREATE UNIQUE INDEX IF NOT EXISTS image_references_one_primary_per_product
  ON image_references (item_number) WHERE is_primary = true;

-- The image work queue — same lifecycle shape as crawl_jobs, kept as a
-- fully independent table.
CREATE TABLE IF NOT EXISTS image_jobs (
  id                  BIGSERIAL PRIMARY KEY,
  item_number         TEXT NOT NULL,
  source_name         TEXT NOT NULL,
  image_url           TEXT NOT NULL,
  referer_url         TEXT,
  role                TEXT NOT NULL DEFAULT 'hero' CHECK (role IN ('hero', 'label', 'packaging', 'lifestyle', 'placeholder')),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'retrying', 'dead_letter')),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 5,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_by           TEXT,
  locked_at           TIMESTAMPTZ,
  etag                TEXT,
  last_modified       TEXT,
  last_error_type     TEXT,
  last_error_message  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_number, image_url)
);

CREATE INDEX IF NOT EXISTS image_jobs_claim_idx
  ON image_jobs (next_attempt_at) WHERE status IN ('pending', 'retrying');

CREATE INDEX IF NOT EXISTS image_jobs_stale_processing_idx
  ON image_jobs (locked_at) WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS image_dead_letter (
  id            BIGSERIAL PRIMARY KEY,
  image_job_id  BIGINT REFERENCES image_jobs(id),
  item_number   TEXT NOT NULL,
  source_name   TEXT NOT NULL,
  image_url     TEXT NOT NULL,
  reason        TEXT NOT NULL,
  attempts      INT NOT NULL,
  failed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Gap-closure pass: staging/review + approval, master data,
-- AI validation exceptions, source compliance metadata.
-- All additive — `products` and every existing table/column are
-- unchanged. Per the requirements document: "All extracted data must be
-- stored in a temporary review table/process and must not be written
-- directly to production product data." Newly scraped records land here
-- first; only an approved staging row is ever promoted into `products`.
-- ============================================================

CREATE TABLE IF NOT EXISTS product_staging (
  id                   BIGSERIAL PRIMARY KEY,
  item_number          TEXT NOT NULL,
  run_id               TEXT,
  source_site          TEXT NOT NULL,
  source_url           TEXT NOT NULL,
  raw_extracted        JSONB NOT NULL,   -- the adapter's raw output, before normalization/paraphrasing — preserved for audit
  normalized           JSONB NOT NULL,   -- the 32-field normalized record, WITH AI-paraphrased description/food_pairing applied
  ai_metadata          JSONB,            -- { provider, model, paraphrasedFields: [...] } — see src/ai
  status               TEXT NOT NULL DEFAULT 'pending_review'
                          CHECK (status IN ('pending_review', 'approved', 'rejected')),
  reviewer             TEXT,
  reviewed_at          TIMESTAMPTZ,
  rejection_reason     TEXT,
  promoted_at          TIMESTAMPTZ,      -- when this row was actually copied into `products`
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_staging_item_status_idx
  ON product_staging (item_number, status);

-- Objective 1 (AI-powered validation of EXISTING product records):
-- exception report rows — recommended corrections with confidence scores,
-- for human review. Separate from product_staging (which gates NEW
-- records); this reviews records already in production.
CREATE TABLE IF NOT EXISTS product_validation_exceptions (
  id               BIGSERIAL PRIMARY KEY,
  item_number      TEXT NOT NULL REFERENCES products(item_number),
  field_name       TEXT NOT NULL,
  current_value    TEXT,
  suggested_value  TEXT,
  confidence       NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  reason           TEXT NOT NULL,
  provider         TEXT NOT NULL,        -- which AI/rule provider generated this finding
  status           TEXT NOT NULL DEFAULT 'pending_review'
                      CHECK (status IN ('pending_review', 'approved', 'rejected')),
  reviewer         TEXT,
  reviewed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS product_validation_exceptions_item_idx
  ON product_validation_exceptions (item_number, status);

-- Master data: Producer, Region, Varietal, Professional Rater. Matching is
-- case-insensitive/normalized (normalized_name is the unique matching
-- key); mapping only ever happens from approved staging rows (enforced in
-- application code, src/master-data), never before approval.
CREATE TABLE IF NOT EXISTS master_producers (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master_regions (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master_varietals (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS master_professional_raters (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  normalized_name  TEXT NOT NULL UNIQUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Additive FK columns on `products` linking to the master tables once an
-- approved product has been mapped. Nullable — most existing rows (and
-- any product not yet approved through staging) simply have no mapping yet.
ALTER TABLE products ADD COLUMN IF NOT EXISTS producer_master_id BIGINT REFERENCES master_producers(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS region_master_id BIGINT REFERENCES master_regions(id);
ALTER TABLE products ADD COLUMN IF NOT EXISTS varietal_master_id BIGINT REFERENCES master_varietals(id);

-- Professional ratings are a JSONB array on `products` (one row can name
-- several raters), so rater mapping needs its own link table rather than
-- a single FK column.
CREATE TABLE IF NOT EXISTS product_rater_links (
  id                BIGSERIAL PRIMARY KEY,
  item_number       TEXT NOT NULL REFERENCES products(item_number),
  rater_name        TEXT NOT NULL,
  rater_master_id   BIGINT NOT NULL REFERENCES master_professional_raters(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_number, rater_name)
);

-- Source compliance metadata (one row per adapter/source): robots.txt
-- policy, override sign-off, ToS review status, API/feed preference, and
-- image redistribution status — all explicitly required by the
-- "Compliance" section of the requirements document.
CREATE TABLE IF NOT EXISTS source_compliance (
  source_name                TEXT PRIMARY KEY,
  robots_txt_honored          BOOLEAN NOT NULL DEFAULT true,
  robots_txt_override         BOOLEAN NOT NULL DEFAULT false,
  robots_txt_override_reason  TEXT,
  robots_txt_override_signed_off_by TEXT,
  robots_txt_override_signed_off_at TIMESTAMPTZ,
  official_api_available      BOOLEAN NOT NULL DEFAULT false,
  official_api_preferred      BOOLEAN NOT NULL DEFAULT false,
  tos_review_status           TEXT NOT NULL DEFAULT 'not_reviewed'
                                 CHECK (tos_review_status IN ('not_reviewed', 'approved', 'rejected')),
  tos_review_notes            TEXT,
  image_redistribution_status TEXT NOT NULL DEFAULT 'internal_use_only'
                                 CHECK (image_redistribution_status IN ('internal_use_only', 'redistributable')),
  image_license_notes         TEXT,
  enabled_in_production        BOOLEAN NOT NULL DEFAULT false,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Final gap-closure phase: per-source, per-day request counters, so a
-- configured MAX_REQUESTS_PER_SOURCE_PER_DAY (src/net/request-budget.js)
-- survives a process restart — an in-memory-only counter would silently
-- reset the budget every time the crawler restarts, defeating the point of
-- a daily cap.
CREATE TABLE IF NOT EXISTS request_budget (
  source_name    TEXT NOT NULL,
  day            DATE NOT NULL,
  request_count  INT NOT NULL DEFAULT 0,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_name, day)
);

-- Run history for the optional in-process scheduler
-- (src/scheduler/scheduler.js). "skipped_overlap" is what a tick records
-- when the previous scheduled run was still in progress — proof that
-- duplicate concurrent scheduled runs are prevented, not just assumed.
CREATE TABLE IF NOT EXISTS scheduled_runs (
  id               BIGSERIAL PRIMARY KEY,
  batch_file       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'skipped_overlap')),
  items_enqueued   INT,
  items_staged     INT,
  items_failed     INT,
  error_message    TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
