# HeatShift

HeatShift is a hackathon prototype for planning daylight work windows around measured hyperlocal heat patterns. It provides planning guidance, not a safety rating.

## Run locally

1. Use Node.js 20 or newer.
2. Install dependencies with `npm install`.
3. Create `.env.local` and set `FORTYGUARD_API_KEY`.
4. Start the app with `npm run dev`.
5. Open `http://localhost:3000`.

The health check is available at `GET /api/health` and returns `{"ok":true}`.

## Phase 1 API

`POST /api/fortyguard` accepts:

```json
{
  "sites": [{ "id": "downtown", "lat": 33.4484, "lng": -112.074 }],
  "date": "YYYY-MM-DD",
  "hours": [6, 7, 8, 17, 18]
}
```

The route submits one FortyGuard `filter_type=1` heatmap job for each site-hour. It runs at most eight jobs concurrently, polls status every five seconds for up to 36 attempts, retries transient status 404 responses, backs off on 429 responses, and omits empty day/hour results.

The FortyGuard API key is read only by the server route from `FORTYGUARD_API_KEY`; it is never returned to the browser or logged.
