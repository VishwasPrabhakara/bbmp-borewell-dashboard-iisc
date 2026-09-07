// BBMP Borewell Dashboard — IISc for BWSSB
// Full-screen map first. Everything else opens on click.

const CONFIG = window.DASHBOARD_CONFIG || { source: "static", apiBase: "" };
function urlOf(name) {
  if (CONFIG.source === "api" && CONFIG.apiBase) {
    const map = { "wards.geojson": "/api/wards.geojson", "sensors.json": "/api/sensors", "manifest.json": "/api/manifest" };
    return CONFIG.apiBase.replace(/\/$/, "") + map[name];
  }
  return `./data/${name}`;
}
function seriesUrlOf(uid) {
  return CONFIG.source === "api" && CONFIG.apiBase
    ? CONFIG.apiBase.replace(/\/$/, "") + "/api/sensor/" + uid + "/series"
    : `./data/sensor_series/${uid}.json`;
}
let sensors = [];              // full list
let wards = null;              // GeoJSON
let manifest = null;
let sensorsByUid = {};
let sensorsByWard = {};        // ward_no -> [sensor]
let currentSensorMarkers = null;
let wardLayer = null;
let map;
let selectedWardNo = null;

function defaultWardStyle(feat) {
  const p = feat.properties;
  const isSelected = selectedWardNo != null && p.ward_no === selectedWardNo;
  const dimmed = selectedWardNo != null && !isSelected;
  return {
    color: isSelected ? "#0b3d4c" : "#5a7a86",
    weight: isSelected ? 2.6 : 1.2,
    opacity: dimmed ? 0.15 : 0.9,
    fillColor: isSelected ? "#028090" : "#a8d8e2",
    fillOpacity: dimmed ? 0.05 : (isSelected ? 0.35 : 0.22),
  };
}

function panelWidthPx() {
  // Match style.css: .detail { min-width: 480px; width: 55vw }.
  // We compute from window width so this works even when the panel is still
  // hidden at fit-time (openWardDetail runs AFTER setSelectedWard).
  const vw = window.innerWidth || document.documentElement.clientWidth || 1200;
  return Math.max(Math.round(vw * 0.55), 480);
}

function panToLatLngLeftHalf(lat, lng, zoom) {
  // Shift the pan target east by half the panel width in screen space, so the
  // actual point ends up centered inside the visible left slice of the map.
  const z = zoom != null ? zoom : map.getZoom();
  const half = panelWidthPx() / 2;
  const src = map.project([lat, lng], z);
  const shifted = src.add([half, 0]);
  const target = map.unproject(shifted, z);
  if (zoom != null) map.setView(target, zoom);
  else map.panTo(target);
}

function updateClearFilterChip() {
  const chip = document.getElementById("clear-filter-chip");
  if (!chip) return;
  chip.hidden = (selectedWardNo == null && selectedSensorUid == null);
}

function setSelectedWard(wardNo, feat) {
  selectedWardNo = wardNo;
  selectedSensorUid = null;
  if (wardLayer) wardLayer.setStyle(defaultWardStyle);
  renderSensors();
  buildLegend();
  updateClearFilterChip();
  if (feat) {
    const bbox = L.geoJSON(feat).getBounds();
    // Pretend the right panel is padding so the polygon fits into the visible left half.
    const rightPad = Math.ceil(panelWidthPx()) + 40;
    map.fitBounds(bbox, {
      paddingTopLeft: [60, 60],
      paddingBottomRight: [rightPad, 60],
      maxZoom: 15,
    });
  }
}

function clearWardSelection() {
  selectedWardNo = null;
  selectedSensorUid = null;
  if (wardLayer) wardLayer.setStyle(defaultWardStyle);
  renderSensors();
  document.getElementById("detail").hidden = true;
  buildLegend();
  updateClearFilterChip();
  // Zoom back to the whole city view.
  map.setView([12.972, 77.594], 11, { animate: true });
}

let currentShading = "with_data";
let showAllSensors = false;
let charts = { water: null, discharge: null, modal: null };
let currentSensorSeries = null;   // cached
let selectedSensorUid = null;
let currentRange = "1M";

