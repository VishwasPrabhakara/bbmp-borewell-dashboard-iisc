/**
 * BBMP Borewell Dashboard — Cloudflare Worker + D1 API
 *
 * Endpoints (all under the Worker's URL):
 *   GET  /                 -> health check
 *   GET  /api/manifest     -> latest snapshot summary
 *   GET  /api/wards        -> array of wards (properties only, no geometry)
 *   GET  /api/wards.geojson-> full GeoJSON FeatureCollection for the map
 *   GET  /api/sensors      -> array of sensors
 *   GET  /api/sensor/:uid  -> single sensor's metadata
 *   GET  /api/sensor/:uid/series -> full time series (client filters by range)
 *   GET  /api/ward/:no     -> single ward's properties + sensor list
 *
 * The D1 binding is called `DB` (see wrangler.toml).
 * CORS is open so the GitHub Pages frontend can call this from any origin.
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=300",
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...extra },
  });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (p === "/") return json({ ok: true, service: "bbmp-borewell-iisc", now: new Date().toISOString() });

      if (p === "/api/manifest") {
        const row = await env.DB.prepare(
          `SELECT generated_at, kh_zip, sensor_total, sensor_with_data, wards, wards_with_data, period_start, period_end
             FROM snapshots ORDER BY id DESC LIMIT 1`
        ).first();
        return json(row || {});
      }

      if (p === "/api/wards") {
        const { results } = await env.DB.prepare(
          `SELECT ward_no, ward_name, area_km2, population, households, sensor_total, sensor_with_data, centroid_lat, centroid_lng
             FROM wards ORDER BY ward_no`
        ).all();
        return json(results);
      }

      if (p === "/api/wards.geojson") {
        const { results } = await env.DB.prepare(
          `SELECT ward_no, ward_name, area_km2, population, households, sensor_total, sensor_with_data, centroid_lat, centroid_lng, geometry_json
             FROM wards ORDER BY ward_no`
        ).all();
        const features = results.map(r => ({
          type: "Feature",
          properties: {
            ward_no: r.ward_no, ward_name: r.ward_name,
            area_km2: r.area_km2, population: r.population, households: r.households,
            sensor_total: r.sensor_total, sensor_with_data: r.sensor_with_data,
            centroid: r.centroid_lat != null && r.centroid_lng != null ? [r.centroid_lng, r.centroid_lat] : null,
          },
          geometry: JSON.parse(r.geometry_json || "null"),
        }));
        return json({ type: "FeatureCollection", features });
      }

      if (p === "/api/sensors") {
        const { results } = await env.DB.prepare(
          `SELECT uid, lat, lng, ward_no, ward_name, motor_hp, borewell_depth, pump_name,
                  has_data, reading_count, first_data_at, last_data_at
             FROM sensors ORDER BY uid`
        ).all();
        // Cast has_data (INTEGER 0/1) to boolean for the frontend
        results.forEach(r => (r.has_data = !!r.has_data));
        return json(results);
      }

      let m;
      if ((m = p.match(/^\/api\/sensor\/([\w\-]+)\/series$/))) {
        const uid = m[1];
        const row = await env.DB.prepare(
          `SELECT uid, unit_water, unit_flow, unit_yield, times_json, water_json, flow_json, yield_json
             FROM sensor_series WHERE uid = ?`
        ).bind(uid).first();
        if (!row) return json({ error: "not_found" }, 404);
        return json({
          uid: row.uid,
          unit_water: row.unit_water,
          unit_flow: row.unit_flow,
          unit_yield: row.unit_yield,
          times: JSON.parse(row.times_json || "[]"),
          water_ft: JSON.parse(row.water_json || "[]"),
          flow_lpm: JSON.parse(row.flow_json || "[]"),
          yield_kl: JSON.parse(row.yield_json || "[]"),
        });
      }

      if ((m = p.match(/^\/api\/sensor\/([\w\-]+)$/))) {
        const row = await env.DB.prepare(
          `SELECT uid, lat, lng, ward_no, ward_name, motor_hp, borewell_depth, pump_name,
                  has_data, reading_count, first_data_at, last_data_at
             FROM sensors WHERE uid = ?`
        ).bind(m[1]).first();
        if (!row) return json({ error: "not_found" }, 404);
        row.has_data = !!row.has_data;
        return json(row);
      }

      if ((m = p.match(/^\/api\/ward\/(\d+)$/))) {
        const wardNo = Number(m[1]);
        const ward = await env.DB.prepare(
          `SELECT ward_no, ward_name, area_km2, population, households, sensor_total, sensor_with_data
             FROM wards WHERE ward_no = ?`
        ).bind(wardNo).first();
        if (!ward) return json({ error: "not_found" }, 404);
        const { results: sensors } = await env.DB.prepare(
          `SELECT uid, has_data, motor_hp, borewell_depth, first_data_at, last_data_at
             FROM sensors WHERE ward_no = ? ORDER BY uid`
        ).bind(wardNo).all();
        sensors.forEach(s => (s.has_data = !!s.has_data));
        return json({ ward, sensors });
      }

      return json({ error: "not_found", path: p }, 404);
    } catch (err) {
      return json({ error: "server_error", message: String(err && err.message || err) }, 500);
    }
  },
};
