"""
Fetch per-ward rainfall from KSNDMC (Karnataka State Natural Disaster Monitoring Centre).

KSNDMC operates ~1500 telemetric rain gauges across Karnataka, many inside
Bangalore. This is REAL GAUGE DATA — the gold standard for per-ward rainfall.

**This script is a scaffold — KSNDMC does not publish a stable public API.**
You need to find their live endpoint(s) with browser DevTools once, then paste
the URL + response-parsing lines into fetch_gauge_daily() below.

How to find the KSNDMC endpoint (one-time, ~15 min):

  1. Open https://www.ksndmc.org/ in Chrome (or your desktop browser).
  2. Click "BBMP Dashboard" (in Kannada: ಬಿಬಿಎಂಪಿ ಡ್ಯಾಶ್‌ಬೋರ್ಡ್).
     If that link opens a Kannada page with rainfall maps/tables, you're on the
     right page. If it redirects to a login, use their public URL instead:
     http://gis.ksndmc.org/  (unauthenticated public map).
  3. Open DevTools (F12) -> Network tab -> filter by "Fetch/XHR".
  4. Change the date range / hit "refresh" on the page. Watch the Network tab
     for the JSON/XHR call that fires when the map/table updates. It's usually
     a URL like:
       http://gis.ksndmc.org/api/...
       http://services.ksndmc.org/...
       http://125.20.13.94/GISHome/...
  5. Right-click that request -> Copy -> Copy as cURL. Paste it into a
     scratch file — you now have the exact URL, headers, cookies.
  6. Inspect the response JSON to find:
       - the station list (id, name, lat, lng)
       - the daily rainfall values (usually an array of {date, value})
  7. Fill in the two functions below (fetch_stations, fetch_gauge_daily) with
     the exact URLs and JSON keys.
  8. Everything else — station-to-ward assignment, JSON output, wards.geojson
     patching — is already done.

Also useful: KSNDMC's Varuna Mitra system publishes daily rainfall bulletins
in PDF form at http://www.ksndmc.org/DailyRainfall.aspx and their Twitter feed
@ksndmc has ward-level updates during monsoon. Those are harder to parse but
authoritative.

Same output shape as the other fetch_rainfall_*.py scripts, so once wired the
dashboard picks up KSNDMC values automatically.

Run:
    cd backend && python fetch_rainfall_ksndmc.py
"""
import datetime as dt
import json
from collections import defaultdict
from math import radians, sin, cos, asin, sqrt
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"
OUT = DATA / "rainfall"
OUT.mkdir(parents=True, exist_ok=True)

SOURCE_LABEL = "KSNDMC telemetric rain gauges"
DAYS_BACK = 365


# ---------------------------------------------------------------------------
# TODO(you): FILL THESE TWO FUNCTIONS AFTER YOU INSPECT KSNDMC IN DEVTOOLS
# ---------------------------------------------------------------------------

def fetch_stations():
    """Return list of {id, name, lat, lng} for all KSNDMC stations in Bangalore.

    Example implementation once you find the endpoint:

        url = "http://gis.ksndmc.org/api/stations?district=Bengaluru"
        r = requests.get(url, timeout=60); r.raise_for_status()
        stations = []
        for row in r.json()["features"]:
            p = row["properties"]
            g = row["geometry"]["coordinates"]
            stations.append({"id": p["stnId"], "name": p["stnName"], "lat": g[1], "lng": g[0]})
        return stations
    """
    raise NotImplementedError(
        "fetch_stations() not wired yet — see the docstring at top of file "
        "for step-by-step DevTools instructions to find the KSNDMC endpoint."
    )


def fetch_gauge_daily(station_id, start, end):
    """Return [{date, rainfall_mm}] for one station across the date range.

    Example implementation once you find the endpoint:

        url = "http://gis.ksndmc.org/api/dailyRainfall"
        r = requests.get(url, params={
            "stationId": station_id,
            "from": start.strftime("%d-%m-%Y"),
            "to":   end.strftime("%d-%m-%Y"),
        }, timeout=60)
        r.raise_for_status()
        out = []
        for row in r.json()["data"]:
            d = dt.datetime.strptime(row["date"], "%d-%m-%Y").date().isoformat()
            v = None if row["rainfall"] in ("", "NA", None) else float(row["rainfall"])
            out.append({"date": d, "rainfall_mm": v})
        return out
    """
    raise NotImplementedError("fetch_gauge_daily() not wired yet — see docstring.")


# ---------------------------------------------------------------------------
# EVERYTHING BELOW IS DONE — no edits needed once the two functions above work.
# ---------------------------------------------------------------------------

def haversine_km(a, b):
    lat1, lon1 = radians(a[0]), radians(a[1])
    lat2, lon2 = radians(b[0]), radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    return 2 * 6371 * asin(sqrt(h))


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

    print("Loading KSNDMC station list...")
    stations = fetch_stations()
    print(f"  {len(stations)} stations")

    # Cache per-station daily so we don't refetch when many wards share a nearest station
    station_daily = {}

    wards_geo = json.load(open(DATA / "wards.geojson"))
    written = total = 0
    for f in wards_geo["features"]:
        c = f["properties"].get("centroid"); wn = f["properties"].get("ward_no")
        if not c or wn is None: continue
        ward_pt = (c[1], c[0])
        # nearest station by haversine
        nearest = min(stations, key=lambda s: haversine_km(ward_pt, (s["lat"], s["lng"])))
        dist = haversine_km(ward_pt, (nearest["lat"], nearest["lng"]))

        if nearest["id"] not in station_daily:
            print(f"  fetching station {nearest['id']} ({nearest['name']}) ...")
            station_daily[nearest["id"]] = fetch_gauge_daily(nearest["id"], start, end)
        daily = station_daily[nearest["id"]]
        if not daily: continue

        monthly = to_monthly(daily)
        annual = round(sum((r["rainfall_mm"] or 0) for r in daily), 2)
        with open(OUT / f"{wn}.json", "w") as fh:
            json.dump({
                "ward_no": wn, "ward_name": f["properties"].get("ward_name") or "",
                "source": SOURCE_LABEL,
                "start": start.isoformat(), "end": end.isoformat(),
                "station": {"id": nearest["id"], "name": nearest["name"],
                            "lat": nearest["lat"], "lng": nearest["lng"], "distance_km": round(dist, 2)},
                "daily": daily, "monthly": monthly,
                "annual_total_mm": annual, "current_month_mm": current_month_total(daily),
            }, fh)
        f["properties"]["rainfall_mm_annual"] = annual
        f["properties"]["rainfall_mm_month_current"] = current_month_total(daily)
        f["properties"]["rainfall_updated_at"] = dt.datetime.utcnow().isoformat() + "Z"
        f["properties"]["rainfall_source"] = SOURCE_LABEL
        f["properties"]["rainfall_station"] = nearest["name"]
        f["properties"]["rainfall_station_distance_km"] = round(dist, 2)
        written += 1; total += len(daily)

    json.dump(wards_geo, open(DATA / "wards.geojson", "w"))
    json.dump({
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "source": SOURCE_LABEL,
        "start": start.isoformat(), "end": end.isoformat(),
        "wards": written, "stations_used": len(station_daily), "daily_rows": total,
    }, open(OUT / "manifest.json", "w"), indent=2)
    print(f"Done. {written} wards from {len(station_daily)} stations, {total} daily rows.")


if __name__ == "__main__":
    main()