// ---------- Palette (choropleth: light -> dark teal) ----------
const CHORO = ["#f0f9fb", "#d3ecf1", "#a8d8e2", "#79c1d1", "#4ea6bd", "#2f8ba3", "#1c6e88", "#0e5670"];

function choroColor(value, breaks) {
  if (value == null || value === 0) return "#e2e8ec";
  for (let i = 0; i < breaks.length; i++) {
    if (value <= breaks[i]) return CHORO[i];
  }
  return CHORO[CHORO.length - 1];
}

function computeBreaks(values) {
  // Use quantile-ish breaks so shading spreads even for skewed distributions.
  const clean = values.filter(v => v != null && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) return [1];
  const n = CHORO.length;
  const breaks = [];
  for (let i = 1; i <= n; i++) {
    const idx = Math.min(clean.length - 1, Math.round((i / n) * (clean.length - 1)));
    breaks.push(clean[idx]);
  }
  // De-dupe consecutive equal breaks
  return breaks.filter((v, i) => i === 0 || v > breaks[i - 1]);
}

// ---------- Boot ----------
async function boot() {
  initMap();
  buildLegend();
  wireToolbar();
  wireSearch();
  wireFilters();
  wireLegend();
  wireDetailClose();
  try {
    await loadData();
    renderWards();
    renderSensors();
    document.getElementById("about-manifest").textContent =
      `Snapshot: ${manifest.kh_zip}. ${manifest.sensor_with_data} sensors reporting between ${fmtDate(manifest.period_start)} and ${fmtDate(manifest.period_end)}, across ${manifest.wards_with_data} wards.`;
  } catch (err) {
    console.error("Dashboard data load failed:", err);
    document.getElementById("about-manifest").textContent =
      "Could not load data files. Check the browser console (F12) — usually a 404 on /data/wards.geojson.";
    openOverlay("about-overlay");
  }
}
async function loadData() {
  console.info("[dashboard] fetching", { wards: urlOf("wards.geojson"), sensors: urlOf("sensors.json") });
  const [ws, ss, mf] = await Promise.all([
    fetch(urlOf("wards.geojson")).then(r => r.json()),
    fetch(urlOf("sensors.json")).then(r => r.json()),
    fetch(urlOf("manifest.json")).then(r => r.json()),
  ]);
  wards = ws;
  sensors = ss;
  manifest = mf;
  console.info("[dashboard] loaded", { wards: wards.features.length, sensors: sensors.length, sensorsWithData: sensors.filter(s => s.has_data).length, manifest });
  for (const s of sensors) {
    sensorsByUid[s.uid] = s;
    if (s.ward_no != null) (sensorsByWard[s.ward_no] = sensorsByWard[s.ward_no] || []).push(s);
  }
}

// ---------- Map ----------
function initMap() {
  // (map click handler wired after map is created)
  map = L.map("map", { zoomControl: false, minZoom: 10, maxZoom: 18 }).setView([12.972, 77.594], 11);
  L.control.zoom({ position: "bottomleft" }).addTo(map);
  // Carto Positron - clean, minimal international-style basemap
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map);
  map.on("click", (e) => {
    if (selectedWardNo != null && !e.originalEvent.target.closest(".leaflet-interactive")) {
      clearWardSelection();
    }
  });
}

// ---------- Wards ----------
function renderWards() {
  if (wardLayer) wardLayer.remove();

  wardLayer = L.geoJSON(wards, {
    style: feat => defaultWardStyle(feat),
    onEachFeature: (feat, layer) => {
      const p = feat.properties;
      const tip = `
        <div class="name">Ward ${p.ward_no} — ${p.ward_name}</div>
        <div class="kv">Sensors with data: <b>${p.sensor_with_data || 0}</b> / ${p.sensor_total || 0}</div>
        <div class="kv">Population (2026 proj): ${p.population_2026 ? Math.round(p.population_2026).toLocaleString("en-IN") : "—"}</div>
        <div class="kv">Area: ${p.area_km2 ? p.area_km2.toFixed(1) + " km²" : "—"}</div>
      `;
      layer.bindTooltip(tip, { className: "ward-tip", sticky: true, direction: "auto" });
      layer.on({
        mouseover: e => e.target.setStyle({ weight: 2.5, color: "#0b3d4c" }),
        mouseout: e => wardLayer.resetStyle(e.target),
        click: () => { setSelectedWard(p.ward_no, feat); openWardDetail(p, feat); },
      });
    },
  }).addTo(map);
  buildLegend();
}

