"""Build data/sensor_qc.json from data/sensor_series/*.json + data/sensors.json.

Port of the QC logic from bbmp-borewell-backend/run_sensor_qc.py, adapted for
the static-site pipeline: no DB, just reads local JSON files.

Emits per-sensor rows matching the earlier dashboard's schema:
  {uid, qc_status, overall_qc_score, flags[], coverage_score, range_score,
   stability_score, recent_data_score, total_readings, first_data_at, last_data_at}

qc_status:  GOOD | USABLE_WITH_CAUTION | POOR | INSUFFICIENT_DATA | NO_DATA
flags:      STALE_DATA | LONG_GAPS | SPIKES | FLATLINES | RANGE_ERRORS |
            DUPLICATE_TIMESTAMPS | TOO_FEW_READINGS
"""
import datetime as dt
import glob
import json
import os
from collections import Counter
from pathlib import Path

# --- Thresholds (aligned with bbmp-borewell-backend/run_sensor_qc.py) ---
RECENT_GOOD_DAYS = 14
RECENT_POOR_DAYS = 60
MAX_WATER_LEVEL_FT = 1500
MAX_DISCHARGE_LPM = 20000
LONG_GAP_HOURS = 72
FLATLINE_RUN_LENGTH = 10
MAX_WATER_JUMP_FT_PER_DAY = 200
MAX_DISCHARGE_JUMP_LPM = 500

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data"


def freshness_score(stale_days):
    if stale_days is None: return 0
    if stale_days <= RECENT_GOOD_DAYS: return 100
    if stale_days >= RECENT_POOR_DAYS: return 0
    return round(100 * (RECENT_POOR_DAYS - stale_days) /
                 (RECENT_POOR_DAYS - RECENT_GOOD_DAYS), 2)


def coverage_score(total_readings, days_span):
    if total_readings <= 0: return 0
    if days_span <= 0: return min(100, total_readings * 10)
    per_day = total_readings / max(days_span, 1)
    if per_day >= 1: return 100
    return round(per_day * 100, 2)


def status_from_score(score, total_readings):
    if total_readings == 0: return "NO_DATA"
    if total_readings < 10: return "INSUFFICIENT_DATA"
    if score >= 80: return "GOOD"
    if score >= 55: return "USABLE_WITH_CAUTION"
    return "POOR"


