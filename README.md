# Wine Outlet Product Crawler (Phase 1–9 + Blocks 1–3 + final gap-closure phase)

## What the Wine Outlet crawler is

This project is the Phase 1 foundation for an automated product-data acquisition system for Wine Outlet. It is designed to accept a product input and a supplier product URL, fetch the page, extract the available product data, normalize it into a stable schema, and save the result locally as JSON.

## Why this crawler exists

Wine Outlet currently relies on manual onboarding of product data. This crawler is a first step toward automating that workflow by separating source-specific scraping logic from a reusable crawler core. It is intentionally scoped to a simple, testable product extraction flow before later phases add databases, async workers, AI validation, queueing, and other operational tooling.

## Crawler blueprint

The crawler is intentionally layered so each stage can fail, retry, or evolve independently:

1. Discover and dedupe a URL before any network work starts.
2. Choose a fetch mode: plain HTTP when enough, browser-rendered when the page depends on JS, consent, or interaction.
3. Enforce robots.txt, rate limits, and backoff before every live request.
4. Reuse a session/cookie manager so consent, age gates, and login walls can be handled once per site.
5. Run a browser action hook for normal UI steps such as cookie consent, age verification, lazy loading, or infinite scroll.
6. Detect the page type and route it to the right parser/extractor.
7. Normalize the extracted data into the stable product schema.
8. Persist normalized output and reports separately from raw fetch artifacts.

The design rule is simple: fetching, rendering, parsing, normalization, and storage must stay separate. A site change should break one layer, not the whole crawler.

The concrete implementation already follows that pattern across [src/queue](src/queue), [src/net](src/net), [src/compliance](src/compliance), [src/crawler](src/crawler), [src/sources](src/sources), [src/validation](src/validation), [src/staging](src/staging), [src/images](src/images), [src/db](src/db), and [src/pipeline](src/pipeline).

## Phase 1 scope

Phase 1 includes only:

- Node.js project setup
- Crawlee-based crawl orchestration
- Playwright fallback for JavaScript-dependent pages
- source adapter architecture
- input validation
- extraction for a single product record
- field normalization
- structured crawl report generation
- local JSON output files
- basic unit tests for normalization

## Phase 2 scope: real Wine-Searcher validation

Phase 1 was validated only against a controlled local fixture
(`http://127.0.0.1:3000/input/fixtures/example-source-product.html`). Phase 2
takes the same crawler core and validates it against one real external
source: **Wine-Searcher**.

Phase 2 added:

- A rewritten `wine-searcher` source adapter (`src/sources/wine-searcher.js`)
  that fixed a bug where the page HTML was never awaited (`page.content()`
  was called without `await`), which had silently made every Wine-Searcher
  selector operate on an empty document.
- Explicit page-type detection (`product-page` / `search-results` / `unknown`),
  since the supplied URL is a `/find/` search page, not a product-detail page.
- Single-listing matching on search-results pages: if exactly one listing's
  link text matches every word of the requested item name, only that
  listing's own DOM subtree is used for extraction. Zero or multiple matches
  leave the wine-attribute fields `null` rather than guessing.
- Structured HTTP/anti-bot failure classification (`ACCESS_DENIED`,
  `RATE_LIMITED`, `AUTH_REQUIRED`, `NOT_FOUND`, `SOURCE_SERVER_ERROR`) so a
  blocked request is reported as a failure, never silently converted into an
  empty "success".
- An `HTTP status:` / `Page type:` line and a per-field extraction checklist
  in the terminal output, plus an extraction summary (total/populated/null
  schema fields, images found) — see `src/utils/logging.js`.
- `output/reports/<run-id>.json` now also carries `http_status`, `page_type`,
  `matched_listing`, and `extraction_summary` (additive fields; the Phase 1
  report shape is unchanged).
- Offline Phase 2 tests (`tests/wine-searcher-adapter.test.js`) that run
  against saved HTML fixtures in `tests/fixtures/`, including a real captured
  Wine-Searcher anti-bot challenge page. These do not depend on the live site
  and must keep passing whether or not Wine-Searcher is reachable.

### Phase 2 result against the supplied URL

Source URL:
`https://www.wine-searcher.com/find/penfolds+superblend+802+b+australia/1/india`

- HTTP status: **403**
- The page is a PerimeterX CAPTCHA / "Access to this page has been denied"
  challenge — confirmed identically via a plain static HTTP fetch and via a
  full Playwright-rendered page load, so this is not a JavaScript-rendering
  problem; the site is actively blocking automated requests before any real
  content (product or search-results) is served.
- No JSON-LD or OpenGraph product data is present on the challenge page.
- Penfolds Superblend 802 B could not be identified because no real page
  content was ever reached.
- Result: the crawler reports a structured `ACCESS_DENIED` failure
  (`output/reports/<run-id>.json`) and does **not** write a result file. It
  does not attempt to solve the CAPTCHA, rotate IPs/proxies, spoof headers,
  or otherwise bypass the block — that is out of scope for this project.

This is expected, correctly-handled behavior for Phase 2, not a bug: the
requirement was to prove the crawler can tell "the source blocked us" apart
from "our extraction logic is broken," and the adapter's own offline tests
(`tests/wine-searcher-adapter.test.js`) prove the extraction logic itself is
correct against fixture HTML that resembles a real product page and a real
search-results page.

### Known limitations

- The Wine-Searcher product-page and search-results selectors in
  `src/sources/wine-searcher.js` are best-effort, written from typical
  Wine-Searcher markup conventions (`h1`, `.price`, `.region`, JSON-LD
  `Product`, etc.). They have **not** been verified against a real,
  unblocked Wine-Searcher page, because every automated request to the
  supplied URL was denied. They should be re-checked the next time
  Wine-Searcher is actually reachable from this environment.
- Not every Wine-Searcher page layout is supported — only the general
  product-page / search-results shapes described above.

### Phase 2, Test B: accessible real wine product (Talli Drinks, dev/test only)

Wine-Searcher's block meant Phase 2 still needed one clean proof that the
pipeline can extract a real, unblocked page end to end. **Talli Drinks is not
an approved production source** (see Phase 3 below) — it exists solely as a
development/integration test target and is registered separately from the
production source list (`src/sources/talli-drinks.js`, source name
`talli-drinks-test`).

Test URL: `https://www.tallidrinks.com/product-page/fratelli-cabernet-sauvignon-1`
(Fratelli Cabernet Sauvignon).

- HTTP status: 200. The page is a Wix storefront that is fully server-rendered
  — a plain static fetch already contains a schema.org `Product` JSON-LD
  block, OpenGraph tags, and a repeated "info section" accordion
  (`<p><strong>Label:</strong> value</p>` lines) covering ABV, tasting notes,
  food pairing, and region/grape/winery. Confirmed with a real Playwright
  render that JS execution adds nothing extractable (breadcrumbs stay empty,
  gallery image count unchanged), so Playwright is used only as the fetch
  engine (per existing architecture), not because JS rendering is required.
- Result: 20 of 32 schema fields populated, 1 image, nothing fabricated —
  every populated field traces to real, visible page text. See
  `output/results/WO-10001.json` / `output/reports/run_20260827T091031Z.json`
  for the actual run.

## Phase 3 scope: multi-source adapter architecture

Phase 3 does **not** add new scraping coverage. Its job is to prove that the
same crawler core can pick the right source-specific adapter for a URL and
still produce the same normalized 32-field schema, across all four of the
project's approved production source families.

### Production source list

The project's approved production sources are:

| Source        | Internal name   | Hostname(s)      | Status |
|---------------|------------------|-------------------|--------|
| Wine.com      | `wine-com`       | `wine.com`        | Implemented (Phase 4) — currently `ACCESS_DENIED` on the one tested URL, see below |
| Total Wine    | `total-wine`     | `totalwine.com`   | Implemented (Phase 5) — currently `ACCESS_DENIED` on the one tested URL, see below |
| Vivino        | `vivino`         | `vivino.com`      | Implemented (Phase 6) — **untested live**: vivino.com's robots.txt disallows ClaudeBot entirely, see below |
| Wine-Searcher | `wine-searcher`  | `wine-searcher.com` | Implemented (Phase 2) — currently `ACCESS_DENIED` on the one tested URL, see above |

All four production adapters are now implemented. **None of them are
demonstrated as production-ready against a live page** — see "Phase 4",
"Phase 5", and "Phase 6" below. Wine.com and Total Wine are implemented and
tested against realistic fixtures, but every real request made to either
site during development was blocked, so real extraction has not actually
been demonstrated end to end. Vivino goes a step further: it was never even
requested live at all, for reasons explained below — its fixture-based
extraction logic has been verified, but literally nothing about its real
page structure has been confirmed.

Talli Drinks (Phase 2 Test B) remains a development/test-only integration
target, kept deliberately outside this production list — see below.

### Source registry (`src/sources/source-registry.js`)

The registry answers one question: **which adapter should handle this
request?** It is not a scraper itself. Two entry points:

- `resolveSource({ name, url })` — the crawler's entry point. Resolution
  order: (1) an explicit `name` (the Phase 1/2 contract, unchanged — exact
  lookup, throws a clearly typed `UNSUPPORTED_SOURCE` error for an unknown
  name); (2) if no name is given, a `url` is matched by **hostname** (not
  substring/text matching) against the four production sources; (3) if
  neither is given, falls back to the local fixture (`example-source`) —
  the pre-Phase-3 default for callers that pass no source information.
- `getAdapterForUrl(url)` / `detectSourceNameByUrl(url)` — pure hostname
  routing against only the four approved production sources.
  `www.`/non-`www` variants are both handled. An unrecognized hostname is
  rejected with `UNSUPPORTED_SOURCE` — it is never silently treated as
  another source (this is deliberately tested — see
  `tests/source-registry.test.js`).

