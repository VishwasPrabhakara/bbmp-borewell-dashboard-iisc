"""
Fetch per-ward rainfall from Open-Meteo Archive (ERA5 + regional models, ~11 km resolution).

Free, no API key required. Historical archive back to 1940.
Docs: https://open-meteo.com/en/docs/historical-weather-api

Output shape matches all other fetch_rainfall_*.py scripts so the dashboard
consumes any of them identically:

  ../data/rainfall/<ward_no>.json   { ward_no, ward_name, source, start, end,
                                       daily: [{date, rainfall_mm}], monthly: [...],
                                       annual_total_mm, current_month_mm }
  ../data/rainfall/manifest.json    { generated_at, source, start, end, wards, ... }

Also patches ../data/wards.geojson so each feature carries
  rainfall_mm_annual, rainfall_mm_month_current, rainfall_updated_at.

Run:
    cd backend && python fetch_rainfall_openmeteo.py
"""
import datetime as dt
import json
import time
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"
OUT = DATA / "rainfall"
OUT.mkdir(parents=True, exist_ok=True)

API = "https://archive-api.open-meteo.com/v1/archive"
DAYS_BACK = 365
SOURCE_LABEL = "Open-Meteo (ERA5 + regional models, ~11 km)"


def fetch(lat, lng, start, end):
    r = requests.get(API, params={
        "latitude": f"{lat:.4f}",
        "longitude": f"{lng:.4f}",
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
        "daily": "precipitation_sum",
        "timezone": "Asia/Kolkata",
    }, timeout=90)
    r.raise_for_status()
    j = r.json()
    dates = j["daily"]["time"]
    values = j["daily"]["precipitation_sum"]
    snap = (j.get("latitude"), j.get("longitude"))
    return snap, [{"date": d, "rainfall_mm": (None if v is None else float(v))} for d, v in zip(dates, values)]


def to_monthly(daily):
    by = defaultdict(float)
    for r in daily:
        if r["rainfall_mm"] is not None:
            by[r["date"][:7]] += r["rainfall_mm"]
    return [{"month": m, "rainfall_mm": round(v, 2)} for m, v in sorted(by.items())]


def current_month_total(daily):
    prefix = dt.date.today().strftime("%Y-%m")
    return round(sum((r["rainfall_mm"] or 0) for r in daily if r["date"].startswith(prefix)), 2)


def main():
    end = dt.date.today() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=DAYS_BACK - 1)
    print(f"Source: {SOURCE_LABEL}")
    print(f"Window: {start} -> {end}")

    wards_geo = json.load(open(DATA / "wards.geojson"))
    # Dedupe by ~11 km grid: round centroid to 0.1
    cell_wards = defaultdict(list)
    for f in wards_geo["features"]:
        c = f["properties"].get("centroid")
        if not c: continue
        cell_wards[(round(c[1], 2), round(c[0], 2))].append(f)
    print(f"{len(cell_wards)} unique query points across {sum(len(v) for v in cell_wards.values())} wards")

    cell_daily = {}
    for i, (key, feats) in enumerate(cell_wards.items(), 1):
        lat, lng = key
        print(f"  ({i}/{len(cell_wards)}) fetching lat={lat}, lng={lng} ...")
        try:
            snap, daily = fetch(lat, lng, start, end)
            cell_daily[key] = daily
        except Exception as e:
            print(f"    fail: {e}")
        time.sleep(0.3)

    total = written = 0
    for f in wards_geo["features"]:
        c = f["properties"].get("centroid"); wn = f["properties"].get("ward_no")
        if not c or wn is None: continue
        key = (round(c[1], 2), round(c[0], 2))
        daily = cell_daily.get(key)
        if not daily: continue
        monthly = to_monthly(daily)
        annual = round(sum((r["rainfall_mm"] or 0) for r in daily), 2)
        with open(OUT / f"{wn}.json", "w") as fh:
            json.dump({
                "ward_no": wn, "ward_name": f["properties"].get("ward_name") or "",
                "source": SOURCE_LABEL,
                "start": start.isoformat(), "end": end.isoformat(),
                "grid_cell": {"lat": key[0], "lng": key[1]},
                "daily": daily, "monthly": monthly,
                "annual_total_mm": annual, "current_month_mm": current_month_total(daily),
            }, fh)
        f["properties"]["rainfall_mm_annual"] = annual
        f["properties"]["rainfall_mm_month_current"] = current_month_total(daily)
        f["properties"]["rainfall_updated_at"] = dt.datetime.utcnow().isoformat() + "Z"
        f["properties"]["rainfall_source"] = SOURCE_LABEL
        written += 1
        total += len(daily)

    json.dump(wards_geo, open(DATA / "wards.geojson", "w"))
    json.dump({
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "source": SOURCE_LABEL,
        "start": start.isoformat(), "end": end.isoformat(),
        "wards": written, "unique_cells": len(cell_wards), "daily_rows": total,
    }, open(OUT / "manifest.json", "w"), indent=2)
    print(f"Done. {written} wards, {total} daily rows.")


if __name__ == "__main__":
    main()
