# data/

Generated JSON snapshot the dashboard reads. **Regenerate with `backend/prepare_data.py`; do not hand-edit.**

## Files

| File | What it is |
|---|---|
| `manifest.json` | Snapshot metadata: KH ZIP name, generation time, sensor + ward counts, period start/end. |
| `wards.geojson` | GeoJSON FeatureCollection of 198 BBMP ward polygons. Properties: `ward_no`, `ward_name`, `area_km2`, `population`, `households`, `sensor_total`, `sensor_with_data`, `centroid`. |
| `sensors.json` | Array of every sensor. Fields: `uid`, `lat`, `lng`, `ward_no`, `ward_name`, `motor_hp`, `borewell_depth`, `pump_name`, `has_data` (bool), `reading_count`, `first_data_at`, `last_data_at`. |
| `sensor_series/<uid>.json` | Per-sensor time series (only for sensors present in the current KH ZIP). Fields: `uid`, `unit_water`, `unit_flow`, `unit_yield`, `times[]` (ISO strings), `water_ft[]`, `flow_lpm[]`, `yield_kl[]`. |
| `sensors_db.json` | Optional. Extra sensor metadata pulled from your Neon Postgres DB (motor HP / borewell depth for the full KH sensor inventory). Not consumed by the dashboard directly — `prepare_data.py` merges it into `sensors.json`. |

## Size expectations

- `wards.geojson`: ~1.7 MB
- `sensors.json`: ~200 KB
- `sensor_series/`: ~80 KB per sensor × 579 = ~47 MB currently. Grows roughly linearly with the reporting window each new KH ZIP covers.

## Refresh cadence

Whenever KH sends a new cleaned ZIP (currently ~weekly): put it beside the shapefile + population xlsx in the `backend/` cwd, run `backend/prepare_data.py`, commit, push.