`crawler.js` now calls `resolveSource` once, up front, before any browser
navigation — an unsupported source is rejected immediately (with a
structured failure report written) rather than surfacing later as a
confusing extraction error.

### Adapter contract

Every source adapter — production or test/fixture — exposes:

- `extract({ page, context })` — the only thing that varies per source.
  Given a loaded Playwright page and context (item number, size, vintage,
  source URL, HTTP status), it returns a plain object of whatever fields it
  could actually find on the page. Missing scalars are `null`, missing
  arrays are `[]`. Nothing is invented.

The four production adapters additionally expose:

- `name` — the canonical registry key (`wine-com`, `total-wine`, `vivino`,
  `wine-searcher`).
- `hostnames` — the domain(s) this adapter owns.
- `canHandle(url)` — hostname-based self-identification, built on the
  shared `src/sources/hostname-utils.js` helper.

The generic crawler (`src/crawler/crawler.js`, `src/crawler/request-handler.js`)
contains **no** source-specific logic — no `if (domain === 'wine.com')`
branches. It only ever calls `resolveSource(...).extract(...)` and
normalizes whatever comes back through the one shared
`normalizeProductRecord` function. Wine.com, Total Wine, and Vivino each
started from the shared stub factory (`src/sources/stub-adapter.js`) and
have since moved to real implementations, in Phase 4, Phase 5, and Phase 6
respectively; Wine-Searcher was hand-implemented directly in Phase 2. None
of the four is a stub anymore as of Phase 6 (see below for what
"implemented" does and doesn't mean for each).

### What Phase 3 deliberately does not do

- Did not scrape any of the four sources itself — that happened in Phase 2
  (Wine-Searcher), Phase 4 (Wine.com), Phase 5 (Total Wine), and Phase 6
  (Vivino), each covered separately below.
- Does not change Wine-Searcher's extraction logic or its `ACCESS_DENIED`
  result — that behavior is preserved exactly as Phase 2 left it.
- Does not add Talli Drinks to the production source list or make it
  hostname-detectable — it stays reachable only via an explicit
  `source.name: "talli-drinks-test"`, and `tests/source-registry.test.js`
  asserts this directly.
- Does not add a database, Redis, a job queue, AI/LLM/embeddings, image
  processing, or any anti-bot bypass mechanism.

### Adding a real production adapter later

When a source's real page structure has actually been inspected:

1. Replace that source's stub in `src/sources/<source>.js` with real
   extraction logic (keep the file's exported `name`/`hostnames`/`canHandle`
   shape; only `extract` changes).
2. Update its entry in `PRODUCTION_SOURCES` in `source-registry.js` if the
   export shape changed.
3. Add offline fixture tests (saved HTML, like
   `tests/wine-searcher-adapter.test.js`) — never make the test suite depend
   on the live site.

## Phase 4 scope: Wine.com adapter implementation

Phase 4 replaced the Phase 3 Wine.com stub (`src/sources/wine-com.js`) with
a real implementation, and validated it as thoroughly as an access-blocked
source can be validated.

### Access investigation

Before writing any extraction logic, the actual site was inspected — not
guessed:

- A static fetch of a Wine.com search page returned **HTTP 403** with a
  `x-datadome: protected` header and a DataDome CAPTCHA challenge page
  (`ct.captcha-delivery.com`), not any real content.
- Wine.com's own public `robots.txt` / `sitemap.xml` (served statically from
  S3/CloudFront, not behind DataDome) were used to find one real, current
  product URL without guessing: `https://www.wine.com/product/gruet-sauvage-rose/205944`.
- A single controlled request to that real product URL returned the
  **identical** DataDome 403 challenge — confirming the block is enforced at
  the edge (CloudFront/DataDome) for every application route, not specific
  to search vs. product pages.
- Per instructions, live testing stopped there. No further requests, no
  CAPTCHA solving, no proxy/IP rotation, no header spoofing to evade
  detection.

The real captured DataDome challenge page is saved as
`tests/fixtures/wine-com-blocked.html` and used in an offline test asserting
it is classified as `ACCESS_DENIED`, never treated as extractable content.

### Why the adapter uses generic structured-data parsing, not guessed selectors

Because Wine.com's real DOM was never observed, `src/sources/wine-com.js`
does not contain any Wine.com-specific CSS selectors. It extracts only from
standards-based signals — schema.org JSON-LD `Product` data (including the
generic `additionalProperty` / `PropertyValue` mechanism for attributes like
size, vintage, varietal, region, ABV, tasting notes, and food pairing) and
OpenGraph metadata as a fallback for title/image/description. This is
explicitly the primary extraction source called for in the Phase 4
requirements, not a workaround invented in place of real selectors.
`professional_ratings` is always returned as `[]` from this adapter: generic
schema.org `review` blocks are typically customer reviews, and there is no
reliable generic way to distinguish a professional critic score (e.g. Wine
Spectator) from a customer review without having seen Wine.com's actual
markup — so nothing is extracted there rather than mislabeling data.

The adapter also does real page-type detection (`PRODUCT_PAGE` /
`LISTING_PAGE` / `UNKNOWN_PAGE`, based on JSON-LD `@type`) and product
matching (every word of the requested item name must appear in the page's
product name), and distinguishes `ACCESS_DENIED`, `RATE_LIMITED`,
`PRODUCT_NOT_FOUND` (true 404, a listing page in place of a product page, or
a product-page match failure), `PAGE_TYPE_UNKNOWN`, and `EXTRACTION_FAILED`
as separate, clearly typed error codes — never lumping everything into one
generic failure type.

### Testing

- `tests/wine-com-adapter.test.js` (33 tests) runs entirely offline against
  synthetic fixtures modeled on genuine schema.org conventions
  (`tests/fixtures/wine-com-product.html`, `wine-com-product-minimal.html`,
  `wine-com-listing.html`, `wine-com-unknown.html`) plus the one real
  captured block page — covering every schema field, page-type detection,
  product matching, missing-data handling, and all five error
  classifications. None of these depend on wine.com being reachable.
- One single, controlled **live** integration run was performed against the
  real product URL above, through the full crawler pipeline (registry →
  adapter → normalization → report). Result:

  ```
  Status: FAILED
  Error type: ACCESS_DENIED
  HTTP status: 403
  ```

  See `output/reports/run_20260827T112025Z.json`. No result JSON was written
  for this run — a blocked request correctly produces no product record.

### What Phase 4 does **not** claim

Wine.com is **not** demonstrated as production-ready. What has been
validated: the adapter correctly detects and classifies the current
access block; its extraction logic is correct against realistic fixture
data; and the full pipeline (registry → adapter → normalization → report)
works end to end for both the success and failure paths. What has **not**
been validated: extraction against a real, unblocked Wine.com page, since
one has never been reached. This should be re-verified the next time
wine.com is actually reachable from this environment — see "Known
limitations" in the Phase 2 section above for the same caveat already
applied to Wine-Searcher.

## Phase 5 scope: Total Wine adapter implementation

Phase 5 replaced the Phase 3 Total Wine stub (`src/sources/total-wine.js`)
with a real implementation, following the exact same approach as Phase 4's
Wine.com adapter — because it hit the exact same kind of wall.

### Access investigation

- Total Wine's `robots.txt` and `sitemap.xml` (both served statically, not
  behind any bot protection) were used to find a real, current product URL
  without guessing: `https://www.totalwine.com/wine/white-wine/white-blend/torres-vina-esmeralda/p/13784750`.
- A single controlled request to that URL returned **HTTP 403** with a
  PerimeterX CAPTCHA challenge page (`px-captcha`, "Access to this page has
  been denied", `challenge.js` from `/global-static-resources/px/...`) — the
  same anti-bot vendor Wine-Searcher uses, under a different PerimeterX app
  ID (`PXFF0j69T5` vs. Wine-Searcher's `PXK6S8okp3`), not the DataDome
  system Wine.com uses.
- Per instructions, live testing stopped there — no further requests, no
  CAPTCHA solving, no proxy/IP rotation, no evasion.

The real captured PerimeterX challenge page is saved as
`tests/fixtures/total-wine-blocked.html` and used in an offline test
asserting it is classified as `ACCESS_DENIED`.

### Why the adapter uses generic structured-data parsing, not guessed selectors

Same reasoning as Wine.com (Phase 4): Total Wine's real DOM was never
observed, so `src/sources/total-wine.js` contains no Total Wine-specific CSS
selectors — only schema.org JSON-LD `Product` parsing (including
`additionalProperty`/`PropertyValue` for size, vintage, varietal, region,
ABV, tasting notes, and food pairing) and OpenGraph fallbacks. Page-type
detection (`PRODUCT_PAGE`/`LISTING_PAGE`/`UNKNOWN_PAGE`) is based purely on
JSON-LD `@type`, not on guessed URL path conventions — even though Total
Wine's own sitemap does reveal a real listing-page URL shape
(`/wine/argentina/c/000279?...&varietaltype=...`), that pattern was not
hard-coded as a detection signal, to stay consistent with the same
standards-only approach used everywhere else. `professional_ratings` is
always `[]` here too, for the same reason as Wine.com: no generic, reliable
way to distinguish a professional critic score from a customer review.

### Testing

- `tests/total-wine-adapter.test.js` (39 tests) runs entirely offline
  against synthetic fixtures modeled on genuine schema.org conventions
  (`tests/fixtures/total-wine-product.html`,
  `total-wine-product-minimal.html`, `total-wine-listing.html`,
  `total-wine-unknown.html`) plus the real captured block page — covering
  every schema field, page-type detection, product matching, missing-data
  handling, all five error classifications, and an explicit check that the
  adapter's output survives `normalizeProductRecord` unchanged (same
  32-field schema, no competing schema introduced).
- One single, controlled **live** integration run was performed against the
  real product URL above, through the full crawler pipeline. Result:

  ```
  Status: FAILED
  Error type: ACCESS_DENIED
  HTTP status: 403
  ```

  See `output/reports/run_20260827T115337Z.json`. No result JSON was written
  — a blocked request correctly produces no product record.

### What Phase 5 does **not** claim

Total Wine is **not** demonstrated as production-ready, for the same reason
as Wine.com: the adapter's access-detection and fixture-based extraction
logic are both verified, and the full pipeline works end to end for both
outcomes, but extraction against a real, unblocked Total Wine page has never
been demonstrated, since one has never been reached. Re-verify when
totalwine.com is actually reachable from this environment.

## Phase 6 scope: Vivino adapter implementation

Phase 6 replaced the Phase 3 Vivino stub (`src/sources/vivino.js`) with a
real implementation — but the access situation here is meaningfully
different from Wine.com and Total Wine, and is documented as such rather
than glossed over.

### robots.txt: vivino.com explicitly disallows ClaudeBot

Before any request beyond `robots.txt` itself, vivino.com's own robots.txt
was checked, per standard practice. It contains:

```
User-agent: ClaudeBot
Disallow: /
```

This is a directive naming Claude-based crawlers specifically, separate
from vivino.com's generic bot rules (which do allow general crawling of
most paths). **This was honored: no further request of any kind — not even
a `sitemap.xml` fetch — was made to vivino.com during development.** No
user-agent spoofing or other workaround was used to get around it; doing so
would be exactly the kind of anti-bot evasion this project (and this specific
instruction) explicitly rules out, and disregarding a site's own stated
crawling policy for its own name would defeat the purpose of checking
robots.txt at all.

