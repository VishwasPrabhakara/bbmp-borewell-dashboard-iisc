"""Build data/current_stress_ward_summary.json — per-well current-stress
percentile aggregated to ward level."""
import json, glob, statistics, datetime as dt
from pathlib import Path
from collections import defaultdict

DATA = Path(__file__).resolve().parents[1] / "data"
STATIC_GAP_HOURS = 8
USABLE_QC = {"GOOD", "USABLE_WITH_CAUTION"}


def static_water_levels(times, waters, min_gap_h=STATIC_GAP_HOURS):
    if not times: return []
    out = []; prev = None
    for t, v in zip(times, waters):
        ts = dt.datetime.fromisoformat(t) if isinstance(t, str) else t
        if prev is not None and v is not None:
            if (ts - prev).total_seconds() / 3600.0 >= min_gap_h:
                out.append((ts, v))
        prev = ts
    return out


def percentile_of(sorted_vals, x):
    n = len(sorted_vals)
    if n == 0: return None
    below = sum(1 for v in sorted_vals if v < x)
    equal = sum(1 for v in sorted_vals if v == x)
    return 100.0 * (below + 0.5 * equal) / n


def stress_category(p):
    if p is None: return "Insufficient data"
    if p >= 80: return "Critical: Currently deeper than 80% of own history"
    if p >= 60: return "Elevated: Currently deeper than 60% of own history"
    if p >= 40: return "Normal: Around own historical median"
    return "Below normal: Currently recovered/shallow"


def main():
    print("Loading inputs...")
    sensors = json.load(open(DATA / "sensors.json"))
    qc_payload = json.load(open(DATA / "sensor_qc.json"))
    qc_by = {str(r["uid"]): r for r in qc_payload["sensors"]}
    series_files = {Path(fp).stem: fp for fp in glob.glob(str(DATA / "sensor_series" / "*.json"))}
    ward_wells = defaultdict(list); ward_name = {}
    now = dt.datetime.utcnow(); lookback = now - dt.timedelta(days=30)
    for s in sensors:
        wn = s.get("ward_no")
        if wn is None or wn == "": continue
        wn_s = str(int(wn)) if isinstance(wn, (int, float)) else str(wn).strip()
        if s.get("ward_name"): ward_name[wn_s] = s["ward_name"]
        uid = str(s["uid"])
        if qc_by.get(uid, {}).get("qc_status") not in USABLE_QC: continue
        fp = series_files.get(uid)
        if not fp: continue
        d = json.load(open(fp))
        static_pts = static_water_levels(d.get("times", []), d.get("water_ft", []))
        if len(static_pts) < 30: continue
        levels = sorted(v for _, v in static_pts)
        recent = [v for t, v in static_pts if t >= lookback]
        if not recent: continue
        current = statistics.median(recent)
        p = percentile_of(levels, current)
        ward_wells[wn_s].append({"uid": uid, "current_ft": round(current, 1),
                                 "own_min_ft": round(levels[0], 1),
                                 "own_max_ft": round(levels[-1], 1),
                                 "stress_percentile": round(p, 1),
                                 "n_static": len(levels), "n_recent": len(recent)})
    output = []
    for wn in sorted(ward_wells, key=lambda k: int(k) if k.isdigit() else 999):
        wells = ward_wells[wn]
        pcts = [w["stress_percentile"] for w in wells if w["stress_percentile"] is not None]
        ward_p = statistics.median(pcts) if pcts else None
        output.append({"wardNo": wn, "wardName": ward_name.get(wn, ""),
                       "wellCount": len(wells),
                       "stressPercentileMedian": round(ward_p, 1) if ward_p is not None else None,
                       "stressCategory": stress_category(ward_p), "wells": wells})
    from collections import Counter
    cat_counts = Counter(r["stressCategory"] for r in output)
    payload = {"generated_at": now.isoformat() + "Z",
               "static_gap_hours": STATIC_GAP_HOURS, "lookback_days": 30,
               "ward_total": len(output), "by_stress_category": dict(cat_counts),
               "wards": output}
    with open(DATA / "current_stress_ward_summary.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote current_stress_ward_summary.json")
    print(f"  ward_total: {len(output)}")
    print(f"  by_stress_category: {dict(cat_counts)}")


if __name__ == "__main__":
    main()
