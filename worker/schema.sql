-- BBMP Borewell Dashboard D1 schema.
-- One table per concept; sensor_series stored as a single JSON per UID to keep
-- reads O(1) and writes small. Rebuild is idempotent (DROP + CREATE).

DROP TABLE IF EXISTS snapshots;
DROP TABLE IF EXISTS sensor_series;
DROP TABLE IF EXISTS sensors;
DROP TABLE IF EXISTS wards;

CREATE TABLE wards (
  ward_no INTEGER PRIMARY KEY,
  ward_name TEXT,
  area_km2 REAL,
  population REAL,
  households REAL,
  sensor_total INTEGER DEFAULT 0,
  sensor_with_data INTEGER DEFAULT 0,
  centroid_lat REAL,
  centroid_lng REAL,
  geometry_json TEXT   -- GeoJSON geometry object (Polygon coordinates)
);

CREATE TABLE sensors (
  uid TEXT PRIMARY KEY,
  lat REAL,
  lng REAL,
  ward_no INTEGER,
  ward_name TEXT,
  motor_hp REAL,
  borewell_depth REAL,
  pump_name TEXT,
  has_data INTEGER DEFAULT 0,
  reading_count INTEGER DEFAULT 0,
  first_data_at TEXT,
  last_data_at TEXT
);
CREATE INDEX idx_sensors_ward ON sensors(ward_no);
CREATE INDEX idx_sensors_has_data ON sensors(has_data);

CREATE TABLE sensor_series (
  uid TEXT PRIMARY KEY,
  unit_water TEXT DEFAULT 'ft below surface',
  unit_flow TEXT DEFAULT 'L/min',
  unit_yield TEXT DEFAULT 'KL',
  times_json TEXT,     -- JSON array of ISO strings
  water_json TEXT,     -- JSON array of numbers (nullable entries as null)
  flow_json  TEXT,
  yield_json TEXT,
  FOREIGN KEY (uid) REFERENCES sensors(uid) ON DELETE CASCADE
);

CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT,
  kh_zip TEXT,
  sensor_total INTEGER,
  sensor_with_data INTEGER,
  wards INTEGER,
  wards_with_data INTEGER,
  period_start TEXT,
  period_end TEXT
);