function shadingValue(feature) {
  const p = feature.properties;
  if (currentShading === "with_data") return p.sensor_with_data;
  if (currentShading === "total") return p.sensor_total;
  if (currentShading === "population") return p.population;
  return null;
}

// ---------- Sensors ----------
function renderSensors() {
  if (currentSensorMarkers) currentSensorMarkers.remove();
  currentSensorMarkers = L.layerGroup();
  const visible = sensors.filter(s => s.lat != null && s.lng != null && (showAllSensors || s.has_data) && (selectedWardNo == null || s.ward_no === selectedWardNo));
  for (const s of visible) {
    const isSel = selectedSensorUid === s.uid;
    const m = L.circleMarker([s.lat, s.lng], {
      radius: isSel ? 11 : 6,
      color: isSel ? "#f59e0b" : "#ffffff",
      weight: isSel ? 3 : 1.6,
      fillColor: s.has_data ? "#dc2626" : "#94a3b8",
      fillOpacity: 0.95,
    });
    const wardLabel = s.ward_no != null ? `Ward ${s.ward_no} — ${s.ward_name || ""}` : "Unassigned";
    m.bindTooltip(`<b>${s.uid}</b><br/>${wardLabel}${s.has_data ? "" : " · <i>no data</i>"}`, { className: "sensor-tip", direction: "top" });
    m.on("click", () => openSensorDetail(s.uid));
    currentSensorMarkers.addLayer(m);
    if (isSel) m.bringToFront();
  }
  currentSensorMarkers.addTo(map);
}

// ---------- Legend ----------
function buildLegend() {
  const el = document.getElementById("legend-scale");
  if (el) el.style.display = "none";
  const cap = document.querySelector(".legend-caption");
  if (cap) cap.textContent = selectedWardNo != null ? "Ward isolated — click map background to clear" : "Click a ward to isolate";
}

// ---------- Toolbar / overlays ----------
function wireToolbar() {
  const clearChip = document.getElementById("clear-filter-chip");
  if (clearChip) clearChip.addEventListener("click", () => clearWardSelection());
  document.getElementById("btn-search").addEventListener("click", () => openOverlay("search-overlay", () => document.getElementById("search-input").focus()));
  document.getElementById("btn-filter").addEventListener("click", () => openOverlay("filter-overlay"));
  document.getElementById("btn-info").addEventListener("click", () => openOverlay("about-overlay"));
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openOverlay("search-overlay", () => document.getElementById("search-input").focus());
    }
    if (e.key === "Escape") {
      closeAllOverlays();
      if (selectedWardNo != null || selectedSensorUid != null) clearWardSelection();
    }
  });
  // Close on background click
  document.querySelectorAll(".overlay").forEach(ov => {
    ov.addEventListener("click", e => { if (e.target === ov) ov.hidden = true; });
  });
  document.querySelectorAll("[data-close]").forEach(btn => {
    btn.addEventListener("click", () => { document.getElementById(btn.dataset.close).hidden = true; });
  });
}

function openOverlay(id, cb) {
  closeAllOverlays();
  const el = document.getElementById(id);
  el.hidden = false;
  if (cb) setTimeout(cb, 0);
}
function closeAllOverlays() {
  document.querySelectorAll(".overlay").forEach(o => o.hidden = true);
}

function wireDetailClose() {
  document.querySelector("#detail .close-btn").addEventListener("click", () => clearWardSelection());
}

// ---------- Search ----------
function wireSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  input.addEventListener("input", debounce(() => runSearch(input.value.trim(), results), 120));
  runSearch("", results); // initial: show top wards
}

