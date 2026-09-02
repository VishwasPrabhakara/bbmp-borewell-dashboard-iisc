"""
Read ../data/*.json (produced by ../backend/prepare_data.py) and emit chunked SQL files
under ./seed_generated/ that `wrangler d1 execute --file=` can consume.

Usage (from this worker/ folder):
    python seed_d1.py

Then, from the same folder:
    wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/manifest.sql
    wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/wards.sql
    wrangler d1 execute bbmp-borewell-iisc --remote --file=seed_generated/sensors.sql
    # Series files are chunked (~50 sensors per file). Loop over them:
    for f in seed_generated/series/*.sql; do wrangler d1 execute bbmp-borewell-iisc --remote --file="$f"; done
    # Windows PowerShell:
    #   Get-ChildItem seed_generated\series -Filter *.sql | ForEach-Object {
    #     wrangler d1 execute bbmp-borewell-iisc --remote --file=$_.FullName
    #   }

The script escapes single quotes in strings and safely serialises JSON blobs.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"
OUT = ROOT / "seed_generated"
OUT.mkdir(exist_ok=True)
(OUT / "series").mkdir(exist_ok=True)


def sql_str(v):
    if v is None:
        return "NULL"
    s = str(v).replace("'", "''")
    return f"'{s}'"


def sql_num(v):
    if v is None:
        return "NULL"
    return str(v)


def sql_bool(v):
    return "1" if v else "0"


def write(path, statements):
    with open(path, "w", encoding="utf-8") as f:
        f.write("BEGIN;\n")
        for s in statements:
            f.write(s + "\n")
        f.write("COMMIT;\n")


def emit_manifest():
    mf = json.load(open(DATA / "manifest.json"))
    sql = (
        f"DELETE FROM snapshots;\n"
        f"INSERT INTO snapshots (generated_at, kh_zip, sensor_total, sensor_with_data, "
        f"wards, wards_with_data, period_start, period_end) VALUES ("
        f"{sql_str(mf.get('generated_at'))}, {sql_str(mf.get('kh_zip'))}, "
        f"{sql_num(mf.get('sensor_total'))}, {sql_num(mf.get('sensor_with_data'))}, "
        f"{sql_num(mf.get('wards'))}, {sql_num(mf.get('wards_with_data'))}, "
        f"{sql_str(mf.get('period_start'))}, {sql_str(mf.get('period_end'))});"
    )
    write(OUT / "manifest.sql", [sql])


def emit_wards():
    gj = json.load(open(DATA / "wards.geojson"))
    stmts = ["DELETE FROM wards;"]
    for f in gj["features"]:
        p = f["properties"]
        centroid = p.get("centroid") or [None, None]
        stmts.append(
            "INSERT INTO wards (ward_no, ward_name, area_km2, population, households, "
            "sensor_total, sensor_with_data, centroid_lat, centroid_lng, geometry_json) VALUES ("
            f"{sql_num(p.get('ward_no'))}, {sql_str(p.get('ward_name'))}, "
            f"{sql_num(p.get('area_km2'))}, {sql_num(p.get('population'))}, {sql_num(p.get('households'))}, "
            f"{sql_num(p.get('sensor_total'))}, {sql_num(p.get('sensor_with_data'))}, "
            f"{sql_num(centroid[1])}, {sql_num(centroid[0])}, "
            f"{sql_str(json.dumps(f['geometry'], separators=(',', ':')))});"
        )
    write(OUT / "wards.sql", stmts)


def emit_sensors():
    sensors = json.load(open(DATA / "sensors.json"))
    stmts = ["DELETE FROM sensors;"]
    for s in sensors:
        stmts.append(
            "INSERT INTO sensors (uid, lat, lng, ward_no, ward_name, motor_hp, borewell_depth, "
            "pump_name, has_data, reading_count, first_data_at, last_data_at) VALUES ("
            f"{sql_str(s['uid'])}, {sql_num(s.get('lat'))}, {sql_num(s.get('lng'))}, "
            f"{sql_num(s.get('ward_no'))}, {sql_str(s.get('ward_name'))}, "
            f"{sql_num(s.get('motor_hp'))}, {sql_num(s.get('borewell_depth'))}, "
            f"{sql_str(s.get('pump_name'))}, {sql_bool(s.get('has_data'))}, "
            f"{sql_num(s.get('reading_count'))}, {sql_str(s.get('first_data_at'))}, "
            f"{sql_str(s.get('last_data_at'))});"
        )
    write(OUT / "sensors.sql", stmts)


def emit_series(chunk_size=50):
    series_dir = DATA / "sensor_series"
    files = sorted(series_dir.glob("*.json"))
    # First: clear all series in one file so subsequent chunks are inserts only.
    write(OUT / "series" / "00_clear.sql", ["DELETE FROM sensor_series;"])
    batch = []
    idx = 1
    for i, f in enumerate(files, 1):
        s = json.load(open(f))
        batch.append(
            "INSERT INTO sensor_series (uid, unit_water, unit_flow, unit_yield, times_json, water_json, flow_json, yield_json) VALUES ("
            f"{sql_str(s['uid'])}, {sql_str(s.get('unit_water', 'ft below surface'))}, "
            f"{sql_str(s.get('unit_flow', 'L/min'))}, {sql_str(s.get('unit_yield', 'KL'))}, "
            f"{sql_str(json.dumps(s.get('times', []), separators=(',', ':')))}, "
            f"{sql_str(json.dumps(s.get('water_ft', []), separators=(',', ':')))}, "
            f"{sql_str(json.dumps(s.get('flow_lpm', []), separators=(',', ':')))}, "
            f"{sql_str(json.dumps(s.get('yield_kl', []), separators=(',', ':')))}"
            ");"
        )
        if len(batch) >= chunk_size:
            write(OUT / "series" / f"{idx:03d}.sql", batch)
            batch, idx = [], idx + 1
    if batch:
        write(OUT / "series" / f"{idx:03d}.sql", batch)
    print(f"Wrote series chunks: {idx} files under seed_generated/series/")


def main():
    emit_manifest()
    emit_wards()
    emit_sensors()
    emit_series()
    print("Done. Now run wrangler d1 execute on each generated .sql file.")


if __name__ == "__main__":
    main()
