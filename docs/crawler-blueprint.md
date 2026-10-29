# Crawler Blueprint

This repository should be organized as a layered extraction pipeline rather than a single scraper. The pipeline is:

`discover -> fetch -> render if needed -> browser action hook -> extract -> validate -> normalize -> persist`

## Layer responsibilities

### 1. Discovery and dedupe

- Accept a product input and source URL.
- Canonicalize the URL.
- Reject duplicates before any browser or HTTP work.
- Record the run and the dedupe decision.

### 2. Fetch layer

- Support two modes:
  - Plain HTTP for pages that already expose usable HTML.
  - Browser-rendered fetch for JavaScript-heavy or gated pages.
- Keep fetch concerns isolated from parsing.
- Capture status codes, timing, and the final resolved URL.

### 3. Compliance layer

- Enforce robots.txt before fetching.
- Enforce rate limits and request budgets before each request.
- Apply retry and backoff rules only where they are appropriate.
- If a site blocks access, record the block and stop or degrade gracefully.

### 4. Session and cookie layer

- Maintain cookies across requests when a site expects them.
- Reuse a session for consent, age-gate, and other normal UI state.
- Do not use this layer to bypass access controls.

### 5. Browser action hook

- Run only after navigation and before extraction.
- Handle normal UI steps such as:
  - cookie consent
  - age gates
  - lazy loading
  - infinite scroll
  - modal dismissal
- Keep it source-specific and explicit.

### 6. Content detection

- Detect whether the page is a product page, listing page, or unknown page.
- Prefer structured signals such as JSON-LD and OpenGraph.
- Avoid hardcoding selectors as the only strategy.

### 7. Parser and normalization

- Parse the DOM or embedded structured data.
- Convert source-specific shapes into one stable product schema.
- Never fabricate missing fields.
- Keep parsing independent from fetch mode.

### 8. Persistence and export

- Save normalized products separately from raw artifacts.
- Store crawl reports, logs, and extracted results independently.
- Keep raw HTML optional and bounded, not the primary data store.

## Recommended module layout

```text
src/
  queue/             # URL canonicalization, job creation, dedupe
  net/               # rate limiting, proxy/session policy, backoff
  compliance/        # robots.txt and allow/deny decisions
  crawler/           # orchestration and fetch/render control flow
  crawler/page-actions.js
  sources/           # source registry plus per-site adapters
  detection/         # content/page-type detection helpers
  parsing/           # DOM/JSON-LD parsing helpers
  schema/            # normalization and schema enforcement
  validation/        # record validation and guardrails
  storage/           # JSON/report/database export helpers
  staging/           # optional approval and post-extract workflow
  images/            # image queue, fetch, validation, storage
```

## Practical source contract

Each source adapter should expose:

- `name`
- `hostnames`
- `canHandle(url)`
- `preparePage({ page, context })` when interaction is needed
- `extract({ page, context })`

The adapter should own source-specific parsing only. The crawler should own navigation, retries, compliance, session policy, and stage reporting.

## Failure model

- `UNSUPPORTED_SOURCE` for URLs that cannot be routed.
- `ROBOTS_DISALLOWED` when robots.txt blocks the path.
- `ACCESS_DENIED`, `RATE_LIMITED`, `AUTH_REQUIRED`, `SOURCE_SERVER_ERROR`, or `PRODUCT_NOT_FOUND` when the site response says so.
- `PAGE_TYPE_UNKNOWN` when the page cannot be classified.
- `EXTRACTION_FAILED` only for unexpected adapter bugs.

## Design rule

If a site change breaks the crawler, it should break one layer at a time. The fetch layer should not know about product fields, and the parser should not know about retry policy.