"""
Dump the `sensors` table (from your existing bbmp-borewell-backend Postgres DB) to
../data/sensors_db.json so prepare_data.py can pick up motor_hp, borewell_depth,
pump_name, and the full list of KH-known UIDs.

Reads DATABASE_URL from either:
  1) the DATABASE_URL environment variable, or
  2) ../.env  (a plain KEY=VALUE file, same shape as bbmp-borewell-backend/.env)

Run this ONCE from your Windows machine (network to Neon Postgres works there).
"""
import json
import os
from pathlib import Path

from sqlalchemy import create_engine, text

ROOT = Path(__file__).resolve().parent
OUT = ROOT.parent / "data" / "sensors_db.json"


def load_env():
    env = ROOT.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main():
    load_env()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("Set DATABASE_URL in environment or in Dashboard_IISC_for_BWSSB/.env")

    engine = create_engine(url)
    with engine.connect() as c:
        rows = c.execute(text("""
            SELECT uid, lat, lng, ward_no, ward_name, motor_hp, borewell_depth, pump_name,
                   first_data_at, last_data_at, total_readings
            FROM sensors ORDER BY uid
        """)).mappings().all()

    out = []
    for r in rows:
        d = dict(r)
        for k in ("lat", "lng", "motor_hp", "borewell_depth"):
            if d.get(k) is not None:
                d[k] = float(d[k])
        for k in ("first_data_at", "last_data_at"):
            if d.get(k) is not None:
                d[k] = d[k].isoformat()
        out.append(d)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f)
    print(f"Wrote {OUT} ({len(out)} sensors)")


if __name__ == "__main__":
    main()