function runSearch(q, container) {
  container.innerHTML = "";
  if (!wards || !sensors) { container.innerHTML = '<div class="loading">Data still loading, please wait...</div>'; return; }
  const query = q.toLowerCase();
  const items = [];

  // Statistical shortcuts
  if (!query || "max sensors top most".includes(query.split(" ")[0])) {
    if (query.startsWith("max") || query.startsWith("top") || !query) {
      const sorted = [...wards.features].sort((a, b) => (b.properties.sensor_with_data || 0) - (a.properties.sensor_with_data || 0)).slice(0, 8);
      sorted.forEach(f => items.push({ kind: "ward-quick", label: `Ward ${f.properties.ward_no} · ${f.properties.ward_name}`, sub: `${f.properties.sensor_with_data} sensors`, feat: f, badge: "top" }));
    }
  }
  if (query.startsWith("min") || query.startsWith("few") || query === "no sensors") {
    const wSorted = wards.features
      .filter(f => (f.properties.sensor_with_data || 0) > 0)
      .sort((a, b) => (a.properties.sensor_with_data || 0) - (b.properties.sensor_with_data || 0))
      .slice(0, 8);
    wSorted.forEach(f => items.push({ kind: "ward-quick", label: `Ward ${f.properties.ward_no} · ${f.properties.ward_name}`, sub: `${f.properties.sensor_with_data} sensors`, feat: f, badge: "min" }));
  }

  // Regular ward + UID matching
  if (query.length >= 1) {
    for (const f of wards.features) {
      const p = f.properties;
      const name = String(p.ward_name || "").toLowerCase();
      const no = String(p.ward_no || "");
      if (name.includes(query) || no === query || no.startsWith(query)) {
        items.push({ kind: "ward", label: `Ward ${p.ward_no} · ${p.ward_name}`, sub: `${p.sensor_with_data}/${p.sensor_total} sensors`, feat: f });
      }
      if (items.length > 40) break;
    }
    for (const s of sensors) {
      if (s.uid.toLowerCase().includes(query)) {
        items.push({ kind: "sensor", label: s.uid, sub: s.ward_name ? `Ward ${s.ward_no} · ${s.ward_name}` : "Unassigned", sensor: s });
      }
      if (items.length > 60) break;
    }
  }

  if (items.length === 0) {
    container.innerHTML = `<div class="loading">No matches. Try a ward name, ward number, or a UID.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  items.slice(0, 40).forEach(it => {
    const row = document.createElement("div");
    row.className = "search-item";
    row.innerHTML = `<div><div class="primary">${it.label}</div><div class="secondary">${it.sub}</div></div>${it.badge ? `<span class="badge">${it.badge}</span>` : ""}`;
    row.onclick = () => {
      closeAllOverlays();
      if (it.kind === "sensor") openSensorDetail(it.sensor.uid);
      else openWardDetail(it.feat.properties, it.feat);
    };
    frag.appendChild(row);
  });
  container.appendChild(frag);
}

// ---------- Filters ----------
function wireFilters() {
  document.querySelectorAll("[data-quick]").forEach(chip => {
    chip.addEventListener("click", () => {
      const which = chip.dataset.quick;
      closeAllOverlays();
      if (which === "reset") { map.setView([12.972, 77.594], 11); return; }
      const filtered = wards.features
        .filter(f => which === "no_sensors" ? (f.properties.sensor_with_data || 0) === 0 : (f.properties.sensor_with_data || 0) > 0)
        .sort((a, b) => which === "max_sensors" ? (b.properties.sensor_with_data || 0) - (a.properties.sensor_with_data || 0) : (a.properties.sensor_with_data || 0) - (b.properties.sensor_with_data || 0));
      const top = filtered.slice(0, which === "no_sensors" ? filtered.length : 10);
      if (top.length && top[0].properties.centroid) {
        const bounds = L.latLngBounds(top.map(f => [f.properties.centroid[1], f.properties.centroid[0]]));
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    });
  });
}

function wireLegend() {
  document.getElementById("show-all-sensors").addEventListener("change", e => {
    showAllSensors = e.target.checked;
    renderSensors();
  });
}

// ---------- Detail panel: ward ----------
function openWardDetail(p, feat) {
  const panel = document.getElementById("detail");
  const title = document.getElementById("detail-title");
  const body = document.getElementById("detail-body");
  title.innerHTML = `<div class="kicker">Ward ${p.ward_no}</div><h2>${p.ward_name || "—"}</h2>`;
  const list = (sensorsByWard[p.ward_no] || []).sort((a, b) => (b.has_data - a.has_data) || (a.uid > b.uid ? 1 : -1));
  const withData = list.filter(s => s.has_data).length;
  const fmtInt = v => v == null ? "—" : Math.round(v).toLocaleString("en-IN");
  const fmtMm = v => v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " mm";
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Sensors with data</div><div class="stat-value">${withData}</div><div class="stat-sub">out of ${list.length} total</div></div>
      <div class="stat-card"><div class="stat-label">Area</div><div class="stat-value small">${p.area_km2 ? p.area_km2.toFixed(2) + " km²" : "—"}</div></div>
      <div class="stat-card"><div class="stat-label">Rainfall (last 12 mo)</div><div class="stat-value small">${fmtMm(p.rainfall_mm_annual)}</div><div class="stat-sub">KWRIS + KSNDMC · <a href="#" data-download-rain="${p.ward_no}">Download</a></div></div>
      <div class="stat-card"><div class="stat-label">Population 2001</div><div class="stat-value small">${fmtInt(p.population_2001)}</div><div class="stat-sub">Census</div></div>
      <div class="stat-card"><div class="stat-label">Population 2011</div><div class="stat-value small">${fmtInt(p.population_2011)}</div><div class="stat-sub">Census</div></div>
      <div class="stat-card"><div class="stat-label">Projected 2026</div><div class="stat-value small">${fmtInt(p.population_2026)}</div><div class="stat-sub">CAGR from 2001–10</div></div>
    </div>
    <div class="section-title">Sensors in this ward (${list.length})</div>
    <div class="uid-list" id="ward-uid-list"></div>
  `;
  const ul = body.querySelector("#ward-uid-list");
  if (list.length === 0) {
    ul.innerHTML = `<div class="loading">No sensors registered in this ward.</div>`;
  } else {
    list.forEach(s => {
      const row = document.createElement("div");
      row.className = "uid-item" + (selectedSensorUid === s.uid ? " selected" : "");
      row.dataset.uid = s.uid;
      row.innerHTML = `<span class="uid-mono">${s.uid}</span><span class="uid-tag ${s.has_data ? "data" : "nodata"}">${s.has_data ? "data" : "no data"}</span>`;
      row.onclick = () => openSensorDetail(s.uid);
      ul.appendChild(row);
    });
  }
  panel.hidden = false;
}

// ---------- Detail panel: sensor ----------
async function openSensorDetail(uid) {
  const s = sensorsByUid[uid];
  if (!s) return;
  selectedSensorUid = uid;
  renderSensors();
  updateClearFilterChip();
  // If the ward-list is visible, refresh row highlighting without re-rendering the whole panel.
  document.querySelectorAll(".uid-item").forEach(el => {
    el.classList.toggle("selected", el.dataset.uid === uid);
  });
  const panel = document.getElementById("detail");
  const title = document.getElementById("detail-title");
  const body = document.getElementById("detail-body");
  title.innerHTML = `<div class="kicker">Sensor</div><h2>${s.uid}</h2>`;
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Ward</div><div class="stat-value small">${s.ward_no != null ? `${s.ward_no} · ${s.ward_name || ""}` : "Unassigned"}</div></div>
      <div class="stat-card"><div class="stat-label">Motor HP</div><div class="stat-value small">${s.motor_hp != null ? s.motor_hp : "—"}</div></div>
      <div class="stat-card"><div class="stat-label">Borewell depth</div><div class="stat-value small">${s.borewell_depth != null ? s.borewell_depth + " ft" : "—"}</div></div>
      <div class="stat-card"><div class="stat-label">Readings</div><div class="stat-value small">${(s.reading_count || 0).toLocaleString("en-IN")}</div></div>
      <div class="stat-card"><div class="stat-label">First reading</div><div class="stat-value small">${fmtDate(s.first_data_at)}</div></div>
      <div class="stat-card"><div class="stat-label">Last reading</div><div class="stat-value small">${fmtDate(s.last_data_at)}</div></div>
    </div>
    ${s.has_data ? '<div id="session-stats-card" class="session-stats-card">Computing session quality…</div>' : ""}
    ${s.has_data ? sensorChartsHTML() : `<div class="loading">No time-series data for this sensor in the current snapshot.</div>`}
  `;
  panel.hidden = false;
  // If the sensor was clicked without a ward context, zoom in to it (like a ward selection).
  const targetZoom = selectedWardNo == null ? 16 : null;
  if (s.lat != null && s.lng != null) panToLatLngLeftHalf(s.lat, s.lng, targetZoom);
  if (s.has_data) {
    await loadAndRenderSeries(uid);
    renderSessionStatsCard();
    wireRangeChips();
  }
}

function sensorChartsHTML() {
  const chips = ["1W", "1M", "3M", "ALL"].map(r => `<button class="range-chip${r === "1M" ? " active" : ""}" data-range="${r}">${r}</button>`).join("");
  return `
    <div class="chart-block">
      <div class="chart-header">
        <div class="chart-title">Water level (ft below surface)</div>
        <div class="chart-actions">${chips}<button class="expand-btn" data-expand="water" title="Expand">⤢</button></div>
      </div>
      <div class="chart-canvas-wrap"><canvas id="chart-water"></canvas></div>
    </div>
    <div class="chart-block">
      <div class="chart-header">
        <div class="chart-title">Discharge (L/min)</div>
        <div class="chart-actions">${chips}<button class="expand-btn" data-expand="discharge" title="Expand">⤢</button></div>
      </div>
      <div class="chart-canvas-wrap"><canvas id="chart-discharge"></canvas></div>
    </div>
  `;
}

// ============================================================
// KH session detection + filter (client-side port of pass2_parse_ward.py)
// ============================================================
// A "session" = contiguous run of samples with time gaps <= MAX_GAP_MIN
// and cumulative-yield monotonic non-decreasing (a big drop = pump reset).
// Each session is classified USABLE / UNUSABLE per KH rules:
//   - too_few_samples : n_samples < 3
//   - no_volume       : cumulative yield did not increase
//   - sensor_relock_jump : any consecutive |water_ft step| > 20 ft
//   - net_level_rise  : stop level <= start level (water rose, not drew down)
const MAX_SESSION_GAP_MIN = 30;
const JUMP_THRESHOLD_FT   = 20.0;
const CUM_RESET_TOL_KL    = 0.01;

function computeSessions(series) {
  if (!series || !series.times || series.times.length < 2) return [];
  const times = series.times.map(t => new Date(t));
  const wl = series.water_ft, fl = series.flow_lpm, cy = series.yield_kl;
  const boundaries = [0];
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] - times[i - 1]) / 60000;
    const cumReset = (cy[i] != null && cy[i - 1] != null && cy[i] < cy[i - 1] - CUM_RESET_TOL_KL);
    if (gap > MAX_SESSION_GAP_MIN || cumReset) boundaries.push(i);
  }
  boundaries.push(times.length);
  const out = [];
  for (let b = 0; b < boundaries.length - 1; b++) {
    const from = boundaries[b], to = boundaries[b + 1];
    if (to - from < 2) continue;
    const idx = [];
    for (let i = from; i < to; i++) idx.push(i);
    const startLevel = wl[from], stopLevel = wl[to - 1];
    if (startLevel == null || stopLevel == null) continue;
    let maxStep = 0;
    for (let i = from + 1; i < to; i++) {
      if (wl[i] != null && wl[i - 1] != null) {
        const step = Math.abs(wl[i] - wl[i - 1]);
        if (step > maxStep) maxStep = step;
      }
    }
    const startY = cy[from], stopY = cy[to - 1];
    const pumped = (startY != null && stopY != null) ? stopY - startY : null;
    const reasons = [];
    if (idx.length < 3) reasons.push("too_few_samples");
    if (pumped == null || pumped <= 0) reasons.push("no_volume");
    if (maxStep > JUMP_THRESHOLD_FT) reasons.push("sensor_relock_jump");
    if ((stopLevel - startLevel) <= 0) reasons.push("net_level_rise");
    out.push({
      startIdx: from, stopIdx: to - 1, idx,
      startTime: times[from], stopTime: times[to - 1],
      nSamples: idx.length,
      drawdownFt: stopLevel - startLevel,
      pumpedKl: pumped,
      maxStepFt: maxStep,
      usable: reasons.length === 0,
      reasons,
    });
  }
  return out;
}

function sessionCoverage(sessions, seriesLen) {
  // Return a Uint8Array where 1 = point belongs to a USABLE session, 2 = UNUSABLE session, 0 = between sessions.
  const cover = new Uint8Array(seriesLen);
  for (const sess of sessions) {
    const tag = sess.usable ? 1 : 2;
    for (const i of sess.idx) cover[i] = tag;
  }
  return cover;
}

function summarizeSessions(sessions) {
  const total = sessions.length;
  const kept  = sessions.filter(s => s.usable).length;
  const dropped = total - kept;
  const byReason = {};
  for (const s of sessions) {
    if (s.usable) continue;
    for (const r of s.reasons) byReason[r] = (byReason[r] || 0) + 1;
  }
  return { total, kept, dropped, byReason };
}

const REASON_LABEL = {
  too_few_samples:    "&lt;3 samples",
  no_volume:          "no pumped volume",
  sensor_relock_jump: "sensor re-lock (&gt;20 ft jump)",
  net_level_rise:     "water rose, not drew down",
};

async function loadAndRenderSeries(uid) {
  const res = await fetch(seriesUrlOf(uid));
  if (!res.ok) return;
  currentSensorSeries = await res.json();
  currentRange = "1M";
  drawCharts();
}

function filteredSeries(range) {
  const s = currentSensorSeries;
  if (!s) return { times: [], water: [], flow: [], cover: [] };
  const times = s.times.map(t => new Date(t));
  const last = times.length ? times[times.length - 1] : new Date();
  let from = null;
  if (range === "1W") from = new Date(last.getTime() - 7 * 86400000);
  else if (range === "1M") from = new Date(last.getTime() - 30 * 86400000);
  else if (range === "3M") from = new Date(last.getTime() - 90 * 86400000);
  const sessions = computeSessions(s);
  const cover = sessionCoverage(sessions, s.times.length);
  const out = { times: [], water: [], flow: [], cover: [] };
  for (let i = 0; i < times.length; i++) {
    if (from && times[i] < from) continue;
    out.times.push(times[i]);
    out.water.push(s.water_ft[i]);
    out.flow.push(s.flow_lpm[i]);
    out.cover.push(cover[i]);
  }
  return out;
}

function splitByCover(times, values, cover) {
  // Returns two arrays aligned with `times`, where non-matching points are null (creates gaps in Chart.js).
  const kept = times.map((_, i) => (cover[i] === 1 ? values[i] : null));
  const drop = times.map((_, i) => (cover[i] === 2 ? values[i] : null));
  return { kept, drop };
}

function drawCharts() {
  if (charts.water) charts.water.destroy();
  if (charts.discharge) charts.discharge.destroy();
  const d = filteredSeries(currentRange);
  const w = splitByCover(d.times, d.water, d.cover);
  const f = splitByCover(d.times, d.flow, d.cover);
  const commonOpts = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: { display: true, position: "top", labels: { boxWidth: 12, boxHeight: 4, font: { size: 11 }, color: "#5a6472" } },
      tooltip: { backgroundColor: "rgba(11,61,76,0.95)" },
    },
    scales: {
      x: { type: "time", time: { tooltipFormat: "dd MMM HH:mm" }, ticks: { color: "#5a6472" }, grid: { display: false } },
      y: { ticks: { color: "#5a6472" }, grid: { color: "#eef2f5" } },
    },
    elements: { point: { radius: 0 }, line: { borderWidth: 1.6 } },
    spanGaps: false,
  };
  const keptWater = { label: "Kept (usable session)", data: w.kept, borderColor: "#0e7490", backgroundColor: "rgba(14,116,144,0.10)", fill: false, tension: 0.15 };
  const dropWater = { label: "Filtered out", data: w.drop, borderColor: "#94a3b8", borderDash: [4, 4], backgroundColor: "transparent", fill: false, tension: 0.15 };
  const keptFlow  = { label: "Kept (usable session)", data: f.kept, borderColor: "#0891b2", backgroundColor: "rgba(8,145,178,0.10)", fill: false, tension: 0.1 };
  const dropFlow  = { label: "Filtered out", data: f.drop, borderColor: "#94a3b8", borderDash: [4, 4], backgroundColor: "transparent", fill: false, tension: 0.1 };
  charts.water = new Chart(document.getElementById("chart-water"), {
    type: "line",
    data: { labels: d.times, datasets: [keptWater, dropWater] },
    options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: "ft below surface", color: "#5a6472" } } } },
  });
  charts.discharge = new Chart(document.getElementById("chart-discharge"), {
    type: "line",
    data: { labels: d.times, datasets: [keptFlow, dropFlow] },
    options: { ...commonOpts, scales: { ...commonOpts.scales, y: { ...commonOpts.scales.y, title: { display: true, text: "L/min", color: "#5a6472" } } } },
  });
}

function renderSessionStatsCard() {
  const el = document.getElementById("session-stats-card");
  if (!el || !currentSensorSeries) return;
  const sessions = computeSessions(currentSensorSeries);
  const stats = summarizeSessions(sessions);
  const reasonRows = Object.entries(stats.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `<div class="reason-row"><span>${REASON_LABEL[r] || r}</span><span class="reason-count">${n}</span></div>`)
    .join("");
  el.innerHTML = `
    <div class="session-stats-head">
      <span class="stats-title">Session quality (KH filter rules)</span>
    </div>
    <div class="session-stats-grid">
      <div class="ss-tile"><div class="ss-num">${stats.total}</div><div class="ss-lbl">total sessions</div></div>
      <div class="ss-tile ok"><div class="ss-num">${stats.kept}</div><div class="ss-lbl">kept</div></div>
      <div class="ss-tile bad"><div class="ss-num">${stats.dropped}</div><div class="ss-lbl">filtered out</div></div>
    </div>
    ${reasonRows ? `<div class="reason-list">${reasonRows}</div>` : ""}
  `;
}

function wireRangeChips() {
  document.querySelectorAll(".range-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      const parent = chip.parentElement;
      parent.querySelectorAll(".range-chip").forEach(c => c.classList.remove("active"));
      // sync both blocks to the same range
      currentRange = chip.dataset.range;
      document.querySelectorAll(".range-chip").forEach(c => {
        c.classList.toggle("active", c.dataset.range === currentRange);
      });
      drawCharts();
    });
  });
  document.querySelectorAll(".expand-btn").forEach(btn => {
    btn.addEventListener("click", () => openChartModal(btn.dataset.expand));
  });
}

function openChartModal(which) {
  const title = which === "water" ? "Water level (ft below surface)" : "Discharge (L/min)";
  document.getElementById("chart-modal-title").textContent = `${title} — ${currentSensorSeries.uid}`;
  const body = document.getElementById("chart-modal-body");
  body.innerHTML = `<canvas id="chart-modal-canvas"></canvas>`;
  openOverlay("chart-modal");
  const d = filteredSeries(currentRange);
  const color = which === "water" ? "#1e3a8a" : "#0891b2";
  const yTitle = which === "water" ? "ft below surface" : "L/min";
  if (charts.modal) charts.modal.destroy();
  charts.modal = new Chart(document.getElementById("chart-modal-canvas"), {
    type: "line",
    data: { labels: d.times, datasets: [{ data: which === "water" ? d.water : d.flow, borderColor: color, backgroundColor: color + "1A", fill: true, tension: 0.15 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "rgba(11,61,76,0.95)" } },
      scales: {
        x: { type: "time", time: { tooltipFormat: "dd MMM yyyy HH:mm" }, grid: { color: "#eef2f5" } },
        y: { title: { display: true, text: yTitle } },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.8 } },
    },
  });
}

// ---------- Utils ----------
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// -------- Rainfall CSV download --------
async function downloadRainfallCsv(wardNo, grain) {
  const res = await fetch(`./data/rainfall/${wardNo}.json`);
  if (!res.ok) { alert("No rainfall data for this ward yet. Run backend/fetch_rainfall.py to populate."); return; }
  const j = await res.json();
  const rows = grain === "monthly"
    ? [["month","rainfall_mm"], ...(j.monthly || []).map(r => [r.month, r.rainfall_mm])]
    : [["date","rainfall_mm"], ...(j.daily || []).map(r => [r.date, r.rainfall_mm ?? ""])];
  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rainfall_ward${wardNo}_${grain}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-download-rain]");
  if (!el) return;
  e.preventDefault();
  const wardNo = el.dataset.downloadRain;
  const grain = window.confirm("Daily rainfall CSV?\nOK = daily · Cancel = monthly") ? "daily" : "monthly";
  downloadRainfallCsv(wardNo, grain);
});

boot();
