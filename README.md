# BBMP Borewell Dashboard — IISc for BWSSB

An interactive dashboard for exploring BBMP's 198 wards and the borewell sensors reporting inside them. Built for the Indian Institute of Science team to hand over to BWSSB.

- **Live URL** (once deployed): https://\<your-user\>.github.io/bbmp-borewell-dashboard-iisc/
- **Codebase**: static HTML/JS/CSS (this repo). Two data modes: (a) read `data/*.json` shipped with the site, or (b) call a Cloudflare Worker + D1 API. Switch via `js/config.js`.
- **Cost**: free at current scale (GitHub Pages + Cloudflare Workers free tier + D1 free tier).

If you're brand new here, **read [START_HERE.md](./START_HERE.md) first** — it walks through viewing locally, publishing to GitHub Pages, and refreshing data.

## Repo layout

```
Dashboard_IISC_for_BWSSB/
  index.html                        Dashboard entry (map + overlays). Includes Leaflet + Chart.js via CDN.
  css/style.css                     All styles. Slate/teal palette, minimal chrome, no default sidebars.
  js/
    config.js                       Data source switch: "static" (JSON files) or "api" (Cloudflare Worker).
    app.js                          Everything else: map, ward + sensor rendering, filters, search, sensor detail panel with charts.

  data/                             Data files served by the static site.
    manifest.json                   Snapshot summary (KH ZIP name, dates, counts).
    wards.geojson                   198 ward polygons + area, population, sensor counts.
    sensors.json                    Per-sensor metadata (uid, lat, lng, ward, HP, depth, coverage).
    sensor_series/<uid>.json        Per-sensor time series (water level, discharge, cumulative yield).

  backend/                          Python scripts that build data/ from raw sources.
    prepare_data.py                 Reads KH ZIP + ward shapefile + population xlsx -> writes data/*.
    sensors_db_extract.py           Pulls sensors table from your Neon Postgres DB (adds motor HP + full UID list) -> data/sensors_db.json.
    requirements.txt

  worker/                           Cloudflare Worker + D1 (optional, for scale).
    src/index.js                    The Worker itself: JSON API over the D1 database.
    wrangler.toml                   Worker + D1 binding config. Fill in your D1 database_id.
    schema.sql                      D1 tables: wards, sensors, sensor_series, snapshots.
    seed_d1.py                      Reads ../data/*.json and writes seed_generated/*.sql for wrangler to execute.
    seed_generated/                 (git-ignored) chunked SQL files produced by seed_d1.py.
    README.md                       End-to-end D1 deploy steps.

  .github/workflows/deploy.yml      GitHub Actions: on push to main -> deploy static site to GitHub Pages.
  .gitignore                        Excludes _to_delete/, .env, __pycache__, seed_generated/, etc.
  start_server.bat                  One-click local dev server (Windows).
  START_HERE.md                     Quickstart for viewing, publishing, refreshing data.
  README.md                         (this file)
```

## Architecture at a glance

Two swappable data modes, one frontend:

```
                            Static mode (default)
                            ─────────────────────
     ┌────────────┐   fetch ┌───────────────┐
     │  Browser   │────────>│ GitHub Pages  │──> serves data/*.json directly
     └────────────┘         └───────────────┘

                            API mode (Cloudflare + D1)
                            ─────────────────────────
     ┌────────────┐   fetch ┌────────────────┐  SQL   ┌───────┐
     │  Browser   │────────>│ Cloudflare Wkr │───────>│  D1   │
     └────────────┘         └────────────────┘        └───────┘
              (js/config.js chooses which)
```

The static mode has zero moving parts and is fine while total data stays under a few hundred MB. The API mode scales to years of historical data on Cloudflare's free tier (5 GB D1, 100k Worker requests/day) and is the path for when you want the dashboard to answer live queries.

## Where the data comes from

- **Raw source**: KH Projects sends a cleaned Excel ZIP (e.g. `borewell_water_level_200826.zip`) with one .xlsx per sensor for the current reporting window (currently 15 Jul – 20 Aug 2026, 579 sensors).
- **Ward boundaries**: BBMP's `bbmpwards.zip` shapefile (198 wards, sits in the sibling `bbmp-borewell-dashboard` repo).
- **Population / area**: `population_source.xlsx` in the sibling `bbmp-borewell-backend/exports/`.
- **Motor HP / borewell depth / full sensor list**: your Neon Postgres `sensors` table, populated by the existing `sync_kh_device_metadata.py` script that scrapes KH.

`backend/prepare_data.py` orchestrates all of the above and writes the JSON files under `data/`.

## KH filtering rules (matches the Ward-25 PPT)

A pump *session* = one blue-start row to the next red-end row in a KH .xlsx. A session is treated as **usable** when all four hold:

1. ≥ 3 water-level readings inside the session
2. cumulative water yield actually increased (some volume was pumped)
3. no sensor re-lock: no water-level jump > 20 ft between consecutive samples
4. no net level rise: stop level deeper than start (positive drawdown)

`prepare_data.py` exports the raw per-UID time series. Session-usability filtering is applied downstream by analysis scripts and by the dashboard's future forecasting features. If you want the sensor-detail chart to visually hide unusable sessions, ask — it's ~30 lines of frontend code.

## Dashboard behaviour

- Full-screen map on load; **no sidebars**. Toolbar (top-right) has search / filters / about.
- Wards choropleth-shaded by sensors-with-data. Toggle in Filters to shade by total sensors or population.
- 579 sensors visible by default. Bottom-right toggle reveals no-data sensors (once `sensors_db_extract.py` has run, this includes KH's full inventory beyond the 579).
- Hover a ward → tooltip (population, area, sensor counts).
- Click a ward → right-side panel with stats + full UID list. Click a UID → jumps to that sensor.
- Click a sensor → metadata (ward, motor HP, depth, first/last reading, reading count) + two charts (water level, discharge). Each chart has 1W / 1M / 3M / All range chips and an expand button for a full-window view.
- Search (Ctrl-K or the magnifier icon): ward name, ward number, or UID. Quick views: top / bottom / no-sensor wards.

## Publishing & refreshing

Both flows are one push. Full commands in [START_HERE.md](./START_HERE.md).

```
# refresh data snapshot
cd backend && python sensors_db_extract.py && python prepare_data.py

# publish
cd ..
git add . && git commit -m "Refresh snapshot" && git push
# GitHub Actions deploys to Pages in ~1 minute
```

## Contact

Original build: Vishwas Prabhakara (IISc), assisted by Claude Code. See individual READMEs in `backend/` and `worker/` for the finer details.
