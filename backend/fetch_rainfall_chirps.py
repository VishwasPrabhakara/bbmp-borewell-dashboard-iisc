"""
Fetch per-ward rainfall from CHIRPS (~5.5 km resolution) via the ClimateSERV API.

Free, no key required. CHIRPS is a satellite+gauge blended product from UCSB.
Docs: https://climateserv.servirglobal.net/help/climateserv-api

CHIRPS lags by ~40 days from real-time (their operational monthly release
cadence). If today - end_gap > available data, the script falls back to the
last CHIRPS-available date. So "trailing 12 months" here means "trailing 12
months of the most recent CHIRPS-available window".

Same output shape as the other fetch_rainfall_*.py scripts.

Run:
    cd backend && python fetch_rainfall_chirps.py
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

BASE = "https://climateserv.servirglobal.net/api"
SOURCE_LABEL = "CHIRPS via ClimateSERV (~5.5 km)"
DAYS_BACK = 365
CHIRPS_LAG_DAYS = 45   # CHIRPS is usually behind by ~40 days; be safe.


def submit_job(lat, lng, start, end):
    # A small square around the point, ~0.05° = ~5 km side
    d = 0.025
    geom = [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]]
    params = {
        "datatype": 0,                       # CHIRPS daily
        "begintime": start.strftime("%m/%d/%Y"),
        "endtime": end.strftime("%m/%d/%Y"),
        "intervaltype": 0,                   # daily
        "operationtype": 5,                  # average
        "dateType_Category": "default",
        "isZip_CurrentDataType": "false",
        "geometry": json.dumps(geom),
    }
    r = requests.get(f"{BASE}/submitDataRequest/", params=params, timeout=60)
    r.raise_for_status()
    text = r.text.strip().strip('"').strip("[]").strip('"')
    return text


def wait_job(job_id, max_wait_s=300):
    t0 = time.time()
    while time.time() - t0 < max_wait_s:
        r = requests.get(f"{BASE}/getDataRequestProgress/", params={"id": job_id}, timeout=30)
        try:
            progress = float(r.text.strip())
        except ValueError:
            progress = -1
        if progress >= 100:
            return True
        time.sleep(2)
    return False


def get_result(job_id):
    r = requests.get(f"{BASE}/getDataFromRequest/", params={"id": job_id}, timeout=60)
    r.raise_for_status()
    j = r.json()
    # Shape: {"data": [{"date":"MM/DD/YYYY","value": [{"avg": <mm>, ...}]}, ...]}
    daily = []
    for row in (j.get("data") or []):
        d = dt.datetime.strptime(row["date"], "%m/%d/%Y").date().isoformat()
        vals = row.get("value") or []
        v = None
        for item in vals:
            if "avg" in item:
                v = float(item["avg"])
                break
        daily.append({"date": d, "rainfall_mm": v})
    return sorted(daily, key=lambda x: x["date"])


def to_monthly(daily):
    by = defaultdict(float)
    for r in daily:
        if r["rainfall_mm"] is not None:
            by[r["date"][:7]] += r["rainfall_mm"]
    return [{"month": m, "rainfall_mm": round(v, 2)} for m, v in sorted(by.items())]


def current_month_total(daily):
    prefix = dt.date.today().strftime("%Y-%m")
    total = sum((r["rainfall_mm"] or 0) for r in daily if r["date"].startswith(prefix))
    return round(total, 2)


def main():
    end = dt.date.today() - dt.timedelta(days=CHIRPS_LAG_DAYS)
    start = end - dt.timedelta(days=DAYS_BACK - 1)
    print(f"Source: {SOURCE_LABEL}")
    print(f"Window: {start} -> {end}  (CHIRPS is ~{CHIRPS_LAG_DAYS} days behind real-time)")

    wards_geo = json.load(open(DATA / "wards.geojson"))
    # CHIRPS is ~5.5 km, round centroid to 0.05
    cell_wards = defaultdict(list)
    for f in wards_geo["features"]:
        c = f["properties"].get("centroid")
        if not c: continue
        cell_wards[(round(c[1], 2), round(c[0], 2))].append(f)
    print(f"{len(cell_wards)} unique query points across {sum(len(v) for v in cell_wards.values())} wards")

    cell_daily = {}
    for i, (key, feats) in enumerate(cell_wards.items(), 1):
        lat, lng = key
        print(f"  ({i}/{len(cell_wards)}) submitting for lat={lat}, lng={lng} ...", end=" ", flush=True)
        try:
            job = submit_job(lat, lng, start, end)
            print(f"job {job}", end="; ", flush=True)
            if not wait_job(job):
                print("timeout"); continue
            daily = get_result(job)
            cell_daily[key] = daily
            print(f"{len(daily)} days")
        except Exception as e:
            print(f"fail: {e}")
        time.sleep(1)   # be gentle

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
