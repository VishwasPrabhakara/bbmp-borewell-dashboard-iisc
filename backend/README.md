# backend/

Python scripts that build the dashboard's `data/` folder from raw sources. Run these on the Windows machine that has network access to Neon Postgres and to KH Projects — the cloud shells the assistant uses cannot reach either.

## Files

```
backend/
  prepare_data.py            Main entry point: reads KH ZIP + ward shapefile + population xlsx (+ optional sensors_db.json) and writes ../data/{wards.geojson, sensors.json, manifest.json, sensor_series/*.json}.
  sensors_db_extract.py      One-shot dump of the sensors table from your Neon Postgres DB into ../data/sensors_db.json (adds motor HP, borewell depth, pump name, and the full KH-known UID list beyond the 579 that are currently reporting).
  requirements.txt           Python deps: sqlalchemy, psycopg2-binary, openpyxl, pyshp.
```

## First-time setup

```
cd backend
pip install -r requirements.txt
```

You also need a `.env` file **one level up** (at the repo root) with:

```
DATABASE_URL=postgresql://neondb_owner:...@ep-orange-night-...neon.tech/neondb?sslmode=require
```

(Same DATABASE_URL used by `bbmp-borewell-backend/.env` — copy it from there.)

Do NOT commit `.env` — it's in `.gitignore`. Never paste it into git or Slack.

## Full refresh workflow

```
cd backend

# (a) Optional but recommended: pull motor HP / borewell depth / full sensor list from DB
python sensors_db_extract.py
#     -> writes ../data/sensors_db.json (a few hundred KB)

# (b) Rebuild the data folder from the current KH ZIP
python prepare_data.py
#     -> reads:
#          bbmpwards.zip                       (BBMP ward shapefile; expected in cwd unless WARDS_ZIP env var is set)
#          population_source.xlsx              (198-ward population/area; expected in cwd unless POPULATION_XLSX env var is set)
#          borewell_water_level_200826.zip     (current KH cleaned Excel snapshot; expected in cwd unless KH_ZIP env var is set)
#          ../data/sensors_db.json             (optional; if present, adds HP/depth + extra UIDs)
#     -> writes:
#          ../data/wards.geojson               (198 ward polygons + area/pop/sensor counts)
#          ../data/sensors.json                (per-sensor metadata)
#          ../data/sensor_series/<uid>.json    (per-sensor time series)
#          ../data/manifest.json               (snapshot summary)
```

Config paths (override via env vars if your files live elsewhere):

```
set WARDS_ZIP=D:\bbmp-borewell-dashboard\bbmpwards.zip
set POPULATION_XLSX=D:\bbmp-borewell-backend\exports\population_source.xlsx
set KH_ZIP=D:\bbmp-borewell-backend\borewell_water_level_200826.zip
python prepare_data.py
```

## After running

- **Static-mode dashboard**: just `git add data && git commit && git push`. GitHub Pages redeploys in ~1 minute.
- **API-mode dashboard** (if you set up the Cloudflare Worker + D1): follow `worker/README.md` step 4-5 to regenerate SQL and load it into D1.

## What each script does in detail

### `prepare_data.py`

1. Loads all 198 ward polygons from `bbmpwards.zip` (shapefile). Reads properties for ward_no and ward_name.
2. Loads the 198-row population xlsx (Sheet2). Reads Area_km2, Projected_Population_2026, Projected_Households_2024. Indexes by ward_no.
3. Opens every .xlsx inside the KH ZIP one at a time (579 files):
   - Parses the metadata row: UID, Lat, Long, DataFrom, DataTo.
   - Parses every subsequent data row: timestamp (KH's ddmmyy HHMMSS format), water level (ft below surface), flow rate (L/min), cumulative water yield (KL).
   - Records first/last timestamps and full time series.
4. Optionally merges `sensors_db.json` for motor HP, borewell depth, pump name, and UIDs that KH knows about but aren't in the current ZIP.
5. For every sensor with lat/long: spatial point-in-polygon join against the 198 ward polygons (identical logic to `bbmp-borewell-backend/core/spatial.py`).
6. Rolls up ward-level counts: total sensors + sensors-with-data per ward.
7. Writes:
   - `data/wards.geojson` — full polygons + all ward properties
   - `data/sensors.json` — one record per sensor
   - `data/sensor_series/<uid>.json` — one file per sensor's raw time series (only for sensors present in the ZIP)
   - `data/manifest.json` — snapshot metadata

### `sensors_db_extract.py`

- Reads `DATABASE_URL` from environment or from `../.env`.
- Runs a single `SELECT uid, lat, lng, ward_no, ward_name, motor_hp, borewell_depth, pump_name, first_data_at, last_data_at, total_readings FROM sensors ORDER BY uid`.
- Writes the result as JSON into `../data/sensors_db.json`.
- Only reads; never writes to the DB.

## KH scraping (out of scope for this repo)

The 579-sensor ZIP itself is produced by KH Projects and delivered manually (WhatsApp). The old KH-dashboard scraping path is disabled (KH said direct downloads caused jumps/errors). The only KH scrape still in use is the metadata sync (`sync_kh_device_metadata.py` in the sibling `bbmp-borewell-backend` repo) which updates the sensors table's motor_hp / borewell_depth / pump_name fields.
