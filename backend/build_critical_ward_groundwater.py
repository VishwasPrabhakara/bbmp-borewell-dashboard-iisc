"""Rebuild data/critical_groundwater_ward_summary.json from the current
579-sensor snapshot, so only wards that actually have data get classified.

Inputs (all local JSON, no DB):
  data/sensors.json           uid -> ward_no, ward_name
  data/sensor_qc.json         per-sensor QC status (GOOD / USABLE / POOR / ...)
  data/sensor_series/*.json   per-sensor water-level series
  data/critical_groundwater_ward_summary.json   (existing, only for preserving
                              `previousCriticalWard` flag from the CGWB source)

Output:
  data/critical_groundwater_ward_summary.json   REPLACED

Per ward:
  1. Keep sensors with QC status in {GOOD, USABLE_WITH_CAUTION}.
  2. Build per-sensor WEEKLY medians of water_ft (ISO week).
  3. Aggregate to ward weekly median across sensors.
  4. Fit Linear slope (OLS) and Theil-Sen slope on week-index vs level.
  5. Compute Mann-Kendall S statistic + z-score + verdict at alpha = 0.05.
  6. Emit fields consumed by js/app.js -> calculateGroundwaterCriticality():
       linearSlopeFtPerWeek, senSlopeFtPerWeek, mannKendallVerdict,
       linearMannKendallCritical, theilSenMannKendallCritical,
       dashboardAction, groundwaterStatus, groundwaterDirection,
       dashboardMapCategory, previousCriticalWard, ...
     Water level is feet BELOW ground surface, so slope > 0 = deepening (bad).
"""
import datetime as dt
import glob
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DATA = REPO / "data"

USABLE_QC = {"GOOD", "USABLE_WITH_CAUTION"}
MIN_WEEKLY_POINTS = 4                   # need >= 4 weekly points to trust a trend
SIGNIFICANT_SLOPE_FT_PER_WEEK = 0.02    # ~1 ft / year sustained rate is meaningful
MK_ALPHA = 0.05                         # two-sided


# ---------- statistics ----------

def linear_slope(xs, ys):
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    denom = sum((x - mx) ** 2 for x in xs)
    if denom == 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / denom


def theil_sen_slope(xs, ys):
    slopes = []
    n = len(xs)
    for i in range(n):
        for j in range(i + 1, n):
            dx = xs[j] - xs[i]
            if dx == 0:
                continue
            slopes.append((ys[j] - ys[i]) / dx)
    return statistics.median(slopes) if slopes else None


def mann_kendall(ys):
    """Return (S, z, p, verdict) for a two-sided MK test on ys.
    verdict = "Yes" if p < MK_ALPHA else "No".
    """
    n = len(ys)
    if n < 4:
        return 0, 0.0, 1.0, "No"
    s = 0
    for i in range(n):
        for j in range(i + 1, n):
            d = ys[j] - ys[i]
            if d > 0:
                s += 1
            elif d < 0:
                s -= 1
    # tie correction
    from collections import Counter
    ties = Counter(ys)
    tie_sum = sum(t * (t - 1) * (2 * t + 5) for t in ties.values() if t > 1)
    var_s = (n * (n - 1) * (2 * n + 5) - tie_sum) / 18.0
    if var_s <= 0:
        return s, 0.0, 1.0, "No"
    if s > 0:
        z = (s - 1) / math.sqrt(var_s)
    elif s < 0:
        z = (s + 1) / math.sqrt(var_s)
    else:
        z = 0.0
    # two-sided p from normal
    p = 2.0 * (1.0 - _phi(abs(z)))
    verdict = "Yes" if p < MK_ALPHA else "No"
    return s, round(z, 3), round(p, 4), verdict


