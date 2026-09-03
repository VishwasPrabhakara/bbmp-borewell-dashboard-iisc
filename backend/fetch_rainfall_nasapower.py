"""
Fetch trailing-365-days daily rainfall for every BBMP ward centroid from
NASA POWER (MERRA-2 / GEOS-IT) and write it into the dashboard's data folder.

Outputs (relative to this file):
  ../data/rainfall/<ward_no>.json    { ward_no, ward_name, source, start, end,
                                        daily: [{date, rainfall_mm}], monthly: [{month, rainfall_mm}] }
  ../data/rainfall/manifest.json     { generated_at, start, end, wards, total_wards, total_days,
                                        unique_grid_cells }

It also patches ../data/wards.geojson to add:
  properties.rainfall_mm_annual         # trailing 12-month total (mm)
  properties.rainfall_mm_month_current  # current calendar month so far (mm)
  properties.rainfall_updated_at        # ISO timestamp

NASA POWER returns values on a fixed ~0.5° grid, so many BBMP wards resolve to the
same grid cell. We de-duplicate by rounding ward centroids to 1 decimal and only
hit the API once per unique cell — that keeps 198 wards down to ~4 API calls.

Requires internet + `pip install requests` (already in requirements.txt).

Run:
    cd backend && python fetch_rainfall.py
"""
import datetime as dt
import json
import time
from collections import defaultdict
from pathlib import Path

import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"
OUT = DATA / "rainfall"
OUT.mkdir(parents=True, exist_ok=True)

NASA_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
DAYS_BACK = 365


def fetch_power(lat, lng, start, end):
    q = urllib.parse.urlencode({
        "parameters": "PRECTOTCORR",
        "community": "AG",
        "longitude": f"{lng:.4f}",
        "latitude": f"{lat:.4f}",
        "start": start.strftime("%Y%m%d"),
        "end": end.strftime("%Y%m%d"),
        "format": "JSON",
    })
    url = f"{NASA_URL}?{q}"
    with urllib.request.urlopen(url, timeout=120) as r:
        payload = json.loads(r.read().decode("utf-8"))
    return payload["properties"]["parameter"]["PRECTOTCORR"]


def to_daily(raw):
    """{'20260901': 4.2, ...} -> [{'date':'2026-09-01','rainfall_mm':4.2}, ...] with -999 -> None"""
    out = []
    for k, v in sorted(raw.items()):
        d = dt.datetime.strptime(k, "%Y%m%d").date().isoformat()
        val = None if v in (-999, -999.0) else float(v)
        out.append({"date": d, "rainfall_mm": val})
    return out


def to_monthly(daily):
    by_month = defaultdict(list)
    for r in daily:
        m = r["date"][:7]  # YYYY-MM
        by_month[m].append(r["rainfall_mm"] or 0.0)
    return [{"month": m, "rainfall_mm": round(sum(v), 2)} for m, v in sorted(by_month.items())]


def current_month_total(daily):
    if not daily:
        return None
    today = dt.date.today()
    prefix = today.strftime("%Y-%m")
    total = 0.0
    n = 0
    for r in daily:
        if r["date"].startswith(prefix) and r["rainfall_mm"] is not None:
            total += r["rainfall_mm"]
            n += 1
    return round(total, 2) if n else None


def main():
    end = dt.date.today() - dt.timedelta(days=1)   # NASA POWER lags by ~1 day
    start = end - dt.timedelta(days=DAYS_BACK - 1)
    print(f"Fetching rainfall from {start} to {end}")

    wards_geo = json.load(open(DATA / "wards.geojson"))

    # Group wards by unique rounded grid cell
    cell_wards = defaultdict(list)
    for f in wards_geo["features"]:
        c = f["properties"].get("centroid")
        if not c:
            continue
        key = (round(c[1], 1), round(c[0], 1))  # (lat, lng) rounded
        cell_wards[key].append(f)
    print(f"{len(cell_wards)} unique NASA POWER grid cells cover {sum(len(v) for v in cell_wards.values())} wards")

    cell_daily = {}
    for i, (key, feats) in enumerate(cell_wards.items(), 1):
        lat, lng = key
        print(f"  ({i}/{len(cell_wards)}) fetching lat={lat}, lng={lng} ...")
        raw = fetch_power(lat, lng, start, end)
        cell_daily[key] = to_daily(raw)
        time.sleep(0.5)

    total_days = 0
    total_wards = 0
    for f in wards_geo["features"]:
        c = f["properties"].get("centroid")
        wn = f["properties"].get("ward_no")
        wname = f["properties"].get("ward_name") or ""
        if not c or wn is None:
            continue
        key = (round(c[1], 1), round(c[0], 1))
        daily = cell_daily.get(key)
        if not daily:
            continue
        monthly = to_monthly(daily)
        annual = round(sum((r["rainfall_mm"] or 0.0) for r in daily), 2)
        month_current = current_month_total(daily)
        with open(OUT / f"{wn}.json", "w") as fh:
            json.dump({
                "ward_no": wn,
                "ward_name": wname,
                "source": "NASA_POWER",
                "start": start.isoformat(),
                "end": end.isoformat(),
                "grid_cell": {"lat": key[0], "lng": key[1]},
                "daily": daily,
                "monthly": monthly,
                "annual_total_mm": annual,
                "current_month_mm": month_current,
            }, fh)
        f["properties"]["rainfall_mm_annual"] = annual
        f["properties"]["rainfall_mm_month_current"] = month_current
        f["properties"]["rainfall_updated_at"] = dt.datetime.utcnow().isoformat() + "Z"
        total_days += len(daily)
        total_wards += 1

    json.dump(wards_geo, open(DATA / "wards.geojson", "w"))
    json.dump({
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "source": "NASA_POWER",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "wards": total_wards,
        "total_wards_in_geojson": len(wards_geo["features"]),
        "unique_grid_cells": len(cell_wards),
        "total_daily_rows_written": total_days,
    }, open(OUT / "manifest.json", "w"), indent=2)

    print(f"Wrote rainfall for {total_wards} wards ({total_days} daily rows) into ../data/rainfall/")
    print(f"wards.geojson patched with rainfall_mm_annual, rainfall_mm_month_current per ward")


if __name__ == "__main__":
    main()