def analyze(times, water_ft, flow_lpm, now):
    n = len(times)
    if n == 0:
        return {
            "total_readings": 0, "first_data_at": None, "last_data_at": None,
            "coverage_score": 0, "range_score": 0, "stability_score": 0,
            "recent_data_score": 0, "overall_qc_score": 0,
            "flags": ["NO_DATA"],
        }

    flags = set()
    ts = [dt.datetime.fromisoformat(t) if isinstance(t, str) else t for t in times]

    # duplicate timestamps
    counts = Counter(ts)
    dup = sum(c - 1 for c in counts.values() if c > 1)
    if dup: flags.add("DUPLICATE_TIMESTAMPS")

    first, last = min(ts), max(ts)
    stale_days = (now - last).total_seconds() / 86400
    if stale_days > RECENT_POOR_DAYS: flags.add("STALE_DATA")

    # range errors (out-of-bounds water level or discharge)
    range_err = 0
    for v in water_ft:
        if v is None: continue
        if v < 0 or v > MAX_WATER_LEVEL_FT: range_err += 1
    for v in flow_lpm:
        if v is None: continue
        if v < 0 or v > MAX_DISCHARGE_LPM: range_err += 1
    if range_err: flags.add("RANGE_ERRORS")
    range_score = round(max(0, 100 - (range_err / n) * 100), 2) if n else 0

    # long gaps + spikes
    gap_count = 0
    spike_count = 0
    prev_t, prev_w, prev_f = None, None, None
    for t, w, f in zip(ts, water_ft, flow_lpm):
        if prev_t is not None:
            gap_h = (t - prev_t).total_seconds() / 3600
            if gap_h > LONG_GAP_HOURS: gap_count += 1
            if gap_h > 0:
                if prev_w is not None and w is not None:
                    ft_per_day = abs(w - prev_w) / (gap_h / 24)
                    if ft_per_day > MAX_WATER_JUMP_FT_PER_DAY: spike_count += 1
                if prev_f is not None and f is not None:
                    if abs(f - prev_f) > MAX_DISCHARGE_JUMP_LPM: spike_count += 1
        prev_t, prev_w, prev_f = t, w, f
    if gap_count: flags.add("LONG_GAPS")
    if spike_count: flags.add("SPIKES")

    # flatlines (10+ identical consecutive readings on either channel)
    flat_count = 0
    for series in (water_ft, flow_lpm):
        run_val, run_len = None, 0
        for v in series:
            if v is None:
                if run_len >= FLATLINE_RUN_LENGTH: flat_count += run_len
                run_val, run_len = None, 0
                continue
            r = round(v, 2)
            if r == run_val: run_len += 1
            else:
                if run_len >= FLATLINE_RUN_LENGTH: flat_count += run_len
                run_val, run_len = r, 1
        if run_len >= FLATLINE_RUN_LENGTH: flat_count += run_len
    if flat_count: flags.add("FLATLINES")

    if n < 10: flags.add("TOO_FEW_READINGS")

    days_span = max((last - first).total_seconds() / 86400, 0)
    cov = coverage_score(n, days_span)
    stab = round(max(0,
        100 - ((spike_count + flat_count / max(1, FLATLINE_RUN_LENGTH)) / n) * 100), 2)
    recent = freshness_score(stale_days)
    overall = round(0.25 * cov + 0.25 * range_score + 0.25 * stab + 0.25 * recent, 2)

    return {
        "total_readings": n,
        "first_data_at": first.isoformat(), "last_data_at": last.isoformat(),
        "coverage_score": cov, "range_score": range_score,
        "stability_score": stab, "recent_data_score": recent,
        "overall_qc_score": overall, "flags": sorted(flags),
    }


def main():
    now = dt.datetime.utcnow()
    sensors = json.load(open(DATA / "sensors.json"))
    print(f"Loaded {len(sensors)} sensors from sensors.json")

    series_files = {}
    for fp in glob.glob(str(DATA / "sensor_series" / "*.json")):
        series_files[Path(fp).stem] = fp
    print(f"Found {len(series_files)} sensor_series files")

    rows = []
    counts = Counter()
    for i, s in enumerate(sensors, 1):
        uid = str(s["uid"])
        fp = series_files.get(uid)
        if fp:
            try:
                d = json.load(open(fp))
                stats = analyze(d.get("times", []), d.get("water_ft", []),
                                d.get("flow_lpm", []), now)
            except Exception as e:
                stats = analyze([], [], [], now)
                stats["flags"] = sorted(set(stats["flags"] + [f"READ_ERROR:{e.__class__.__name__}"]))
        else:
            stats = analyze([], [], [], now)
        status = status_from_score(stats["overall_qc_score"], stats["total_readings"])
        row = {"uid": uid, "qc_status": status, **stats}
        rows.append(row)
        counts[status] += 1
        if i % 200 == 0:
            print(f"  processed {i}/{len(sensors)}")

    summary = {
        "generated_at": now.isoformat() + "Z",
        "sensor_total": len(rows),
        "by_status": dict(counts),
        "thresholds": {
            "RECENT_GOOD_DAYS": RECENT_GOOD_DAYS,
            "RECENT_POOR_DAYS": RECENT_POOR_DAYS,
            "MAX_WATER_LEVEL_FT": MAX_WATER_LEVEL_FT,
            "MAX_DISCHARGE_LPM": MAX_DISCHARGE_LPM,
            "LONG_GAP_HOURS": LONG_GAP_HOURS,
            "FLATLINE_RUN_LENGTH": FLATLINE_RUN_LENGTH,
        },
    }
    out = {"summary": summary, "sensors": rows}
    with open(DATA / "sensor_qc.json", "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("Wrote", DATA / "sensor_qc.json")
    print("By status:", dict(counts))


if __name__ == "__main__":
    main()