For contrast/completeness, Wine.com's and Total Wine's robots.txt were
re-checked specifically for the same kind of rule: Wine.com explicitly
*allows* `ClaudeBot` (same restrictions as everyone else), and Total Wine
has no bot-specific section at all. So Phase 4 and Phase 5's live requests
were compliant, and Vivino is a genuine exception, not a pattern that was
missed earlier.

### Consequence: no live signal at all, unlike Wine.com/Total Wine

Wine.com and Total Wine's adapters were each validated against one real,
captured anti-bot challenge page (`tests/fixtures/wine-com-blocked.html`,
`tests/fixtures/total-wine-blocked.html`). Vivino has no equivalent —
`tests/fixtures/vivino-blocked-synthetic.html` is explicitly synthetic
(its file header says so), built only to exercise the adapter's generic
HTTP-403/access-denied-wording classification logic deterministically. The
same is true of every other Vivino fixture: none are modeled on anything
actually observed from vivino.com, unlike Wine.com/Total Wine's fixtures
(which at least used real product identities and URLs pulled from those
sites' own sitemaps). The wine used in the Vivino fixtures/test input
(Catena Malbec 2021, `https://www.vivino.com/wines/1013683`) is a
plausible, representative example of Vivino's known public URL shape
(`/wines/<id>`) — it was **not** verified to currently exist or resolve to
that specific product, because verifying it would have required exactly the
kind of request robots.txt disallows.

### Why the adapter still uses generic structured-data parsing

Same reasoning as Wine.com and Total Wine, for the same reason (no real DOM
observed) plus this one going further (no real HTTP response of any kind
observed): `src/sources/vivino.js` contains no vivino.com-specific
selectors, only schema.org JSON-LD `Product` parsing and OpenGraph
fallbacks.

### Community ratings vs. professional ratings

Vivino's defining feature is community/user ratings, not professional
critic scores. `professional_ratings` is always `[]` from this adapter —
and this is specifically tested: a fixture with an explicit
schema.org `aggregateRating` and `review` block (representative of exactly
the kind of community rating data a real Vivino page would have) is used to
prove the adapter does not map that data into `professional_ratings`
(`tests/fixtures/vivino-product-with-community-rating.html`).

### Testing

- `tests/vivino-adapter.test.js` (38 tests) runs entirely offline against
  synthetic fixtures — covering every schema field, page-type detection,
  product matching, missing-data handling, all five error classifications,
  the community-vs-professional-rating distinction, and schema
  compatibility via `normalizeProductRecord`.
- **No live integration test was performed**, unlike every other source in
  this project. This is a deliberate deviation from the otherwise-consistent
  "one controlled live request" pattern used in Phases 2, 4, and 5 — made
  because the site itself asked Claude-based crawlers not to make any
  request at all, and that instruction takes precedence over completing a
  validation checklist item.

### What Phase 6 does **not** claim

Vivino is **not** demonstrated as production-ready, and unlike Wine.com and
Total Wine, this phase does not even claim to have confirmed *how* Vivino
currently responds to automated requests (no HTTP status, no page content,
nothing was observed). What has been validated: the adapter's extraction
logic, page-type detection, product matching, and error classification are
all correct against realistic synthetic fixtures, and the registry/pipeline
integration is identical to the other three sources. If vivino.com's
robots.txt is ever updated to permit Claude-based crawlers, this adapter
should be re-verified against a real page before being relied upon.

## Phase 7: Wine-Searcher adapter brought to the common convention

Phase 7 didn't add a new source — it brought `src/sources/wine-searcher.js`
(built in Phase 2, before the `PRODUCT_PAGE`/`LISTING_PAGE`/`UNKNOWN_PAGE`
and `ACCESS_DENIED`/`PRODUCT_NOT_FOUND`/`PAGE_TYPE_UNKNOWN`/`EXTRACTION_FAILED`
conventions existed) in line with Wine.com/Total Wine/Vivino:

- Page-type strings are now uppercase (`PRODUCT_PAGE`/`LISTING_PAGE`/`UNKNOWN_PAGE`),
  matching the other three adapters.
- An `UNKNOWN_PAGE` result now throws `PAGE_TYPE_UNKNOWN` instead of silently
  returning a "successful" record with nearly every field `null`.
- A `LISTING_PAGE` (a `/find/` search page) with no confident single-listing
  match now throws `PRODUCT_NOT_FOUND` instead of the same silent
  near-empty "success". Wine-Searcher's unique capability — extracting from
  a single confidently-matched listing within a search-results page — is
  unchanged and still fully tested; only the "nothing confidently matched"
  outcome changed from a fake success to an honest failure.
- Extraction is now wrapped so an unexpected internal error becomes
  `EXTRACTION_FAILED` rather than an untyped error.

No live re-request was made — Wine-Searcher's `ACCESS_DENIED` result
(HTTP 403, PerimeterX) was already established in Phase 2 and re-confirmed
passing against the same real captured block-page fixture after these
changes.

## Phase 8: multi-source selection (`src/selection/source-selector.js`)

A pure, deterministic decision layer that runs *after* adapters have already
produced normalized results — not a scraper, not an adapter, no network
calls, no AI/fuzzy matching. Given normalized results from one or more
sources for the same Wine Outlet product, `selectBestSource(entries)`:

1. Discards failed/blocked sources (`ACCESS_DENIED`, `PRODUCT_NOT_FOUND`,
   etc.) — a blocked source never prevents using another one.
2. Ranks the remaining successful sources by completeness (most populated
   fields wins), tie-broken by a documented priority order. **No explicit
   source-priority policy exists anywhere in this project's own
   documentation**, so the tie-break uses the order the four sources are
   consistently listed in across every phase's requirements — Wine.com,
   Total Wine, Vivino, Wine-Searcher — rather than an invented business
   rule. This is a deliberate default, not a discovered requirement; see
   `DEFAULT_SOURCE_PRIORITY` in the module, which callers can override.
3. Takes the top-ranked source as primary, then fills any field left `null`
   there from the next-ranked source that has it — never guessing, never
   averaging conflicting values. When two sources both have a different
   explicit value for the same field, the higher-ranked one wins and the
   conflict is recorded (not silently dropped).
4. Returns full provenance: which source is primary, the full ranking, and
   a `field -> source` map for every populated field, kept entirely
   separate from the 32-field product object itself (which is untouched —
   `source_site`/`source_url`/`scraped_at`/`item_number`/`item_name` always
   reflect the primary source only, never backfilled, since mixing those
   would misattribute where the record came from).
5. Returns `NO_USABLE_SOURCE` (not an exception) when every source failed.

16 tests in `tests/source-selector.test.js`, entirely offline.

## Phase 9: PostgreSQL persistence

- `db/schema.sql` — one `products` table mirroring the 32-field schema
  exactly (`item_number` as primary key — a source URL identifies a source
  record, not the Wine Outlet product itself), plus `created_at`/`updated_at`
  housekeeping columns kept separate from the logical product schema.
  `price` is `NUMERIC` (vintage stays `TEXT`, since "NV" is valid — not
  every vintage is a year). `image_urls`/`professional_ratings` are `JSONB`,
  defaulting to `'[]'`. Apply it with `npm run db:migrate` (idempotent —
  `CREATE TABLE IF NOT EXISTS`).
- `src/db/connection.js` — a single lazily-created `pg.Pool`, reading
  `DATABASE_URL` from the environment (see `.env.example`). No other file
  opens its own connection.
- `src/db/product-repository.js` — the only place SQL lives.
  `upsertProduct()` does `INSERT ... ON CONFLICT (item_number) DO UPDATE`,
  so re-crawling the same product updates the existing row instead of
  duplicating it. `toRow`/`fromRow` are pure mapping functions, independently
  tested offline in `tests/product-repository-mapping.test.js` (12 tests —
  null handling, array handling, a full round-trip).
- `src/db/migrate.js` — applies `db/schema.sql`; also the thing a fresh
  developer runs instead of clicking through pgAdmin.

**Update (post-Phase-9):** a real Docker PostgreSQL instance
(`wineoutlet-postgres`, database `wineoutlet`) was later provided and is
what every integration test in this project — Phase 9 through the final
gap-closure phase — now actually runs against, with `DATABASE_URL` set in
`.env`. `tests/product-repository.integration.test.js` and every other
`*.integration.test.js` file are gated on `isDatabaseConfigured()` and skip
cleanly (not fail) when `DATABASE_URL` is unset, so `npm test` still exits 0
in an environment with no database — but in this project's actual
development environment they run for real, against real Postgres.

Nothing in `crawler.js`/`request-handler.js` was changed for this — the
generic crawler remains completely unaware that persistence exists.

## Block 1: proxy pool, rate limiting, and request realism

- `src/net/proxy-config.js` — loads a proxy pool from `PROXY_LIST` (a JSON
  array of `{ id, url, tier }`). **No proxy provider is configured in this
  project** — `PROXY_LIST` is unset in every environment this has run in, so
  the pool is honestly empty and requests go out direct. Nothing fabricates
  a working proxy pool that doesn't exist.
- `src/net/proxy-pool.js` — rotates across whatever proxies are configured,
  cools down / ejects a proxy after consecutive failures or block
  responses (`PROXY_COOLDOWN_MS`, `PROXY_EJECT_AFTER_CONSECUTIVE_FAILURES`,
  `PROXY_EJECT_AFTER_BLOCK_COUNT`).
- `src/net/token-bucket.js` / `rate-limiter.js` — per-source request-rate
  limiting, configured by the caller (not env-driven), so one source being
  throttled never starves another.
- `src/net/backoff.js` — exponential backoff with jitter, shared by the
  crawl queue's retry logic (Block 2) and the image queue's retry logic
  (Block 3) — one backoff implementation, not two.
- `src/net/request-realism.js` — realistic header/User-Agent conventions
  for outgoing requests. This is ordinary web-client behavior, not
  anti-bot evasion: it does not solve CAPTCHAs, spoof past an active block,
  or rotate identity specifically to defeat a detected block.

## Block 2: crawl queue — resumable, retryable, deduplicated

- `db/schema.sql` — `crawl_jobs` (one row per URL to crawl, `status` in
  `pending`/`processing`/`retrying`/`succeeded`/`dead_letter`) and
  `dead_letter_jobs` (a permanent, readable record of why a job was
  abandoned).
- `src/queue/crawl-queue-repository.js` — `enqueueJob()` dedupes on
  `canonical_url` (a `UNIQUE` column) or `product_hash`, so the exact same
  work is never queued twice; a unique-violation is caught and resolved to
  a lookup, safe under concurrent enqueues. `claimNextJob()` uses
  `FOR UPDATE SKIP LOCKED` so two workers never claim the same row and
  neither blocks the other. `markFailed()` applies exponential backoff for
  a retryable error type up to `max_attempts`, then moves the job to
  `dead_letter_jobs` with a readable reason. `reclaimStaleJobs()` returns a
  job whose lock is older than a lease window back to `pending` — this is
  what makes a crashed worker's in-flight job recoverable rather than lost.
- `src/queue/url-canonicalizer.js` — normalizes host case, trailing slash,
  fragment, and query-param order so trivially-different URLs for the same
  page dedupe correctly.
- `src/queue/product-hash.js` — a stable UPC/SKU+size identity hash, so the
  same physical product reached via two different URLs still dedupes.
- `src/snapshots/snapshot-repository.js` — stores the raw extracted payload
  per crawl, independent of the queue, so a past run's raw data can be
  inspected without re-crawling.
- `src/history/field-history-repository.js` — records field-level changes
  across re-crawls of the same product, so "what changed and when" is
  answerable from the database, not just the current row.

## Block 3: image acquisition, validation, storage, and dedup

- `db/schema.sql` — `image_jobs`/`image_dead_letter` (a second, independent
  queue reusing the exact same claim/retry/backoff pattern as `crawl_jobs`
  — not a copy-pasted second implementation, the same primitives), `images`
  (content-addressed by SHA-256 hash — the same image referenced by two
  products is stored once), and `image_references` (which product/role/
  source an image belongs to; `role = 'placeholder'` is how a detected
  placeholder is recorded without deleting the reference).
- `src/images/image-fetcher.js` — conditional GET (ETag/Last-Modified),
  so re-checking an already-downloaded image doesn't re-download it.
- `src/images/magic-bytes.js`, `dimensions.js`, `validate.js` — format
  detection and validation from raw bytes (no external image library) —
  rejects non-image payloads, SVGs (a common bot-detection redirect target),
  and images below a minimum useful size.
- `src/images/content-hash.js` — SHA-256 dedup key.
- `src/images/perceptual-hash.js` — a from-scratch PNG decoder (zlib
  inflate + Paeth unfiltering) feeding an average-hash, used only for
  near-duplicate detection, not for anything AI-related.
- `src/images/placeholder-detector.js` — flags known placeholder/"image not
  available" patterns (by hash and by perceptual similarity) so a
  placeholder never gets treated as real product art.
- `src/images/role-selector.js` — `selectPrimaryImage()` picks the hero
  image from a set of candidates, explicitly excluding anything flagged as
  a placeholder (checked both via an in-memory `isPlaceholder` flag and the
  persisted `role === 'placeholder'` convention).
- `src/images/image-storage.js` — writes validated image bytes to
  `IMAGE_STORAGE_ROOT` (default `./output/images`), keyed by content hash.
- `src/images/process-image-job.js` — the actual per-job pipeline wiring
  fetch → hash → placeholder check → validate → store → reference →
  succeed/fail, tying every module above together into one path.

### Known limitation: only Standard product images are handled

The original requirements document calls for three image variants per
product: **Standard** (the original image), **Background-Removed**, and
**Watermarked**. Only Standard is implemented. See "Specification
conflicts" below — the same document's own "Solution / Out of scope"
section explicitly excludes "Image editing, retouching or background
removal," directly contradicting the Background-Removed/Watermarked
requirement. This was not silently resolved by guessing; see that section.

## Final gap-closure phase: closing out the original requirements document

Everything above (Phases 1–9, Blocks 1–3) was built phase-by-phase from
scoped instructions. Late in the project, the actual original requirements
document was provided in full for the first time and used to audit every
prior phase against it directly, then implement whatever was still
technically implementable. This section documents what that phase added.

### AI validation & enrichment (`src/ai/`, `src/validation/`)

Two distinct, separately-required AI capabilities exist, and they are kept
separate on purpose because the document specifies them as separate
objectives operating on different data:

- **Enrichment** (`src/ai/enrichment.js`) — paraphrases exactly
  `product_description` and `food_pairing` (only those two fields, per the
  document's "4. AI Enrichment" section) as part of ingesting a *new*
  scraped record, before it reaches staging. `enrichProduct()` never
  touches any other field.
- **Validation** (`src/validation/validation-service.js`) — analyzes
  *existing* rows already in `products` (the document's Objective 1:
  "AI-Powered Product Data Validation and Cleansing") and writes findings
  to `product_validation_exceptions` — a suggested corrected value, a
  confidence score, and a reason, per row/field. Nothing here overwrites
  `products` directly; see "Review & approval" below. A hard-coded guard
  (`NOT_CORRECTABLE`) refuses to ever suggest changing identity/provenance
  fields (`item_number`, `source_site`, `source_url`, `scraped_at`).

Both are driven through one pluggable provider interface
(`src/ai/provider.js`: `paraphrase()`, `analyzeProduct()`), selected via
`AI_PROVIDER`:

- `deterministic-test` (default) — **not real AI.** Paraphrasing is a fixed
  set of synonym-substitution rules; validation is a fixed set of rule
  checks (missing required fields, varietal/color mismatches like "Chardonnay"
  labeled as a red wine). Every result from this provider is tagged
  `provider: "deterministic-test"` so it can never be mistaken for a real
  AI result downstream.
- `http` — a real, generic OpenAI-chat-completions-compatible client
  (`src/ai/providers/http-llm-provider.js`), requiring
  `AI_API_BASE_URL`/`AI_API_KEY`/`AI_MODEL`. **Disclosed limitation:** no
  API key exists in this development environment, so this provider has
  only ever been exercised against a local mock HTTP server in tests — it
  has never produced a real AI result. Do not treat it as validated against
  a live LLM.
- `none` — a no-op provider, for running the pipeline with AI fully
  disabled.

### Review & approval before production (`src/staging/`)

Per the document ("Data Review & Approval": "Only approved records may
proceed through final production mapping"), scraped data can no longer
reach the `products` table directly:

- `src/pipeline/ingest-product.js` (`ingestProduct()`) is now the only
  entry point for a *new* crawl: crawl → AI-enrich → write to
  `product_staging` with `status = 'pending_review'`. It never calls
  `upsertProduct()`.
- `src/staging/staging-repository.js`:
  - `approveStaging(stagingId, { reviewer })` — transactional: marks the
    staging row approved, then (only after that commits) promotes it into
    `products` via the existing `upsertProduct()`, then triggers master
    data mapping (below). A reviewer identity is required — there is no
    anonymous approval path.
  - `rejectStaging(stagingId, { reviewer, reason })` — requires both a
    reviewer and a reason; a rejected record never reaches `products`.
- `src/validation/validation-service.js`'s `approveException()` /
  `rejectException()` provide the equivalent approve/reject flow for AI
  *validation* findings against already-production rows.

**No UI exists for this, on purpose** — the document explicitly lists a
review UI as out of scope. Approval/rejection is a function call
(`approveStaging`/`rejectStaging`/`approveException`/`rejectException`),
callable from a script, a future API layer, or a REPL — whatever
downstream system ends up owning the actual review workflow.

### Master data mapping — after approval only (`src/master-data/`)

`src/master-data/master-data-service.js` implements get-or-create mapping
for Producer, Region, Varietal, and Professional Rater against
`master_producers`/`master_regions`/`master_varietals`/
`master_professional_raters`, matched case-insensitively on a normalized
name (`normalizeName()`: trim, lowercase, collapse whitespace) so
"Cabernet Sauvignon" and "cabernet   sauvignon" resolve to the same row
instead of duplicating it. A race between two concurrent first-inserts of
the same name is handled by catching the resulting unique-violation
(`error.code === '23505'`) and re-querying, rather than by locking.

`mapApprovedProductToMasterData()` is called **only** from inside
`approveStaging()`, after the product row is already committed — never
before approval, and never as a side effect of crawling or staging. It
updates `products.producer_master_id`/`region_master_id`/`varietal_master_id`
and upserts one `product_rater_links` row per professional rating.

### Compliance metadata (`src/compliance/`)

`source_compliance` (one row per source) records, per the document's
compliance requirements: whether robots.txt is honored, whether an
override exists (and, if so, who signed off on it and why — enforced, not
just a free-text field: `upsertSourceCompliance()` throws if an override is
set without both a reason and a signer), ToS review status, image
redistribution status, and whether the source is actually enabled in
production. `isSourceProductionReady(sourceName)` requires all of
robots-honored-or-signed-off, `tos_review_status === 'approved'`, and
`enabled_in_production` — flipping one flag alone is not enough.

Run `npm run compliance:seed` to seed a row for each of the four approved
production sources (`wine-com`, `total-wine`, `vivino`, `wine-searcher`)
with honest, unreviewed defaults (`tos_review_status: 'not_reviewed'`,
`enabled_in_production: false`) plus a `tos_review_notes` summary of what
was actually observed against each source in Phases 2/4/5/6 (blocked by
DataDome / PerimeterX / robots.txt disallow, as documented above) — **not**
a legal conclusion, and safe to re-run (it never overwrites an existing
row).

### Observability & alerts (`src/observability/`)

- `run-metrics.js` — `computePageMetrics(sourceName)` and
  `computeImageMetrics(sourceName)` compute real numbers from `crawl_jobs`/
  `dead_letter_jobs`/`image_jobs`/`image_references` (pages attempted/
  succeeded/blocked/dead-lettered, block rate, images queued/downloaded/
  dead-lettered, rejection reasons, placeholder rate) — nothing here is
  estimated or sampled, it's a direct query against the same tables the
  queue and image pipeline already write to.
- `alerts.js` — `evaluateAlerts()` is a pure function comparing metrics
  against configurable thresholds (`ALERT_BLOCK_RATE_THRESHOLD`,
  `ALERT_ZERO_ITEMS_ENABLED`, `ALERT_IMAGE_REJECTION_RATE_THRESHOLD`,
  `ALERT_IMAGE_PLACEHOLDER_RATE_THRESHOLD` — all optional, with the
  documented `DEFAULT_THRESHOLDS` applying otherwise, never hard-coded).
  `checkAndNotify()` computes metrics, evaluates alerts, and calls a
  pluggable `notify()` function per triggered alert.
- **Disclosed limitation:** the default notifier
  (`consoleNotifier`) only logs to the console. No email/Slack/pager
  integration exists — wiring one is a separate task for whichever
  notification channel Wine Outlet actually wants to use.

### Batch / scheduled execution (`src/batch/`)

The document calls for both on-demand single-product runs (already existed
— `npm run crawl`) and batch/scheduled runs. Rather than build a second
queue system, `src/batch/batch-runner.js` reuses the exact same
`crawl_jobs` queue Block 2 already built:

```bash
npm run batch -- input/batch/products.json
```

where `products.json` is a JSON array of product inputs (same shape as
`input/sample-product.json`). This enqueues every product (deduped by the
queue's existing canonical-URL/product-hash logic — submitting the same
file twice is safe and creates no duplicate work) and drains the queue,
running each claimed job through the full ingest pipeline (crawl → AI
enrich → stage).

**Resumability contract:** `crawl_jobs` intentionally does not persist
`item_name`/`size`/`vintage` (that would duplicate the caller's own input
data into the queue table for no benefit) — so draining always requires
the same product-input list the batch was originally submitted with. Any
claimed job whose `item_number` has no match in that list fails clearly as
`MISSING_PRODUCT_INPUT` rather than guessing at missing fields. In
practice this means: after a crash or interruption, re-run
`npm run batch -- input/batch/products.json` with the *same* file — the
queue's own status tracking (a job already `succeeded` is never reclaimed)
prevents re-processing, so this is safe to re-invoke, not something that
needs its own separate "resume" flag. Verified in
`tests/batch-runner.integration.test.js`, including a simulated
crash (a stale `processing` lock reclaimed by `reclaimStaleJobs()`, then
completed by a fresh drain).

**Refresh cadence is deliberately not decided here** — the document's own
"Open items" list leaves it unconfirmed ("Confirm refresh cadence
(daily/weekly)"). `npm run batch` is schedule-agnostic on purpose: any
external scheduler (cron, Windows Task Scheduler, a CI scheduled job) can
invoke it at whatever interval is eventually decided, without this project
needing its own in-process scheduler.

### Specification conflicts (not implemented — flagged, not guessed)

The document contradicts itself on image variants: Objective 3 / "6. Image
Extraction" requires three variants (Standard, Background-Removed,
Watermarked), while the "Solution" section's "Out of scope" list explicitly
excludes "Image editing, retouching or background removal." Implementing
Background-Removed/Watermarked would violate the explicit out-of-scope
instruction; not implementing them leaves Objective 3 incomplete as
literally written. Per instruction not to guess, this is left
**OPEN — SPECIFICATION CONFLICT**: only the Standard/original image is
implemented (Block 3, above). Resolving this requires a business decision
this project cannot make on its own.

### Open business decisions (not invented)

Per the document's own "Open items" list and explicit instruction not to
invent decisions on these: target-source priority beyond the documented
tie-break default (`DEFAULT_SOURCE_PRIORITY` in `source-selector.js`),
refresh cadence, proxy provider/budget (Block 1's pool is real but
unpopulated — `PROXY_LIST` is unset), image storage backend/retention
policy and derivative sizes beyond the Standard variant, and legal/ToS
review sign-off per source (`source_compliance` rows exist and are
enforced-but-honest, all currently `not_reviewed`).

### Troubleshooting

- **`spawn wmic.exe ENOENT` in the crawl log** — Crawlee's memory-snapshot
  probe fails on this Windows environment; harmless and already handled —
  the crawler catches this and falls back to direct Playwright execution
  automatically (see the "Crawlee runtime unavailable... falling back"
  line in the log). Not an error to chase.
- **Integration tests fail only when run together, not individually** — if
  you see this, you likely ran `node --test` without
  `--test-concurrency=1`. Every `*.integration.test.js` file shares one
  real Postgres database; Node's test runner runs test *files*
  concurrently by default, and two files racing to claim the same
  `crawl_jobs` row (or asserting an exact global row count) is a test-file
  concurrency issue, not a code bug. `npm test` already passes
  `--test-concurrency=1` for this reason — don't remove it.
- **A batch run reports `MISSING_PRODUCT_INPUT`** — the product-input file
  passed to `npm run batch` doesn't include every `item_number` that has an
  outstanding job in `crawl_jobs`. Re-run with the full, original list —
  see "Resumability contract" above.
- **`AI_PROVIDER=http` throws on startup** — `AI_API_BASE_URL`/`AI_API_KEY`/
  `AI_MODEL` must all be set together; there is no partial-config fallback,
  by design (a silently-half-configured AI provider is worse than a clear
  startup error).
- **A robots.txt override throws in `upsertSourceCompliance()`** — both
  `robotsTxtOverrideReason` and `robotsTxtOverrideSignedOffBy` are required
  together; this is enforced, not optional — see "Compliance metadata"
  above.

## Second gap-closure pass: production-readiness completion

After the final gap-closure phase above, the system was actually run live
end to end against real Postgres, real local servers, and (where robots.txt
permits) the real production sites — see the live-validation audit. That
live run surfaced one genuine gap that no amount of code review had caught,
and a second pass closed it plus every other implementable item from the
requirements document's remaining PARTIAL/BLOCKED/OPEN list.

### The gap live validation found: robots.txt was never enforced at runtime

Every earlier phase checked a source's robots.txt manually, once, during
that adapter's development (Phases 2/4/5/6) — nothing in the crawler itself
re-checked it on every request. `src/compliance/robots-checker.js` closes
this: it fetches and parses robots.txt live, matches the requesting
user-agent's group (falling back to `*`), and applies the documented
longest-match-wins precedence. Wired into `runCrawl()` (`src/crawler/
crawler.js`) before any navigation — a disallowed path is refused with a
`ROBOTS_DISALLOWED` error before a single HTTP request is made. Fails
**open** (allowed) when robots.txt is unreachable, absent, or errors — a
missing robots.txt conventionally means "no restriction," not "deny
everything" — and fails **closed** only on an explicit matching `Disallow`.
A signed-off override recorded in `source_compliance` bypasses the check
entirely (see "Compliance metadata" above; the sign-off requirement was
already enforced, this just makes the check itself real). Verified live
against a controlled local server in both directions, and against all four
real production domains' actual current robots.txt.

One live consequence worth flagging: **Wine-Searcher's robots.txt has
changed since earlier phases** — it now explicitly disallows ClaudeBot on
every path except the bare root and `/m/`, where before it had no
bot-specific rule at all. The `/find/` search path used throughout this
project is no longer permitted even before PerimeterX would have blocked
it. robots.txt is refetched live on every run (with a short in-process
cache — see `CACHE_TTL_MS` in the module), so this project always reflects
the source's *current* policy, not a snapshot from whenever an adapter was
first built.

### Proxy system: completed and wired into the crawler for real

Before this pass, `ProxyPool`/`RateLimiter` (Block 1) were built and unit
-tested but **`runCrawl()` never called either of them** — every real
crawl bypassed rate limiting and proxy selection entirely. `src/net/
crawl-guardrails.js` closes this, tying together:

- **Provider abstraction** (`src/net/proxy-provider.js`) — `PROXY_PROVIDER`
  env var selects where the proxy list comes from (`env-list`, reading
  `PROXY_LIST`, or `none`, forcing direct mode), mirroring `AI_PROVIDER`'s
  shape on purpose. A future real provider integration (an API call to
  fetch a live credential set from a paid service) is a new case added
  here, not a redesign of `ProxyPool` or anything that calls it.
- **Tiers** — `PROXY_LIST` entries carry a `tier` field (`residential`,
  `datacenter`, or any caller-defined label); `ProxyPool` treats it as
  opaque metadata a caller can filter/prefer on.
- **Health tracking** — success/failure counts, rolling average latency,
  block count, consecutive-failure count, all queryable via
  `proxyPool.getHealth(id)` — already existed in Block 1, now actually fed
  real outcomes via `guardrails.afterCrawl()`.
- **Automatic cooldown/ejection** — a blocked response cools a proxy down;
  repeated blocks or consecutive failures eject it outright. Unchanged from
  Block 1, now actually exercised by real crawls.
- **Sticky sessions, rotation, exhaustion detection, graceful direct-mode**
  — unchanged from Block 1; `isExhausted()` returning true (the case for
  every deployment of this project so far, since `PROXY_LIST` is unset)
  means the crawler proceeds without a proxy, exactly as it always did —
  wiring this in changes nothing for an unconfigured deployment.
- **Playwright integration** (`src/net/proxy-url.js`) — converts a
  `PROXY_LIST` URL (credentials embedded, the natural format most
  providers hand out) into Playwright's `{ server, username, password }`
  launch option shape.
- **Kill switch & source disablement** (`src/net/kill-switch.js`) —
  `CRAWLER_KILL_SWITCH=true` refuses every crawl immediately; `DISABLED_
  SOURCES=wine-com,total-wine` refuses just those. Both re-checked on every
  call, both default to "everything allowed."
- **Per-domain rate limiting** (`src/net/rate-limit-config.js`) — the four
  approved production hostnames get a conservative built-in default
  (1 req/sec, concurrency 1) with zero configuration required; every other
  domain (every local/test server included) is unthrottled unless
  explicitly configured via `RATE_LIMIT_CONFIG`. `beforeCrawl()` waits
  once, bounded (`MAX_RATE_LIMIT_WAIT_MS`), for a free token before
  refusing.
- **Per-source daily request budget** (`src/net/request-budget.js`) —
  "proxy budget" is an explicitly OPEN business decision in the
  requirements document, so no number is invented: with `MAX_REQUESTS_PER_
  SOURCE_PER_DAY` (and per-source overrides) unset, usage is still counted
  in the real `request_budget` table (Postgres-backed, so it survives a
  restart — an in-memory counter would silently reset the "daily" limit
  every time the process restarted) but never enforced. Set a limit and
  `runCrawl()` refuses with `BUDGET_EXCEEDED` once it's hit.

All of this defaults to **zero behavior change** for an unconfigured
deployment — verified by the full test suite passing unchanged before and
after this wiring, plus a dedicated live test
(`tests/crawl-guardrails.integration.test.js`) that routes a real Playwright
crawl of the local fixture through a real local forward-proxy server and
confirms the proxy actually saw the request.

### AI provider hardening

- **Structured response validation** (`src/ai/response-validator.js`) —
  every provider result (deterministic-test or a real `http` provider
  alike) is checked before being trusted anywhere downstream: a
  malformed shape, a finding targeting a not-correctable identity field, or
  an out-of-range confidence is dropped rather than propagated.
  `validation-service.js`'s `runValidation()` filters every provider result
  through this before inserting an exception row.
- **Hallucination guard for paraphrasing** — `enrichProduct()`
  (`src/ai/enrichment.js`) rejects a paraphrase that introduces a number
  not present in the original text (the shape a fabricated ABV/vintage/
  price claim would take) or that expands the text more than 2.5x — in
  either case, the original, verbatim source text is kept instead, and the
  rejection is recorded in `aiMetadata.rejectedFields`, never silently
  swallowed.
- **Adversarial test suite** (`tests/ai-adversarial.test.js`) — contradictory
  ABV (a new plausibility rule in the deterministic provider: 0-24% is
  generous enough to never false-positive on a real fortified wine, but
  catches a 145% scraping error), contradictory varietal/color and
  varietal/category (existing rules, extended coverage), a fabricated food
  pairing and a wildly-expanded paraphrase (both genuinely rejected by the
  hallucination guard above), conflicting multi-source data (handled by
  `source-selector.js`, confirmed here to never silently average/overwrite),
  and confirmation that no confidence-based auto-apply path exists anywhere
  — every finding, regardless of confidence, requires an explicit
  `approveException()` call.
- **Missing producer is deliberately NOT flagged** — documented, not an
  oversight: every production adapter honestly reports `producer: null`
  when the source page has no distinct signal for it (separate from
  `brand`), which is common and not a data defect. Treating that as an
  AI-flaggable exception would flood the review queue with noise on every
  honestly-incomplete extraction, including the local fixture used
  throughout this project's own testing.
- **Contradictory region is a documented, known gap** — flagging it would
  require a region/varietal/country reference table this project
  deliberately does not fabricate (same reasoning as the existing
  varietal-color table's own header comment: "not a claim of comprehensive
  wine knowledge").

### Business configuration: mechanism built, no invented policy

Per the requirements document's own "Open items" list, none of the
following have an invented default — each is opt-in, each fails safe
(does nothing) when unconfigured, and each is ready to use the moment a
real decision is made:

| Decision | Mechanism | Configuration |
|---|---|---|
| Source priority | `DEFAULT_SOURCE_PRIORITY` in `source-selector.js` (a documented tie-break, not a business policy) | `options.priorityOrder` override, per call |
| Refresh cadence | `src/scheduler/scheduler.js` — overlap-safe, run-tracked (`scheduled_runs`), any cadence expressible as a minute count | `SCHEDULE_INTERVAL_MINUTES` + `SCHEDULE_BATCH_FILE` |
| Proxy budget | `src/net/request-budget.js` — Postgres-backed daily counter, global or per-source | `MAX_REQUESTS_PER_SOURCE_PER_DAY[_<SOURCE>]` |
| Image retention | `src/images/retention.js` — deletes only unreferenced, expired images; a product's live image is never touched regardless of age | `IMAGE_RETENTION_DAYS` |
| Image derivatives | Not implemented — see "Specification conflicts" | still OPEN |

### Scheduler (`src/scheduler/`)

`npm run schedule` runs `src/scheduler/run-scheduler-cli.js`, a real
long-running process (not unref'd — it's meant to stay alive) that ticks
on `SCHEDULE_INTERVAL_MINUTES`, each tick calling the same `runBatch()`
Block 2/final-phase batching already built (no second queue, no second
batch implementation). Overlap protection is a real in-memory mutex plus a
`skipped_overlap` status recorded in `scheduled_runs` when a tick fires
while the previous one is still running — verified live with a real
Playwright crawl running on a fast interval, confirming overlapping ticks
are genuinely skipped, not queued or double-run. A tick that fails (e.g. a
malformed batch file) is recorded with its error message and does **not**
wedge the mutex — verified by a subsequent tick succeeding normally. Both
`SCHEDULE_INTERVAL_MINUTES` and `SCHEDULE_BATCH_FILE` must be set together;
with either unset, `createSchedulerFromEnv()` returns `null` and the CLI
exits with a clear message rather than guessing a cadence.

### Configuration validation (`src/config/startup-validator.js`)

`npm run config:check` validates `DATABASE_URL`, AI/proxy/storage/
scheduler/compliance/budget configuration in one pass, before anything
tries to run — a malformed `PROXY_LIST`, an `AI_PROVIDER=http` missing its
credentials, a non-positive retention/budget/interval value, or
`ROBOTS_TXT_GLOBAL_OVERRIDE=true` (refused outright — overrides must be
per-source with a recorded sign-off, never a blanket bypass) are all hard
errors with an actionable message. Never logs or echoes back the actual
value of a secret — only whether one is present and how many characters
long. `src/scheduler/run-scheduler-cli.js` runs this automatically before
starting.

### Secrets redaction (`src/utils/redact.js`)

A real, if narrow, leak vector existed: a failed proxy connection or
database error can legitimately include the full connection URL —
credentials included — in its error message, and every crawl failure's
error message is written to `output/reports/*.json` and printed to the
terminal. `redactSecrets()` strips embedded `user:pass@` credentials,
`Bearer`/`Basic` tokens, and common `key=`/`token=`/`password=`/`secret=`
patterns from every error message before it reaches a report file or the
console — wired into `crawler.js`'s `finalizeFailure()`/`makeFailureResult()`,
the two choke points every failure path (a crawl error, `ACCESS_DENIED`,
`ROBOTS_DISALLOWED`, a guardrail refusal) funnels through.

### New commands

```bash
npm run config:check      # validate all environment configuration at once
npm run schedule          # start the optional in-process scheduler (real process, stays running)
npm run image:cleanup     # dry-run image retention cleanup (add -- --apply to actually delete)
```

## Third pass: frontend, and a large-batch queue stress test

### Frontend + backend API (`src/api/`, `public/`)

Per an explicit instruction overriding the original document's own "no
review UI needed" line, a real frontend now exists — not a static mockup:
`public/` (plain HTML/CSS/vanilla JS, no build step, no framework) is
served by a real backend (`src/api/server.js`, plain `node:http` — no
Express, consistent with this project's existing from-scratch style) whose
`/api/*` routes (`src/api/routes.js`) call the exact same repository
modules the crawler/batch/scheduler already use. There is no separate
"frontend data layer" and nothing hard-coded — every number on every page
comes from a live query against the real Postgres database.

```bash
npm run serve              # starts on http://localhost:3100 (PORT env to override)
```

Pages, each backed by real endpoints:

| Page | Reads | Writes |
|---|---|---|
| Dashboard | product count, queue/image-queue status counts, AI review counts, blocked-source count | — |
| Products | search/paginate `products`; product detail incl. images + AI exceptions | — |
| Crawls | recent `crawl_jobs` | starts a real single-product crawl (`ingestProduct`) or batch (`runBatch`) |
| Queue | crawl + image queue status counts, recent dead-letter | — |
| AI Review | pending `product_validation_exceptions` and `product_staging` | approve/reject each — calls the real `approveException`/`rejectException`/`approveStaging`/`rejectStaging` functions, same as every other path into `products` |
| Sources | `source_compliance` + most recent `crawl_jobs` attempt per source | — |
| Images | stored `images` + their `image_references` | — |
| Database / Admin | live connection status + real row counts across 12 tables | — |

Verified live end to end (`tests/api-server.integration.test.js`, 11
tests): a real HTTP POST to `/api/crawls/single` triggers a real Playwright
crawl of the local fixture and a real Postgres insert into
`product_staging`; the product is confirmed absent from `/api/products/
:itemNumber` (404) until a real HTTP POST to `/api/ai/staging/:id/approve`
promotes it — at which point the same endpoint returns it for real. A
reject without a reason is refused (400); a valid reject never promotes the
record. Static file serving is also covered, including a path-traversal
attempt against it being refused.

**What this frontend is not**: a build-tooled SPA (React/Vite/etc.) — the
per-page render functions in `public/app.js` are plain DOM string
templates, appropriate for an internal operational tool at this scale, not
a public-facing product. Authentication/access control is not implemented
— see "Known limitations" below.

### Large-batch queue stress test

The concern behind this ("does the system behave like a resumable queue,
not a one-shot loop that silently loses work past ~10,000 items") was
tested directly against the real `crawl_jobs` queue, at 10,000 jobs, using
real concurrent Postgres `FOR UPDATE SKIP LOCKED` claiming — not 10,000
real browser crawls (which would take hours and wouldn't test anything the
crawler-engine tests elsewhere haven't already proven one request at a
time) and not a single real external HTTP request.

```
10,000 jobs bulk-inserted:            1504ms  (6,649 inserts/sec)
Bulk re-submission of all 10,000:      491ms  → 0 duplicates created
enqueueJob() dedup, sampled x100:     100/100 correctly recognized
Concurrent drain, 8 workers:          up to 456 jobs/sec
Simulated crash (200 jobs abandoned mid-claim, real lock aging):
  reclaimStaleJobs() recovered:       200/200
Resume passes (fresh workers, including reclaimed + retried jobs):
  FINAL: 9,500 succeeded, 500 dead-lettered, 0 pending/retrying, 0 lost
  Every one of the 10,000 jobs accounted for: true
```

The synthetic outcome mix (≈85% immediate success, ≈10% transient-then-
recovered via retry/backoff, ≈5% permanent/dead-lettered) was chosen to
exercise every queue state transition, not just the happy path — the exact
95%/5% final split matches that design precisely, confirming retries and
dead-lettering both fired as intended at scale, not just in the two/three
-job unit tests. All rows were cleaned up after the run; nothing from this
test persists in the database.

## Required Node.js version

This project targets Node.js 18 or newer.

## Installation

```bash
npm install
npx playwright install --with-deps chromium
```

## How to install/use Playwright browsers

Playwright downloads the browser engine on first use. For a local development setup, run:

```bash
npx playwright install --with-deps chromium
```

If the browser is not installed yet, the runtime will fail with a Playwright browser installation error.

## How to provide a product input

Create or edit a JSON file in the `input/` directory. Example:

```json
{
  "item_number": "WO-10001",
  "item_name": "Example Cabernet Sauvignon",
  "size": "750ml",
  "vintage": "2021",
  "source": {
    "name": "example-source",
    "url": "https://example.com/product/example"
  }
}
```

## How to run the crawler

Run a local input file:

```bash
npm run crawl -- input/sample-product.json
```

In some local Windows shells, the npm wrapper can fail because of environment-specific command resolution. In that case, use the local entrypoint directly:

```bash
node src/index.js input/sample-product.json
```

Run directly from a product URL:

```bash
node src/index.js "https://example.com/product"
```

## What appears in the terminal

The crawler prints a clear run header, crawl stage markers, and a short result summary, for example:

```text
==================================================
WINE OUTLET PRODUCT CRAWLER
==================================================

RUN ID:
run_...

SOURCE:
Example Source

ITEM:
WO-10001

PRODUCT:
Example Cabernet Sauvignon

URL:
https://example.com/product/example

--------------------------------------------------
CRAWL
--------------------------------------------------

Request started
Page loaded
Extraction started
Extraction completed

--------------------------------------------------
RESULT
--------------------------------------------------

Status:
SUCCESS

Fields extracted:
X

Images found:
X

Duration:
XXXX ms
```

## Where JSON results are saved

Normalized product result files are saved to:

```text
output/results/
```

Example:

```text
output/results/WO-10001.json
```

## Where crawl reports are saved

Crawl metadata and execution status are saved to:

```text
output/reports/
```

Example:

```text
output/reports/run_20260827_001.json
```

## Where raw HTML is saved

Raw page HTML is saved to:

```text
output/raw/
```

Example:

```text
output/raw/WO-10001.html
```

## How source adapters work

The core crawler does not contain source-specific selectors. It resolves a
source adapter — by explicit source name, or (as of Phase 3) by matching the
source URL's hostname against the four approved production sources — and
passes the loaded page along to that adapter. The adapter extracts data
using selectors that match that source's actual page structure. See
"Phase 3 scope" above for the full registry/adapter contract.

This keeps the crawler core reusable across sources without it ever needing
to know any source-specific detail itself.

## How a future source can be added

To add a new production source later:

1. Create a new adapter file in `src/sources/` exporting
   `{ name, hostnames, canHandle(url), extract(context) }` (or start from
   `src/sources/stub-adapter.js` if the real page hasn't been inspected yet).
2. Register it in `PRODUCTION_SOURCES` in `src/sources/source-registry.js`.
3. Keep extraction logic isolated to that adapter — never add source-specific
   branches to the crawler core.
4. Return a plain object matching the normalized field conventions (`null`
   for missing scalars, `[]` for missing arrays — never fabricated).
5. Add offline fixture tests; let the crawler core handle normalization and
   output.

## What Phase 1 does NOT implement

This Phase 1 build intentionally did not include the items below. Most have
since been added in later phases/blocks — this list is kept as-written for
historical accuracy, with a note on each item's current status:

- PostgreSQL or database persistence — **added, Phase 9**
- Redis or BullMQ — still not used; the crawl/image queues (Block 2/3) are
  plain PostgreSQL tables with `FOR UPDATE SKIP LOCKED`, not a separate
  message broker
- AI or LLM validation — **added, final phase** (see "AI validation &
  enrichment" above) — real-provider path exists but has never been
  exercised against an actual LLM in this environment; the default is a
  non-AI deterministic stand-in
- product matching — used within adapters (e.g. matching a requested item
  name against search-results listings) since Phase 2
- image editing or background removal — **still not implemented, and still
  out of scope** — see "Specification conflicts" above; only the Standard/
  original image is acquired (Block 3)
- watermarking — **still not implemented**, same conflict as above
- perceptual hashing — **added, Block 3**, used only for near-duplicate/
  placeholder detection, not for any AI-adjacent purpose
- dashboards or admin interfaces — still not implemented, and out of scope
  per the original requirements document; review/approval (final phase) is
  a function-call API, not a UI
- authentication or anti-bot circumvention — anti-bot circumvention
  remains out of scope everywhere in this project (see Phases 2/4/5/6);
  no authentication layer has been added, since nothing here is exposed as
  a service
- batching, scheduling, or queue orchestration — **batching and queue
  orchestration added, Block 2 + final phase** (`npm run batch`, reusing
  the `crawl_jobs` queue); **in-process scheduling also added, second
  gap-closure pass** (`npm run schedule`) — opt-in, since refresh cadence is
  an open business decision (see "Second gap-closure pass" above); any
  external scheduler invoking `npm run batch` directly remains equally
  valid
- Docker or cloud deployment — still not implemented; only PostgreSQL itself
  runs in Docker (`wineoutlet-postgres`) in this development environment,
  the application code does not

## How later phases will connect to this crawler

Later phases can consume the normalized product record produced here, validate it, enrich it with metadata, store it in PostgreSQL, and route it into downstream worker systems. This Phase 1 design keeps the scraper core intentionally simple so those later systems can build on top of it without rewriting the extraction engine.

## Project structure

```text
wine-outlet-crawler/
├── package.json
├── README.md
├── .gitignore
├── .env.example
├── input/
│   ├── sample-product.json
│   └── talli-drinks-test-product.json
├── db/
│   └── schema.sql                   # products + crawl_jobs/dead_letter_jobs (Block 2) +
│                                     # raw_snapshots/product_field_history (Block 2) +
│                                     # images/image_references/image_jobs/image_dead_letter (Block 3) +
│                                     # product_staging/product_validation_exceptions (final phase) +
│                                     # master_producers/master_regions/master_varietals/
│                                     # master_professional_raters/product_rater_links (final phase) +
│                                     # source_compliance (final phase) +
│                                     # request_budget/scheduled_runs (2nd gap-closure pass)
│                                     # — npm run db:migrate, idempotent
├── input/
│   ├── sample-product.json
│   ├── talli-drinks-test-product.json
│   └── batch/
│       └── sample-batch.json        # final phase — npm run batch -- input/batch/<file>.json
├── output/
│   ├── raw/
│   ├── results/
│   ├── reports/
│   └── images/                      # Block 3 — content-addressed image storage (IMAGE_STORAGE_ROOT)
├── src/
│   ├── index.js
│   ├── crawler/
│   │   ├── crawler.js
│   │   └── request-handler.js
│   ├── sources/
│   │   ├── source-registry.js       # registry: URL/name -> adapter
│   │   ├── hostname-utils.js        # shared hostname matching
│   │   ├── stub-adapter.js          # shared "not implemented yet" factory
│   │   ├── example-source.js        # Phase 1 local fixture
│   │   ├── wine-searcher.js         # Phase 2/7 — implemented, currently ACCESS_DENIED
│   │   ├── wine-com.js              # Phase 4 — implemented, currently ACCESS_DENIED
│   │   ├── total-wine.js            # Phase 5 — implemented, currently ACCESS_DENIED
│   │   ├── vivino.js                # Phase 6 — implemented, never live-requested (robots.txt)
│   │   └── talli-drinks.js          # dev/test-only, not a production source
│   ├── selection/
│   │   └── source-selector.js       # Phase 8 — deterministic multi-source selection
│   ├── db/
│   │   ├── connection.js            # pg.Pool, reads DATABASE_URL
│   │   ├── migrate.js               # applies db/schema.sql
│   │   └── product-repository.js    # the only file with raw product-table SQL in it
│   ├── net/                         # Block 1 — proxy pool, rate limiting, backoff, request realism
│   │   ├── proxy-config.js
│   │   ├── proxy-pool.js
│   │   ├── token-bucket.js
│   │   ├── rate-limiter.js
│   │   ├── backoff.js
│   │   ├── request-realism.js
│   │   ├── proxy-provider.js        # 2nd gap-closure — PROXY_PROVIDER abstraction
│   │   ├── proxy-url.js             # 2nd gap-closure — proxy URL -> Playwright launch option
│   │   ├── rate-limit-config.js     # 2nd gap-closure — per-domain rate limits from env
│   │   ├── kill-switch.js           # 2nd gap-closure — CRAWLER_KILL_SWITCH / DISABLED_SOURCES
│   │   ├── request-budget.js        # 2nd gap-closure — Postgres-backed per-source daily budget
│   │   └── crawl-guardrails.js      # 2nd gap-closure — ties all of the above into runCrawl()
│   ├── queue/                       # Block 2 — the crawl queue
│   │   ├── crawl-queue-repository.js
│   │   ├── url-canonicalizer.js
│   │   └── product-hash.js
│   ├── snapshots/
│   │   └── snapshot-repository.js   # Block 2
│   ├── history/
│   │   └── field-history-repository.js  # Block 2
│   ├── images/                      # Block 3 — acquisition, validation, storage, dedup
│   │   ├── image-queue-repository.js
│   │   ├── image-fetcher.js
│   │   ├── magic-bytes.js
│   │   ├── dimensions.js
│   │   ├── validate.js
│   │   ├── content-hash.js
│   │   ├── perceptual-hash.js
│   │   ├── placeholder-detector.js
│   │   ├── role-selector.js
│   │   ├── image-storage.js
│   │   ├── image-store-repository.js
│   │   ├── process-image-job.js
│   │   ├── retention.js             # 2nd gap-closure — configurable cleanup, npm run image:cleanup
│   │   └── run-cleanup-cli.js       # 2nd gap-closure
│   ├── ai/                          # final phase — AI provider abstraction + enrichment
│   │   ├── provider.js              # interface contract only
│   │   ├── provider-factory.js      # AI_PROVIDER env selection
│   │   ├── enrichment.js
│   │   ├── response-validator.js    # 2nd gap-closure — structural validation + hallucination guard
│   │   └── providers/
│   │       ├── deterministic-test-provider.js  # default — not real AI
│   │       └── http-llm-provider.js            # real client, never exercised live here
│   ├── validation/
│   │   └── validation-service.js    # final phase — AI validation of existing products rows
│   ├── staging/
│   │   └── staging-repository.js    # final phase — the only path into products for scraped data
│   ├── pipeline/
│   │   └── ingest-product.js        # final phase — crawl -> AI enrich -> stage
│   ├── master-data/
│   │   └── master-data-service.js   # final phase — get-or-create, after approval only
│   ├── compliance/
│   │   ├── compliance-repository.js # final phase
│   │   └── seed-production-sources.js  # npm run compliance:seed
│   ├── observability/
│   │   ├── run-metrics.js           # final phase
│   │   └── alerts.js                # final phase
│   ├── batch/
│   │   ├── batch-runner.js          # final phase — reuses the Block 2 queue, no second queue
│   │   └── run-batch-cli.js         # npm run batch
│   ├── scheduler/                   # 2nd gap-closure — opt-in cadence, reuses batch-runner
│   │   ├── scheduler.js
│   │   └── run-scheduler-cli.js     # npm run schedule
│   ├── schema/
│   │   └── product-schema.js
│   ├── config/
│   │   ├── crawler-config.js
│   │   ├── startup-validator.js     # 2nd gap-closure — npm run config:check
│   │   └── check-config-cli.js      # 2nd gap-closure
│   ├── utils/
│   │   ├── normalize.js
│   │   ├── logging.js
│   │   └── redact.js                # 2nd gap-closure — secrets never reach a report/log
│   └── api/                         # 3rd pass — real backend for the frontend
│       ├── server.js                # npm run serve — plain node:http, no framework
│       ├── router.js                # minimal hand-rolled router
│       └── routes.js                # every /api/* route; all real DB reads/writes
├── public/                          # 3rd pass — the frontend itself (no build step)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── tests/
    ├── normalization.test.js
    ├── wine-searcher-adapter.test.js
    ├── wine-com-adapter.test.js
    ├── total-wine-adapter.test.js
    ├── vivino-adapter.test.js
    ├── source-registry.test.js
    ├── source-selector.test.js              # Phase 8
    ├── product-repository-mapping.test.js   # offline, always runs
    ├── product-repository.integration.test.js  # gated on DATABASE_URL
    ├── ai-provider.test.js                        # final phase — offline
    ├── staging.integration.test.js                # final phase — gated on DATABASE_URL
    ├── ingest-pipeline.integration.test.js         # final phase — gated on DATABASE_URL
    ├── validation-service.integration.test.js      # final phase — gated on DATABASE_URL
    ├── master-data.integration.test.js             # final phase — gated on DATABASE_URL
    ├── compliance.integration.test.js              # final phase — gated on DATABASE_URL
    ├── process-image-job.integration.test.js       # final phase — gated on DATABASE_URL
    ├── run-metrics.integration.test.js             # final phase — gated on DATABASE_URL
    ├── alerts.test.js                              # final phase — offline
    ├── batch-runner.integration.test.js            # final phase — gated on DATABASE_URL
    ├── end-to-end.integration.test.js              # gated on DATABASE_URL
    ├── robots-checker.test.js                      # 2nd gap-closure — offline
    ├── robots-enforcement.integration.test.js      # 2nd gap-closure — live, controlled server
    ├── startup-validator.test.js                   # 2nd gap-closure — offline
    ├── proxy-provider.test.js                      # 2nd gap-closure — offline
    ├── rate-limit-config.test.js                   # 2nd gap-closure — offline
    ├── kill-switch.test.js                         # 2nd gap-closure — offline
    ├── proxy-url.test.js                           # 2nd gap-closure — offline
    ├── request-budget.integration.test.js          # 2nd gap-closure — gated on DATABASE_URL
    ├── crawl-guardrails.integration.test.js        # 2nd gap-closure — live, incl. a real forward proxy
    ├── ai-adversarial.test.js                      # 2nd gap-closure — offline
    ├── redact.test.js                              # 2nd gap-closure — offline
    ├── image-retention.integration.test.js         # 2nd gap-closure — gated on DATABASE_URL
    ├── scheduler.integration.test.js               # 2nd gap-closure — gated on DATABASE_URL
    ├── api-server.integration.test.js              # 3rd pass — live, real HTTP requests to a real server instance
    └── fixtures/
        ├── wine-searcher-blocked.html
        ├── wine-searcher-product.html
        ├── wine-searcher-search-results.html
        ├── wine-com-blocked.html
        ├── wine-com-product.html
        ├── wine-com-product-minimal.html
        ├── wine-com-listing.html
        ├── wine-com-unknown.html
        ├── total-wine-blocked.html
        ├── total-wine-product.html
        ├── total-wine-product-minimal.html
        ├── total-wine-listing.html
        ├── total-wine-unknown.html
        ├── vivino-blocked-synthetic.html   # NOT a real capture — see Phase 6
        ├── vivino-product.html             # synthetic
        ├── vivino-product-minimal.html     # synthetic
        ├── vivino-product-with-community-rating.html  # synthetic
        ├── vivino-listing.html             # synthetic
        └── vivino-unknown.html             # synthetic
```
# WineOutlet

## Production deployment

The supported deployment is Docker Compose. It runs the API, built React
dashboard, PostgreSQL, database migrations, and persistent image/result
storage together.

Requirements: Docker Desktop or Docker Engine with the Compose plugin.

1. Create a `.env` file and set a strong `POSTGRES_PASSWORD` (the Compose
   default is suitable only for local development). Other application
   settings can be added from `.env.example`.
2. Start the stack:

   ```sh
   docker compose up --build -d
   ```

3. Open `http://localhost:3100/dashboard/`.
4. Check deployment health:

   ```sh
   docker compose ps
   curl http://localhost:3100/api/health
   ```

The app container retries the idempotent schema migration until PostgreSQL is
ready, then starts the API. Do not expose PostgreSQL's port publicly. For a managed PostgreSQL service, replace the `DATABASE_URL` environment
value in the `app` service with the provider's connection string and run only
the `app` service with the same image.

### Hosting without Docker

Use Node 18 or newer, set the host-provided `PORT`, and use:

```sh
npm install
npm run build
npm start
```

The server listens on `PORT` and serves the dashboard at `/dashboard/`.
It also starts without `DATABASE_URL` so the dashboard can be viewed before
PostgreSQL is configured; database-backed screens return a clear 503 response
until `DATABASE_URL` is set. For a static-only host, publish `frontend/dist/`
and use its generated `index.html` as the site entry point.

To stop the stack without deleting data:

```sh
docker compose down
```

To remove the database and stored volumes as well, use
`docker compose down -v`.
