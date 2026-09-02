# Worker (scaffold)

For the current dashboard, the static `data/*.json` files under `../data/` are enough. The worker directory is a placeholder for later, if you want the dashboard to pull live data from Postgres (through the same Cloudflare Worker + Neon pattern the main dashboard uses) instead of reading from static files.

When you're ready, the pattern to copy from your existing `bbmp-borewell-worker` is:

- `src/index.js` — Worker that fetches sensor/ward summaries from Neon over the HTTP-friendly connection
- `wrangler.toml` — deployment config
- Endpoints to expose (suggested):
  - `GET /api/wards`   -> array with the same fields as wards.geojson properties
  - `GET /api/sensors` -> same fields as sensors.json
  - `GET /api/sensor/:uid` -> same shape as sensor_series/<uid>.json

Then swap `DATA_BASE` in `dashboard/js/app.js` to point at the worker instead of `../data`.
