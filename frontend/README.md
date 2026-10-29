# WineOutlet Dashboard (frontend)

A React + Vite + TypeScript dashboard for the existing WineOutlet Product Crawler backend. It only ever talks to the backend's own `/api/*` routes — never to PostgreSQL, AI providers, or proxy providers directly, and no secret is ever sent to the browser.

## Development

```
npm install
npm run dev
```

Opens on `http://localhost:5173`, proxying `/api/*` to `http://localhost:3100` (see `vite.config.ts`). Requires the backend (`npm run serve` from the repo root) to already be running.

## Production build

```
npm run build
```

Outputs to `frontend/dist/`, which `src/api/server.js` serves at `http://localhost:3100/dashboard` automatically — no separate frontend server needed once built. The original `public/` SPA keeps serving at `/`, unchanged.

## Verifying AI connectivity

The Dashboard page's AI Provider card never claims "CONNECTED" from a hard-coded value — click **Test AI Connection** to trigger a real, explicit `POST /api/ai/verify` call. If `AI_PROVIDER=deterministic-test` (the repo's safe default), it reports `MOCK / DETERMINISTIC PROVIDER` without making any network call.