def _phi(x):
    """Standard normal CDF using erf."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2)))


# ---------- weekly aggregation ----------

def iso_week_key(ts):
    """Return (iso_year, iso_week) tuple for grouping."""
    iso = ts.isocalendar()
    return (iso[0], iso[1])


def sensor_weekly_series(times, water_ft):
    """Median water level per ISO week for one sensor."""
    weekly = defaultdict(list)
    for t, v in zip(times, water_ft):
        if v is None:
            continue
        ts = dt.datetime.fromisoformat(t) if isinstance(t, str) else t
        weekly[iso_week_key(ts)].append(float(v))
    return {wk: statistics.median(vs) for wk, vs in weekly.items()}


# ---------- main pipeline ----------

def main():
    print("Loading inputs...")
    sensors = json.load(open(DATA / "sensors.json"))
    qc_payload = json.load(open(DATA / "sensor_qc.json"))
    qc_by_uid = {str(r["uid"]): r for r in qc_payload["sensors"]}

    # preserve CGWB flag from previous file
    prev_by_no = {}
    prev_path = DATA / "critical_groundwater_ward_summary.json"
    if prev_path.exists():
        prev = json.load(open(prev_path))
        for row in prev.get("wards", []):
            wn = str(row.get("wardNo") or row.get("ward_no") or "").strip()
            if wn:
                prev_by_no[wn] = row
        print(f"  preserved {len(prev_by_no)} prior ward rows (for previousCriticalWard flag)")

    # sensors grouped by ward
    sensors_by_ward = defaultdict(list)
    ward_name_by_no = {}
    for s in sensors:
        wn = s.get("ward_no")
        if wn is None or wn == "":
            continue
        wn_s = str(int(wn)) if isinstance(wn, (int, float)) else str(wn).strip()
        sensors_by_ward[wn_s].append(s)
        if s.get("ward_name"):
            ward_name_by_no[wn_s] = s["ward_name"]

    print(f"  {len(sensors)} sensors across {len(sensors_by_ward)} wards")

    # index sensor_series filenames
    series_files = {Path(fp).stem: fp for fp in glob.glob(str(DATA / "sensor_series" / "*.json"))}

    output_wards = []
    kept = 0
    for wn, wsensors in sorted(sensors_by_ward.items(), key=lambda kv: int(kv[0]) if kv[0].isdigit() else 999):
        total_sensors = len(wsensors)
        good_uids = [str(s["uid"]) for s in wsensors
                     if qc_by_uid.get(str(s["uid"]), {}).get("qc_status") in USABLE_QC]
        good_sensors = len(good_uids)

        # ward weekly medians = median across good sensors, per ISO week
        weekly_bag = defaultdict(list)
        point_count = 0
        for uid in good_uids:
            fp = series_files.get(uid)
            if not fp:
                continue
            d = json.load(open(fp))
            times = d.get("times", [])
            waters = d.get("water_ft", [])
            per_sensor = sensor_weekly_series(times, waters)
            point_count += sum(1 for v in waters if v is not None)
            for wk, med in per_sensor.items():
                weekly_bag[wk].append(med)

        weekly_series = {wk: statistics.median(vs) for wk, vs in weekly_bag.items()}
        usable_weekly = len(weekly_series)

        prev_row = prev_by_no.get(wn, {})
        previous_critical = prev_row.get("previousCriticalWard", "No") or "No"
        previous_critical_name = prev_row.get("previousCriticalWardName", "") or ""

        ward_name = ward_name_by_no.get(wn) or prev_row.get("wardName") or ""

        row = {
            "wardNo": wn,
            "wardName": ward_name,
            "totalSensors": total_sensors,
            "goodSensors": good_sensors,
            "usableWeeklyValues": usable_weekly,
            "pointCount": point_count,
            "previousCriticalWard": previous_critical,
            "previousCriticalWardName": previous_critical_name,
        }

        if usable_weekly < MIN_WEEKLY_POINTS:
            row.update({
                "linearSlopeFtPerWeek": None,
                "senSlopeFtPerWeek": None,
                "declineStrengthFtPerWeek": None,
                "mannKendallVerdict": "No",
                "mannKendallS": 0, "mannKendallZ": 0.0, "mannKendallP": 1.0,
                "linearMannKendallCritical": "No",
                "theilSenMannKendallCritical": "No",
                "groundwaterStatus": "Insufficient data",
                "groundwaterDirection": "Not computed",
                "dashboardAction": "No",
                "dashboardMapCategory": "Insufficient data",
                "updateReason": f"Only {usable_weekly} usable weekly value(s); need >= {MIN_WEEKLY_POINTS}.",
            })
            output_wards.append(row)
            continue

        # convert to week-index x, level y
        weeks_sorted = sorted(weekly_series.keys())
        xs = list(range(len(weeks_sorted)))
        ys = [weekly_series[wk] for wk in weeks_sorted]

        lin_slope = linear_slope(xs, ys)
        sen_slope = theil_sen_slope(xs, ys)
        mk_s, mk_z, mk_p, mk_verdict = mann_kendall(ys)

        lin_critical = (lin_slope is not None
                        and lin_slope > SIGNIFICANT_SLOPE_FT_PER_WEEK
                        and mk_verdict == "Yes")
        sen_critical = (sen_slope is not None
                        and sen_slope > SIGNIFICANT_SLOPE_FT_PER_WEEK
                        and mk_verdict == "Yes")

        # rise/improvement (levels moving toward surface = slope < 0)
        lin_rising = lin_slope is not None and lin_slope < -SIGNIFICANT_SLOPE_FT_PER_WEEK
        sen_rising = sen_slope is not None and sen_slope < -SIGNIFICANT_SLOPE_FT_PER_WEEK

        if lin_critical or sen_critical:
            status = "Critical"
            direction = "Declining"
            action = "Yes"
            category = "Critical: Ward-average groundwater decline"
            reason = f"Weekly slope +{max((lin_slope or 0), (sen_slope or 0)):.3f} ft/week with MK verdict {mk_verdict}."
        elif (lin_rising and sen_rising) and mk_verdict == "Yes":
            status = "Normal"
            direction = "Improving"
            action = "No"
            category = "Confirmed groundwater rise"
            reason = "Both linear and Theil-Sen slopes are negative with Mann-Kendall significance; groundwater level rising."
        elif lin_rising or sen_rising:
            status = "Normal"
            direction = "Possible improvement"
            action = "No"
            category = "Possible groundwater rise"
            reason = "One of the two slopes indicates a possible rise; not yet confirmed by Mann-Kendall."
        else:
            status = "Normal"
            direction = "Stable"
            action = "No"
            category = "Stable groundwater trend"
            reason = "Weekly slopes are near zero; groundwater level appears stable."

        row.update({
            "linearSlopeFtPerWeek": round(lin_slope, 4) if lin_slope is not None else None,
            "senSlopeFtPerWeek": round(sen_slope, 4) if sen_slope is not None else None,
            "declineStrengthFtPerWeek": round(max(lin_slope or 0, sen_slope or 0), 4),
            "mannKendallVerdict": mk_verdict,
            "mannKendallS": mk_s, "mannKendallZ": mk_z, "mannKendallP": mk_p,
            "linearMannKendallCritical": "Yes" if lin_critical else "No",
            "theilSenMannKendallCritical": "Yes" if sen_critical else "No",
            "groundwaterStatus": status,
            "groundwaterDirection": direction,
            "dashboardAction": action,
            "dashboardMapCategory": category,
            "updateReason": reason,
        })
        output_wards.append(row)
        kept += 1

    from collections import Counter
    cat_counts = Counter(r["dashboardMapCategory"] for r in output_wards)
    dir_counts = Counter(r["groundwaterDirection"] for r in output_wards)
    payload = {
        "generated_at": dt.datetime.utcnow().isoformat() + "Z",
        "min_weekly_points": MIN_WEEKLY_POINTS,
        "significant_slope_ft_per_week": SIGNIFICANT_SLOPE_FT_PER_WEEK,
        "mk_alpha": MK_ALPHA,
        "ward_total": len(output_wards),
        "ward_with_trend": kept,
        "by_dashboard_category": dict(cat_counts),
        "by_direction": dict(dir_counts),
        "wards": output_wards,
    }
    with open(DATA / "critical_groundwater_ward_summary.json", "w") as f:
        json.dump(payload, f, separators=(",", ":"))
    print(f"Wrote {DATA / 'critical_groundwater_ward_summary.json'}")
    print(f"  ward_total: {len(output_wards)}   ward_with_trend: {kept}")
    print(f"  by_dashboard_category: {dict(cat_counts)}")
    print(f"  by_direction: {dict(dir_counts)}")


if __name__ == "__main__":
    main()
