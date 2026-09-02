# Cloudflare Worker + D1 (optional, for scale)

The dashboard runs perfectly on GitHub Pages alone with static `data/*.json` files. This folder becomes relevant when you want:

- **Server-side queries** (e.g. "give me wards where >50% sensors are declining")
- **Live updates** without pushing to git
- **Data growth beyond ~1 GB** (GitHub Pages soft limit)
- **Writes from the UI** later (annotations, tagging problem sensors, etc.)

The setup uses two free services:

- **Cloudflare Workers** — the API layer (100k requests/day on free)
- **Cloudflare D1** — SQLite-compatible database, runs *inside* the worker (5 GB storage, 5M reads/day, 100k writes/day on free)

Total cost forever if you stay under those limits: **$0**.

## Files here

```
worker/
  wrangler.toml            Cloudflare deploy config; edit database_id after `wrangler d1 create`
  schema.sql               D1 tables (wards, sensors, sensor_series, snapshots) — safe to re-run
  src/index.js             The Worker: JSON API endpoints listed below
  seed_d1.py               Reads ../data/*.json and writes seed_generated/*.sql
  seed_generated/          Chunked SQL files produced by seed_d1.py; git-ignored
  README.md                (this file)
```

## API endpoints (once deployed)

| Method + Path | Response |
|---|---|
| `GET /` | Health check |
| `GET /api/manifest` | Latest snapshot summary |
| `GET /api/wards` | Array of ward properties (no geometry) |
| `GET /api/wards.geojson` | Full GeoJSON FeatureCollection for the map |
| `GET /api/sensors` | Array of all sensor metadata |
| `GET /api/sensor/:uid` | One sensor's metadata |
| `GET /api/sensor/:uid/series` | One sensor's time series (times, water_ft, flow_lpm, yield_kl) |
| `GET /api/ward/:no` | Ward properties + its sensor list |

Response shape matches `data/*.json` so the frontend code is the same whether you're on static or API mode.

## End-to-end deploy (first time)

Prerequisite: [Node.js LTS](https://nodejs.org). Then:

```
# 1) Install wrangler CLI once
npm install -g wrangler
wrangler login             # opens browser, log into your Cloudflare account (free is fine)

# 2) Create the D1 database
cd worker
wrangler d1 create bbmp-borewell-iisc
#   -> prints:
#      database_name = "bbmp-borewell-iisc"
#      database_id = "abc12345-..."   <-- copy this
# Paste that database_id into wrangler.toml (replace REPLACE_WITH_YOUR_DB_ID)

# 3) Create tables
wrangler d1 execute bbmp-borewell-iisc --remote --file=schema.sql

# 4) Generate seed SQL from ../data (needs Python + these two lines had already run once via backend/prepare_data.py)
python seed_d1.py
#   -> writes seed_generated/{manifest,wards,sensors}.sql
#      and seed_generated/series/00_clear.sql plus 001.sql, 002.sql, ...

# 5) Load the seed data
wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/manifest.sql
wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/wards.sql
wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/sensors.sql
wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/series/00_clear.sql
# Then loop over the series chunks:
#   Bash / Mac / Linux:
#     for f in seed_generated/series/[0-9]*.sql; do wrangler d1 execute bbmp-borewell-iisc --remote --file="$f"; done
#   PowerShell / Windows:
#     Get-ChildItem seed_generated\series -Filter "[0-9]*.sql" | ForEach-Object {
#       wrangler d1 execute bbmp-borewell-iisc --remote --file=$_.FullName
#     }

# 6) Deploy the Worker
wrangler deploy
#   -> prints: https://bbmp-borewell-iisc.<your-subdomain>.workers.dev

# 7) Point the dashboard at the Worker
# Edit ../js/config.js:
#   window.DASHBOARD_CONFIG = { source: "api", apiBase: "https://bbmp-borewell-iisc.<your-subdomain>.workers.dev" };
# Commit + push. GitHub Pages redeploys in ~1 minute.
```

## Refreshing data later

```
cd backend && python sensors_db_extract.py && python prepare_data.py    # rebuild ../data/*.json
cd ../worker && python seed_d1.py                                        # regenerate seed_generated/*.sql

# then re-execute the seed files (steps 5 above)
```

Because `schema.sql` and each seed file start with `DELETE FROM ...`, re-running is idempotent — the DB always ends up matching the latest `data/`.

## Endpoints under the hood

`src/index.js` is a single-file Worker that routes on `url.pathname`. All responses are JSON with permissive CORS so the GitHub-Pages frontend can call it from any origin. It uses D1's prepared statements (`env.DB.prepare(...).bind(...).first()`) which are safe against injection.

## Troubleshooting

- **`Error: no such table: wards`** — you skipped step 3 (`schema.sql`).
- **`Response body is too large`** during `wrangler d1 execute` — one of your seed chunks is over Cloudflare's ~20 MB per-request limit. Lower `chunk_size` in `seed_d1.py` (default 50) and re-run.
- **404 on `/api/...`** — either the Worker isn't deployed yet, or you have a stale service worker cached. Hard-refresh (Ctrl-Shift-R).
- **CORS errors** — the Worker already sends `Access-Control-Allow-Origin: *`. If you still see CORS complaints, you're probably hitting a Cloudflare error page, not the Worker.
