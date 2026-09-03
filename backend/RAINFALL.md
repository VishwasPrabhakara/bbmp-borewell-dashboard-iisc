# Rainfall data sources — pick one, run it

The dashboard reads per-ward rainfall from `../data/rainfall/<ward_no>.json` plus
the `rainfall_mm_annual` field on each feature in `../data/wards.geojson`.

Four scripts in this folder write those files. All have the **same output shape**,
so the dashboard picks up whichever you ran last. Run any of them from this
folder.

| Script | Source | Resolution | Real-time lag | Setup effort | Free / key |
|---|---|---|---|---|---|
| `fetch_rainfall_openmeteo.py` | Open-Meteo (ERA5 + regional models) | ~11 km | ~1 day | none | free, no key |
| `fetch_rainfall_chirps.py` | CHIRPS via ClimateSERV | ~5.5 km | ~40 days | none | free, no key |
| `fetch_rainfall_ksndmc.py` | KSNDMC telemetric rain gauges (Karnataka govt) | actual gauges (~1500 across Karnataka; several dozen in BBMP) | live | **~15 min DevTools scouting to find the API endpoint** — script has a docstring walking you through it | free |
| `fetch_rainfall_nasapower.py` | NASA POWER (MERRA-2 / GEOS-IT) | ~55 km | ~1 day | none | free, no key |

## What we tested and found

Point comparison — trailing 12 months (Sep 2025 → Sep 2026), Bangalore central:

- NASA POWER: 667 mm (single value across all of BBMP; only 9 unique cells for 198 wards)
- Open-Meteo: 767–818 mm depending on point (closer to Bangalore's long-term ~900 mm normal; ~50 unique cells for 198 wards)

## Recommended order to try

1. **Open-Meteo** — 30 seconds, done. See what per-ward differentiation looks like on the map.
2. **CHIRPS** — 5–10 minutes (async job polling). Even finer per-ward differentiation.
3. **KSNDMC** — if you want actual measured gauge data. Open `fetch_rainfall_ksndmc.py` and follow the docstring at the top; when you paste in the two endpoint URLs, you get authoritative ward-level rainfall.

## How to run

```
cd backend
pip install -r requirements.txt      # first time only

# pick one:
python fetch_rainfall_openmeteo.py
python fetch_rainfall_chirps.py
python fetch_rainfall_ksndmc.py      # requires you to complete the two placeholder functions first
python fetch_rainfall_nasapower.py   # legacy — safe to skip

# then commit + push
cd ..
git add data && git commit -m "Refresh rainfall from <source>" && git push
```

Each script overwrites `../data/rainfall/*.json`, updates `../data/wards.geojson`
with fresh `rainfall_mm_annual` values, and writes `../data/rainfall/manifest.json`
so you can see which source is currently in use.

## Output shape (identical across all four)

Per-ward JSON (`data/rainfall/<ward_no>.json`):

```json
{
  "ward_no": 25,
  "ward_name": "Horamavu",
  "source": "Open-Meteo (ERA5 + regional models, ~11 km)",
  "start": "2025-09-03",
  "end":   "2026-09-01",
  "grid_cell": {"lat": 13.0, "lng": 77.65},
  "daily":   [{"date": "2025-09-03", "rainfall_mm": 4.2}, ...],
  "monthly": [{"month": "2025-09", "rainfall_mm": 87.4}, ...],
  "annual_total_mm": 812.6,
  "current_month_mm": 92.1
}
```

Manifest (`data/rainfall/manifest.json`):

```json
{
  "generated_at": "2026-09-03T14:30:00Z",
  "source": "Open-Meteo (ERA5 + regional models, ~11 km)",
  "start": "2025-09-03",
  "end":   "2026-09-01",
  "wards": 198,
  "unique_cells": 47,
  "daily_rows": 72270
}
```

Fields patched into `data/wards.geojson` for every feature:

```json
{
  "rainfall_mm_annual":         812.6,
  "rainfall_mm_month_current":  92.1,
  "rainfall_updated_at":        "2026-09-03T14:30:00Z",
  "rainfall_source":            "Open-Meteo (ERA5 + regional models, ~11 km)"
}
```
