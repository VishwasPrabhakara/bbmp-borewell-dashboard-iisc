// SUSPEND_LENS_GUARD
const _SUSPENDED_LENSES = new Set(["overall","common","common_composite","composite","previous_consumption","consumption_criticality"]);
function _guardLens() {
  if (typeof currentLens === "string" && _SUSPENDED_LENSES.has(currentLens)) {
    currentLens = "groundwater";
    const sel = document.getElementById("analysis-lens");
    if (sel) sel.value = "groundwater";
  }
}

// BBMP Borewell Dashboard — IISc for BWSSB
// Full-screen map first. Everything else opens on click.

const CONFIG = window.DASHBOARD_CONFIG || { source: "static", apiBase: "" };
const ANALYTICS_API_BASE = "https://bbmp-borewell-api.vishwas-borewellworkersdev.workers.dev";
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
let sessionSummary = null;
let analyticsLoaded = false;
let sensorQcByUid = new Map();
let criticalGroundwaterByNo = new Map();
let currentStressByNo = new Map();
let pumpingPerformanceWardSummaryByNo = new Map();
let pumpingPerformanceWardThresholds = {};
let volumetricDeficitByNo = new Map();
let sensorsByUid = {};
let sensorsByWard = {};        // ward_no -> [sensor]
let currentSensorMarkers = null;
let wardLayer = null;
let map;
let selectedWardNo = null;
let highlightedWardNos = new Set();
let quickViewLabel = "";
let highlightStyleMode = "";

function defaultWardStyle(feat) {
  const p = feat.properties;
  const isSelected = selectedWardNo != null && p.ward_no === selectedWardNo;
  const status = wardStatusKey(p);
  const filterDimmed = wardStatusFilter && status !== wardStatusFilter;
  const isHighlighted = highlightedWardNos.has(normalizeWardNo(p.ward_no));
  const selectionHighlighted = isHighlighted && ["query", "quick"].includes(highlightStyleMode);
  const quickDimmed = highlightedWardNos.size > 0 && !isHighlighted;
  const dimmed = (selectedWardNo != null && !isSelected) || filterDimmed || quickDimmed;
  if (!(p.sensor_with_data > 0)) {
    return {
      fillColor: selectionHighlighted ? "#2563eb" : '#d1d5db',
      color: isSelected ? "#0b3d4c" : selectionHighlighted ? "#1d4ed8" : isHighlighted ? "#0e7490" : "#9ca3af",
      weight: isSelected ? 3 : isHighlighted ? 3.2 : 0.6,
      fillOpacity: dimmed ? 0.12 : selectionHighlighted ? 0.78 : isHighlighted ? 0.72 : 0.55,
      opacity: dimmed ? 0.35 : 1,
      dashArray: isHighlighted ? null : '3 3'
    };
  }
  const colored = wardColor(p);
  return {
    color: isSelected ? "#0b3d4c" : selectionHighlighted ? "#1d4ed8" : colored.stroke,
    weight: isSelected ? 3 : isHighlighted ? 3.2 : (status === "none" ? 0.9 : 1.35),
    opacity: dimmed ? 0.16 : 0.95,
    fillColor: isSelected ? "#028090" : selectionHighlighted ? "#2563eb" : colored.fill,
    fillOpacity: dimmed ? 0.05 : (isSelected ? 0.42 : selectionHighlighted ? 0.78 : isHighlighted ? Math.max(colored.opacity, 0.5) : colored.opacity),
  };
}

function sensorStatusKey(s) {
  if (!s.has_data) return "no_data";
  return "with_data";
}

function wardStatusKey(p) {
  if (analyticsLoaded && isAnalysisLens(currentLens)) return mapAnalysisWardStatusKey(p.ward_no);
  const total = p.sensor_total || 0;
  const withData = p.sensor_with_data || 0;
  if (!total && !withData) return "none";
  const ratio = total ? withData / total : 0;
  if (withData >= 5 || ratio >= 0.75) return "high";
  return "low";
}

function wardReadingLoad(p) {
  return (sensorsByWard[p.ward_no] || []).reduce((sum, s) => sum + (s.reading_count || 0), 0);
}

function wardColor(p) {
  if (analyticsLoaded && isAnalysisLens(currentLens)) {
    const key = mapAnalysisWardStatusKey(p.ward_no);
    if (key === "none") return BASE_WARD_COLOR;
    return {
      fill: CRITICALITY_COLORS[key] || BASE_WARD_COLOR.fill,
      stroke: CRITICALITY_COLORS[key] || BASE_WARD_COLOR.stroke,
      opacity: 1,
    };
  }
  const values = wards ? wards.features.map(f => currentLens === "readings" ? wardReadingLoad(f.properties) : (f.properties.sensor_with_data || 0)) : [];
  const color = choroColor(currentLens === "readings" ? wardReadingLoad(p) : (p.sensor_with_data || 0), computeBreaks(values));
  return { fill: color, stroke: "#5a7a86", opacity: (p.sensor_with_data || 0) ? 0.3 : 0.12 };
}

function normalizeWardNo(value) {
  if (value == null || value === "") return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function isYes(value) {
  return String(value || "").trim().toLowerCase() === "yes";
}

const LINEAR_DECLINE_THRESHOLD_FT_PER_WEEK = 0.1;
const TREND_SIGNIFICANCE_ALPHA = 0.05;
const GROUNDWATER_MIN_MK_WEEKS_MODERN = 30;
const GROUNDWATER_MIN_MK_WEEKS_LEGACY = 8;
const PREVIOUS_CONSUMPTION_CRITICAL_WARDS = new Set([
  48, 33, 13, 122, 102, 161, 22, 195, 127, 116,
  15, 183, 74, 37, 68, 31, 19, 187, 43, 28,
  123, 134, 14, 130, 69, 32, 57, 186, 189, 190,
  163, 39, 185, 124, 10, 156, 103, 71, 148, 128,
  81, 21, 6, 75, 49, 171, 30, 70, 126, 36,
  8, 133, 131, 97, 121, 101, 164, 18, 144, 40
]);

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function calculateGroundwaterCriticality(input = {}) {
  // Backend-classification passthrough: honour file's dashboardMapCategory when present.
  const backendCats = new Set(["Critical: Ward-average groundwater decline",
    "Confirmed groundwater rise","Possible groundwater rise","Stable groundwater trend","Insufficient data"]);
  if (criticalityMethod === "modern" && input.dashboardMapCategory && backendCats.has(input.dashboardMapCategory)) {
    const backendCat = input.dashboardMapCategory;
    const isCritical = backendCat === "Critical: Ward-average groundwater decline";
    return {
      ...input,
      groundwaterStatus: isCritical ? "Critical" : (backendCat === "Insufficient data" ? "Insufficient data" : "Normal"),
      groundwaterDirection: isCritical ? "Declining"
        : backendCat === "Confirmed groundwater rise" ? "Improving"
        : backendCat === "Possible groundwater rise" ? "Possible improvement"
        : backendCat === "Stable groundwater trend" ? "Stable" : "Not computed",
      dashboardAction: isCritical ? "Yes" : "No",
      dashboardMapCategory: backendCat,
      linearMethodCritical: isCritical ? "Yes" : "No",
      theilSenMethodCritical: isCritical ? "Yes" : "No",
      mannKendallMethodCritical: input.mannKendallVerdict === "Yes" ? "Yes" : "No",
      linearMannKendallCritical: input.linearMannKendallCritical || (isCritical ? "Yes" : "No"),
      theilSenMannKendallCritical: input.theilSenMannKendallCritical || (isCritical ? "Yes" : "No"),
      pointCount: input.usableWeeklyValues ?? input.pointCount ?? 0,
      hasTrendEvidence: backendCat !== "Insufficient data",
    };
  }

  const linear = numOrNull(input.linearSlopeFtPerWeek ?? input.weeklyChangeFtWeek ?? input.weekly_change_ft_week_from_dashboard_average);
  const theil = numOrNull(input.senSlopeFtPerWeek ?? input.theilSlopeFtPerWeek ?? linear);
  const mk = numOrNull(input.mannKendallS);
  const pValue = numOrNull(input.mannKendallPValue);
  const pointCount = numOrNull(input.pointCount ?? input.usableWeeklyValues ?? input.weeklyPointsUsed);
  const hasSlope = Number.isFinite(linear) || Number.isFinite(theil);
  const selectedSlope = Number.isFinite(linear) ? linear : theil;
  const hasTrendEvidence = hasSlope;
  const hasMannKendall = Number.isFinite(pointCount)
    && pointCount >= (criticalityMethod === 'legacy' ? GROUNDWATER_MIN_MK_WEEKS_LEGACY : GROUNDWATER_MIN_MK_WEEKS_MODERN)
    && Number.isFinite(mk)
    && Number.isFinite(pValue);
  const linearCritical = Number.isFinite(linear) && linear > LINEAR_DECLINE_THRESHOLD_FT_PER_WEEK;
  const theilCritical = Number.isFinite(theil) && theil > LINEAR_DECLINE_THRESHOLD_FT_PER_WEEK;
  const mannCritical = hasMannKendall && mk > 0 && pValue <= TREND_SIGNIFICANCE_ALPHA;
  const linearMannCritical = hasMannKendall ? linearCritical && mannCritical : linearCritical;
  const theilMannCritical = hasMannKendall ? theilCritical && mannCritical : theilCritical;
  const rising = Number.isFinite(selectedSlope) && selectedSlope < -LINEAR_DECLINE_THRESHOLD_FT_PER_WEEK;
  const critical = linearMannCritical || theilMannCritical;
  const stable = hasTrendEvidence && !critical && !rising;
  const category = critical
    ? "Critical: Ward-average groundwater decline"
    : rising
    ? "Possible groundwater rise"
    : stable
    ? "Stable groundwater trend"
    : "Insufficient groundwater data";
  return {
    ...input,
    groundwaterStatus: critical ? "Critical" : hasTrendEvidence ? "Normal" : "Insufficient data",
    groundwaterDirection: critical ? "Declining" : rising ? "Possible improvement" : stable ? "Stable" : "Not computed",
    dashboardAction: critical ? "Yes" : "No",
    dashboardMapCategory: category,
    linearMethodCritical: linearCritical ? "Yes" : "No",
    theilSenMethodCritical: theilCritical ? "Yes" : "No",
    mannKendallMethodCritical: mannCritical ? "Yes" : "No",
    linearMannKendallCritical: linearMannCritical ? "Yes" : "No",
    theilSenMannKendallCritical: theilMannCritical ? "Yes" : "No",
    linearSlopeFtPerWeek: linear,
    senSlopeFtPerWeek: theil,
    declineStrengthFtPerWeek: selectedSlope,
    hasTrendEvidence,
    oldConsumptionNoGroundwaterData: isYes(input.previousCriticalWard) && !hasTrendEvidence ? "Yes" : "No",
  };
}

function methodVotesForCritical(critical = {}) {
  return {
    linear: isYes(critical.linearMethodCritical),
    theil: isYes(critical.theilSenMethodCritical),
    mann: isYes(critical.mannKendallMethodCritical),
  };
}

function selectedGroundwaterMethodIsCritical(critical = {}, mode = groundwaterMethodMode) {
  const votes = methodVotesForCritical(critical);
  // Standard MK vote already in `votes.mann` — uses input.mannKendallMethodCritical.
  // Modified MK vote: recompute using the ACR-corrected p that the backend stamped.
  // In modern mode the backend already ran Modified MK, so mannKendallVerdict IS modified MK.
  // In legacy mode we have no modified MK data, so treat mk_mod == mk.
  const mkMod = (criticalityMethod === "legacy")
    ? votes.mann
    : (critical.mannKendallVerdict === "Yes" && (Number(critical.linearSlopeFtPerWeek) > 0 || Number(critical.senSlopeFtPerWeek) > 0));
  if (mode === "linear") return votes.linear;
  if (mode === "theil") return votes.theil;
  if (mode === "mann") return votes.mann;
  if (mode === "mk_mod") return mkMod;
  if (mode === "linear_theil") return votes.linear && votes.theil;
  if (mode === "linear_mann") return votes.linear && votes.mann;
  if (mode === "theil_mann") return votes.theil && votes.mann;
  if (mode === "linear_mk_mod") return votes.linear && mkMod;
  if (mode === "theil_mk_mod") return votes.theil && mkMod;
  if (mode === "linear_theil_mk_mod") return votes.linear && votes.theil && mkMod;
  if (mode === "all_three") return votes.linear && votes.theil && votes.mann;
  return false;
}

function groundwaterTrendPointCount(critical = {}) {
  const n = Number(critical.pointCount ?? critical.usableWeeklyValues ?? critical.weeklyPointsUsed ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function hasGroundwaterTrendEvidence(critical = {}) {
  if (typeof critical.hasTrendEvidence === "boolean") return critical.hasTrendEvidence;
  const linear = Number(critical.linearSlopeFtPerWeek);
  const theil = Number(critical.senSlopeFtPerWeek);
  return groundwaterTrendPointCount(critical) >= GROUNDWATER_MIN_SLOPE_WEEKS && (Number.isFinite(linear) || Number.isFinite(theil));
}

function isGroundwaterRiseWard(critical = {}) {
  return critical.dashboardMapCategory === "Confirmed groundwater rise"
    || critical.dashboardMapCategory === "Possible groundwater rise"
    || critical.groundwaterDirection === "Improving"
    || critical.groundwaterDirection === "Possible improvement"
    || critical.groundwaterRiseOverride === "Yes";
}

function groundwaterWardStatusKey(wardNo) {
  const critical = criticalGroundwaterByNo.get(normalizeWardNo(wardNo));
  if (!critical) return "none";
  if (isGroundwaterRiseWard(critical)) return "rise";
  if (selectedGroundwaterMethodIsCritical(critical)) return "critical";
  if (hasGroundwaterTrendEvidence(critical)) return "stable";
  return "none";
}

function isAnalysisLens(value) {
  return ["groundwater", "volumetric_deficit", "extraction", "pumping_stress", "consumption", "specific_capacity", "current_stress"].includes(value);
}

function pumpingWardSummaryForNo(wardNo) {
  const raw = pumpingPerformanceWardSummaryByNo.get(normalizeWardNo(wardNo));
  if (!raw) return null;
  const totalPumpedVolumeM3 = numOrNull(raw.totalPumpedVolumeM3);
  const medianSpecificCapacityScaled = numOrNull(raw.medianSpecificCapacityScaled);
  const medianNormalizedDrawdownFtPerM3 = numOrNull(raw.medianNormalizedDrawdownFtPerM3);
  const extractionP75M3 = numOrNull(pumpingPerformanceWardThresholds.extractionP75M3);
  const specificCapacityP25Scaled = numOrNull(pumpingPerformanceWardThresholds.specificCapacityP25Scaled);
  const normalizedDrawdownP75FtPerM3 = numOrNull(pumpingPerformanceWardThresholds.normalizedDrawdownP75FtPerM3);
  return {
    ...raw,
    totalPumpedVolumeM3,
    medianSpecificCapacityScaled,
    medianNormalizedDrawdownFtPerM3,
    criticalByExtraction: totalPumpedVolumeM3 != null && extractionP75M3 != null && totalPumpedVolumeM3 >= extractionP75M3,
    criticalBySpecificCapacity: medianSpecificCapacityScaled != null && specificCapacityP25Scaled != null && medianSpecificCapacityScaled <= specificCapacityP25Scaled,
    highNormalizedDrawdown: medianNormalizedDrawdownFtPerM3 != null && normalizedDrawdownP75FtPerM3 != null && medianNormalizedDrawdownFtPerM3 >= normalizedDrawdownP75FtPerM3,
  };
}

function isPreviousConsumptionCriticalWard(wardNo) {
  const normalized = normalizeWardNo(wardNo);
  if (PREVIOUS_CONSUMPTION_CRITICAL_WARDS.has(normalized)) return true;
  const c = criticalGroundwaterByNo.get(normalizeWardNo(wardNo));
  return isYes(c?.previousCriticalWard) || isYes(c?.oldConsumptionNoGroundwaterData);
}

function wardVolumetricDeficit(wardNo) {
  const local = volumetricDeficitByNo.get(normalizeWardNo(wardNo));
  const feature = wards?.features?.find(f => normalizeWardNo(f.properties.ward_no) === normalizeWardNo(wardNo));
  if (local) {
    const slope = numOrNull(local.slopeFtPerWeek);
    const durationDays = Math.max(numOrNull(local.durationDays) || 0, 30);
    const areaKm2 = Number(feature?.properties?.area_km2 ?? 8);
    if (!Number.isFinite(slope) || slope <= 0) return { ...local, deficitMl: 0, deficitM3: 0, deficitTankers: 0 };
    const totalDropM = slope * (durationDays / 7) * 0.3048;
    const deficitM3 = areaKm2 * 1000000 * totalDropM * 0.02;
    return {
      ...local,
      deficitMl: deficitM3 / 1000,
      deficitM3,
      deficitTankers: deficitM3 / 12,
      durationDays,
    };
  }
  const ward = criticalGroundwaterByNo.get(normalizeWardNo(wardNo));
  const rawMl = ward?.volumetric_deficit_ml ?? ward?.volumetricDeficitMl;
  if (rawMl != null && Number.isFinite(Number(rawMl)) && Number(rawMl) > 0) return { deficitMl: Number(rawMl) };
  const slope = Number(ward?.senSlopeFtPerWeek ?? ward?.linearSlopeFtPerWeek ?? 0);
  if (!Number.isFinite(slope) || slope <= 0) return { deficitMl: 0 };
  const areaKm2 = Number(feature?.properties?.area_km2 ?? 8);
  const pointCount = Number(ward?.usableWeeklyValues ?? ward?.pointCount ?? 8);
  const durationDays = Math.max(pointCount * 7, 30);
  const totalDropM = slope * (durationDays / 7) * 0.3048;
  return { deficitMl: (areaKm2 * 1000000 * totalDropM * 0.02) / 1000 };
}

function overallCriticalLensFlags(wardNo) {
  const pumping = pumpingWardSummaryForNo(wardNo);
  const vd = wardVolumetricDeficit(wardNo);
  return {
    groundwater: groundwaterWardStatusKey(wardNo) === "critical",
    volumetric_deficit: vd.deficitMl >= 10,
    extraction: Boolean(pumping?.criticalByExtraction),
    pumping_stress: Boolean(pumping?.highNormalizedDrawdown),
    specific_capacity: Boolean(pumping?.criticalBySpecificCapacity),
  };
}

function commonLensHitCount(wardNo) {
  return Object.values(overallCriticalLensFlags(wardNo)).filter(Boolean).length;
}

function commonLensThreshold() {
  const input = document.getElementById("common-threshold");
  const raw = Number(input?.value ?? 2);
  const value = Number.isFinite(raw) ? Math.round(raw) : 2;
  return Math.max(1, Math.min(5, value));
}

function mapAnalysisWardStatusKey(wardNo) {
  if (currentLens === "consumption") return isPreviousConsumptionCriticalWard(wardNo) ? "critical" : "none";
  if (currentLens === "volumetric_deficit") {
    const vd = wardVolumetricDeficit(wardNo);
    return vd.deficitMl >= 10 ? "critical" : vd.deficitMl > 0 ? "stable" : "none";
  }
  if (currentLens === "extraction") {
    const pumping = pumpingWardSummaryForNo(wardNo);
    if (!pumping) return "none";
    return pumping.criticalByExtraction ? "critical" : "stable";
  }
  if (currentLens === "current_stress") {
    const cs = currentStressByNo.get(normalizeWardNo(wardNo));
    if (!cs) return "none";
    const cat = cs.stressCategory || "";
    if (cat.startsWith("Critical")) return "critical";
    if (cat.startsWith("Elevated")) return "rise";
    if (cat.startsWith("Normal") || cat.startsWith("Below")) return "stable";
    return "none";
  }
  if (currentLens === "specific_capacity") {
    const pumping = pumpingWardSummaryForNo(wardNo);
    if (!pumping) return "none";
    return pumping.criticalBySpecificCapacity ? "critical" : "stable";
  }
  if (currentLens === "pumping_stress") {
    const pumping = pumpingWardSummaryForNo(wardNo);
    if (!pumping) return "none";
    return pumping.highNormalizedDrawdown ? "critical" : "stable";
  }
  return groundwaterWardStatusKey(wardNo);
}

function groundwaterMethodLabel() {
  return ({
    linear_mk_mod: "Linear slope + Modified Mann-Kendall",
    theil_mk_mod: "Theil-Sen + Modified Mann-Kendall",
    linear_theil_mk_mod: "Linear slope + Theil-Sen + Modified MK",
    mk_mod: "Modified Mann-Kendall (Hamed-Rao)",
    dashboard: "Linear slope + Mann-Kendall with Review",
    linear: "Linear slope only",
    theil: "Theil-Sen only",
    mann: "Mann-Kendall only",
    linear_theil: "Linear slope + Theil-Sen",
    linear_mann: "Linear slope + Mann-Kendall",
    theil_mann: "Theil-Sen + Mann-Kendall",
    all_three: "Linear slope + Theil-Sen + Standard MK",
  })[groundwaterMethodMode] || "Linear slope + Mann-Kendall with Review";
}

function analysisLensLabel(value = currentLens) {
  return ({
    groundwater: "Groundwater Decline",
    volumetric_deficit: "High Volumetric Deficit (ML)",
    extraction: "High Extraction",
    pumping_stress: "Volume-normalized Drawdown",
    consumption: "Previous Consumption Criticality",
    specific_capacity: "Low Specific Capacity",
    current_stress: "Current Stress Percentile",
    coverage: "Sensor Coverage",
    readings: "Reading Load",
  })[value] || "Groundwater Decline";
}

function analysisCriticalLabel(value = currentLens) {
  return ({
    groundwater: "Critical: GW Decline",
    volumetric_deficit: "Critical: High Volumetric Loss",
    extraction: "Critical: High Extraction",
    pumping_stress: "Critical: High Volume-normalized Drawdown",
    consumption: "Previous Consumption Critical",
    specific_capacity: "Critical: Low Specific Capacity",
    current_stress: "Critical: Currently deep vs own history",
  })[value] || "Critical ward";
}

function stableStatusLabel(value = currentLens) {
  if (value === "groundwater") return "No strong trend";
  if (value === "current_stress") return "Normal / recovered";
  if (["extraction", "pumping_stress", "specific_capacity", "volumetric_deficit"].includes(value)) return "Below threshold";
  return "No strong trend";
}

function groundwaterWardSummary(wardNo) {
  const c = criticalGroundwaterByNo.get(normalizeWardNo(wardNo));
  if (!c) return null;
  const slope = Number.isFinite(Number(c.senSlopeFtPerWeek)) ? Number(c.senSlopeFtPerWeek) : Number(c.linearSlopeFtPerWeek);
  return {
    status: groundwaterWardStatusKey(wardNo),
    category: c.dashboardMapCategory || c.groundwaterStatus || "Not classified",
    direction: c.groundwaterDirection || "Not computed",
    reason: c.updateReason || c.skippedReasonDetails || "",
    points: groundwaterTrendPointCount(c),
    slope: Number.isFinite(slope) ? slope : null,
    previousCritical: isPreviousConsumptionCriticalWard(wardNo),
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
let currentLens = "coverage";
let criticalityMethod = "modern";
let wardStatusFilter = "";
let sensorStatusFilter = "with_data";
let groundwaterMethodMode = "linear_mk_mod";
let charts = { water: null, discharge: null, modal: null };
let currentSensorSeries = null;   // cached
let selectedSensorUid = null;
let currentRange = "1M";

// ---------- Palette (choropleth: light -> dark, distinct by lens) ----------
const CHORO = ["#f0f9fb", "#d3ecf1", "#a8d8e2", "#79c1d1", "#4ea6bd", "#2f8ba3", "#1c6e88", "#0e5670"];
const CRITICALITY_COLORS = { critical: "rgb(255, 0, 0)", rise: "rgb(0, 255, 0)", stable: "rgb(255, 255, 0)", none: "#e2e8f0" };
const BASE_WARD_COLOR = { fill: "#a8d8e2", stroke: "#5a7a86", opacity: 0.22 };
const SENSOR_COLORS = { with_data: "#0e7490", no_data: "#64748b" };
const GROUNDWATER_MIN_SLOPE_WEEKS = 4;

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
  wireKpiCards();
  wireDetailClose();
  try {
    await loadData();
    updateMetrics();
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
  const [ws, ss, mf, qs, analytics, qcPayload] = await Promise.all([
    fetch(urlOf("wards.geojson")).then(r => r.json()),
    fetch(urlOf("sensors.json")).then(r => r.json()),
    fetch(urlOf("manifest.json")).then(r => r.json()),
    fetch("./data/session_quality_summary.json").then(r => r.ok ? r.json() : null).catch(() => null),
    loadAnalyticsData(),
    fetch("./data/sensor_qc.json").then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (qcPayload && Array.isArray(qcPayload.sensors)) {
    for (const row of qcPayload.sensors) sensorQcByUid.set(String(row.uid), row);
  }
  wards = ws;
  sensors = mergeSensorInventory(ss, analytics.fullSensors || []);
  manifest = mf;
  sessionSummary = qs;
  currentStressByNo = new Map((analytics.currentStress?.wards || [])
    .map(w => [normalizeWardNo(w.wardNo), w])
    .filter(([k]) => k != null));
  criticalGroundwaterByNo = new Map((analytics.criticalGroundwater?.wards || [])
    .map(calculateGroundwaterCriticality)
    .map(item => [normalizeWardNo(item.wardNo), item])
    .filter(([k]) => k != null));
  pumpingPerformanceWardSummaryByNo = new Map((analytics.pumpingPerformance?.wards || []).map(item => [normalizeWardNo(item.wardNo), item]).filter(([k]) => k != null));
  pumpingPerformanceWardThresholds = analytics.pumpingPerformance?.thresholds || {};
  volumetricDeficitByNo = new Map((analytics.volumetricDeficit?.wards || []).map(item => [normalizeWardNo(item.wardNo), item]).filter(([k]) => k != null));
  analyticsLoaded = criticalGroundwaterByNo.size > 0;
  if (analyticsLoaded) currentLens = "groundwater";
  console.info("[dashboard] loaded", { wards: wards.features.length, sensors: sensors.length, sensorsWithData: sensors.filter(s => s.has_data).length, manifest });
  for (const s of sensors) {
    sensorsByUid[s.uid] = s;
    if (s.ward_no != null) (sensorsByWard[s.ward_no] = sensorsByWard[s.ward_no] || []).push(s);
  }
  recomputeWardSensorCounts();
  syncAnalyticsControls();
}

async function loadAnalyticsData() {
  const fetchJson = async (path, fallback) => {
    try {
      const res = await fetch(`${ANALYTICS_API_BASE}${path}`);
      return res.ok ? await res.json() : fallback;
    } catch (err) {
      console.warn("[dashboard] analytics API unavailable", path, err);
      return fallback;
    }
  };
  const fetchLocalJson = async (path, fallback) => {
    try {
      const res = await fetch(path);
      return res.ok ? await res.json() : fallback;
    } catch (err) {
      console.warn("[dashboard] local analytics asset unavailable", path, err);
      return fallback;
    }
  };
  const [sensorPayload, criticalGroundwater, pumpingPerformance] = await Promise.all([
    fetchJson("/api/sensors?source=kh", { sensors: [] }),
    fetchJson("/api/critical-wards-groundwater", { wards: [] }),
    fetchJson("/api/pumping-performance/wards?cache_v=pump-kh-cycles-20260831-1", { wards: [], thresholds: {} }),
  ]);
  const localCriticalGroundwater = await fetchLocalJson(`./data/critical_groundwater_ward_summary.json?ts=${Date.now()}`, { wards: [] });
  const hasActiveGroundwaterClasses = (criticalGroundwater?.wards || []).some(item => (
    isYes(item.dashboardAction)
    || item.groundwaterStatus === "Critical"
    || item.dashboardMapCategory === "Critical: Ward-average groundwater decline"
    || item.dashboardMapCategory === "Confirmed groundwater rise"
    || item.dashboardMapCategory === "Possible groundwater rise"
    || item.dashboardMapCategory === "Stable groundwater trend"
  ));
  // LOCAL_STATIC_OVERRIDE: prefer local static-only file when it has data.
  const hasLocalGroundwater = (localCriticalGroundwater?.wards || []).length > 0;
  const activeCriticalGroundwater = hasLocalGroundwater ? localCriticalGroundwater : (hasActiveGroundwaterClasses ? criticalGroundwater : localCriticalGroundwater);
  // LOCAL_OVERRIDE: always prefer local pumping performance (augmented with flags)
  const localPumpingPerformance = await fetchLocalJson(`./data/pumping_performance_ward_summary.json?ts=${Date.now()}`, { wards: [], thresholds: {} });
  const volumetricDeficit = await fetchLocalJson("./data/ward_volumetric_deficit_summary.json", { wards: [] });
  const currentStress = await fetchLocalJson(`./data/current_stress_ward_summary.json?ts=${Date.now()}`, { wards: [] });
  return { fullSensors: sensorPayload.sensors || [], criticalGroundwater: activeCriticalGroundwater, pumpingPerformance: localPumpingPerformance, volumetricDeficit, currentStress };
}


async function loadCriticalityForMethod(method) {
  const path = method === "legacy" ? "./data/critical_groundwater_ward_summary_legacy.json" : "./data/critical_groundwater_ward_summary.json";
  try {
    const res = await fetch(`${path}?ts=${Date.now()}`);
    if (!res.ok) return { wards: [] };
    return await res.json();
  } catch (e) { console.warn("[dash] load crit failed", e); return { wards: [] }; }
}

function normalizeApiSensor(s) {
  return {
    uid: String(s.uid || ""),
    lat: s.lat,
    lng: s.lng,
    ward_no: normalizeWardNo(s.ward_no ?? s.wardNo),
    ward_name: s.ward_name ?? s.wardName ?? null,
    motor_hp: s.motor_hp ?? s.motorHp ?? null,
    borewell_depth: s.borewell_depth ?? s.borewellDepth ?? null,
    pump_name: s.pump_name ?? s.pumpName ?? "",
    has_data: Boolean(s.has_data ?? s.hasData),
    data_category: s.data_category ?? s.dataCategory ?? (s.has_data || s.hasData ? "both" : "none"),
    reading_count: Number(s.reading_count ?? s.totalReadings ?? s.waterReadings ?? 0),
    first_data_at: s.first_data_at ?? s.firstDataAt ?? null,
    last_data_at: s.last_data_at ?? s.lastDataAt ?? null,
  };
}

function mergeSensorInventory(localSensors, apiSensors) {
  const merged = new Map();
  for (const s of apiSensors.map(normalizeApiSensor)) {
    if (!s.uid) continue;
    merged.set(s.uid, s);
  }
  for (const local of localSensors.map(normalizeApiSensor)) {
    const existing = merged.get(local.uid) || {};
    merged.set(local.uid, {
      ...existing,
      ...local,
      has_data: local.has_data || existing.has_data || false,
      data_category: local.data_category || existing.data_category || "none",
      reading_count: local.reading_count || existing.reading_count || 0,
      first_data_at: local.first_data_at || existing.first_data_at || null,
      last_data_at: local.last_data_at || existing.last_data_at || null,
    });
  }
  const out = [...merged.values()].filter(s => s.uid);
  assignMissingSensorWards(out);
  return out;
}

function assignMissingSensorWards(items) {
  if (!wards?.features?.length) return;
  const features = wards.features.map(f => ({ feature: f, bounds: featureBounds(f) }));
  for (const s of items) {
    if (s.ward_no != null || s.lat == null || s.lng == null) continue;
    const hit = features.find(({ feature, bounds }) => pointInBounds(s.lng, s.lat, bounds) && pointInFeature(s.lng, s.lat, feature));
    if (hit) {
      s.ward_no = normalizeWardNo(hit.feature.properties.ward_no);
      s.ward_name = hit.feature.properties.ward_name;
    }
  }
}

function featureBounds(feature) {
  const coords = [];
  const walk = arr => Array.isArray(arr?.[0]) && typeof arr[0][0] === "number" ? coords.push(...arr) : arr.forEach(walk);
  walk(feature.geometry.coordinates);
  return coords.reduce((b, [lng, lat]) => ({
    minLng: Math.min(b.minLng, lng), maxLng: Math.max(b.maxLng, lng),
    minLat: Math.min(b.minLat, lat), maxLat: Math.max(b.maxLat, lat),
  }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
}

function pointInBounds(lng, lat, b) {
  return lng >= b.minLng && lng <= b.maxLng && lat >= b.minLat && lat <= b.maxLat;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInFeature(lng, lat, feature) {
  const polys = feature.geometry.type === "MultiPolygon" ? feature.geometry.coordinates : [feature.geometry.coordinates];
  return polys.some(poly => pointInRing(lng, lat, poly[0]) && !poly.slice(1).some(hole => pointInRing(lng, lat, hole)));
}

function recomputeWardSensorCounts() {
  for (const f of wards.features) {
    const list = sensorsByWard[normalizeWardNo(f.properties.ward_no)] || [];
    f.properties.sensor_total = list.length;
    f.properties.sensor_with_data = list.filter(s => s.has_data).length;
  }
}

function syncAnalyticsControls() {
  const lensSelect = document.getElementById("analysis-lens");
  if (lensSelect) lensSelect.value = currentLens;
  const methodSelect = document.getElementById("groundwater-method");
  if (methodSelect) methodSelect.value = groundwaterMethodMode;
  const methodRow = document.getElementById("groundwater-method-row");
  if (methodRow) methodRow.hidden = !(analyticsLoaded && currentLens === "groundwater");
  const note = document.getElementById("analytics-note");
  if (note) note.textContent = analyticsLoaded
    ? "Earlier-dashboard ward criticality and the full 1,594-device inventory are loaded. Raw water-level/discharge series are not imported here."
    : "Earlier-dashboard analytics are unavailable right now, so the dashboard is using local coverage and reading-load lenses.";
}

function activeWardPropsForDetail() {
  if (selectedWardNo == null || !wards) return null;
  return wards.features.find(f => normalizeWardNo(f.properties.ward_no) === normalizeWardNo(selectedWardNo))?.properties || null;
}

function updateMetrics() {
  _guardLens();
  clearKpiHighlightState();
  const number = v => v == null ? "—" : Number(v).toLocaleString("en-IN");
  const usableSet = new Set(["GOOD","USABLE_WITH_CAUTION"]);
  const reporting = sensors.filter(s => {
    if (!s) return false;
    const qc = sensorQcByUid.get(String(s.uid));
    return qc ? usableSet.has(qc.qc_status) : !!s.has_data;
  }).length;
  document.getElementById("metric-total-sensors").textContent = number(reporting);
  const wardsWithData = wards?.features?.filter(f => (f.properties.sensor_with_data || 0) > 0).length || 0;
  document.getElementById("metric-wards").textContent = `${number(wardsWithData)}/${number(wards?.features?.length || manifest?.wards || 0)}`;
  updateLensCounts();
}

function updateLensCounts() {
  let critical = 0, rise = 0, stable = 0;
  if (wards?.features) {
    for (const f of wards.features) {
      const key = wardStatusKey(f.properties);
      if (key === "critical") critical++;
      else if (key === "rise") rise++;
      else if (key === "stable") stable++;
    }
  }
  const num = v => Number(v).toLocaleString("en-IN");
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = num(val); };
  set("metric-critical", critical);
  set("metric-rise", rise);
  set("metric-stable", stable);
  const lbl = document.getElementById("metric-critical-label");
  if (lbl && typeof analysisLensLabel === "function") {
    lbl.textContent = `Deepening · ${analysisLensLabel()}`;
  }
  const stableLbl = document.getElementById("metric-stable-label");
  if (stableLbl) stableLbl.textContent = stableStatusLabel();
  const stableChip = document.getElementById("ward-stable-chip");
  if (stableChip) stableChip.textContent = stableStatusLabel();
}

function wardFeaturesForKpi(kind) {
  if (!wards?.features) return [];
  if (kind === "total") {
    return wards.features.filter(f => (f.properties.sensor_total || 0) > 0 || (sensorsByWard[f.properties.ward_no] || []).length > 0);
  }
  if (kind === "covered") {
    return wards.features.filter(f => (f.properties.sensor_with_data || 0) > 0);
  }
  return wards.features.filter(f => wardStatusKey(f.properties) === kind);
}

function fitHighlightedWards(features) {
  if (!features.length || !map || !wardLayer) return;
  const wanted = new Set(features.map(f => normalizeWardNo(f.properties.ward_no)));
  const bounds = L.latLngBounds([]);
  wardLayer.eachLayer(layer => {
    const wardNo = normalizeWardNo(layer.feature?.properties?.ward_no);
    if (wanted.has(wardNo) && typeof layer.getBounds === "function") {
      bounds.extend(layer.getBounds());
    }
  });
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [44, 44], maxZoom: 13 });
}

function applyKpiHighlight(kind) {
  if (!wards?.features) return;
  const features = wardFeaturesForKpi(kind);
  highlightedWardNos = new Set(features.map(f => normalizeWardNo(f.properties.ward_no)));
  highlightStyleMode = "quick";
  selectedWardNo = null;
  selectedSensorUid = null;
  const labels = {
    total: "Highlighted: wards with sensors",
    covered: "Highlighted: wards covered by reporting sensors",
    critical: `Highlighted: ${analysisCriticalLabel()}`,
    rise: "Highlighted: rising wards",
    stable: `Highlighted: ${stableStatusLabel()} wards`
  };
  quickViewLabel = labels[kind] || "Highlighted wards";
  document.querySelectorAll("[data-kpi-highlight]").forEach(card => {
    card.classList.toggle("active", card.dataset.kpiHighlight === kind);
  });
  closeAllOverlays();
  if (wardLayer) wardLayer.setStyle(defaultWardStyle);
  renderSensors();
  buildLegend();
  fitHighlightedWards(features);
}

function updateCommonQueryNote(count = null, threshold = commonLensThreshold()) {
  const note = document.getElementById("common-query-note");
  if (!note) return;
  const suffix = count == null ? "" : ` ${count.toLocaleString("en-IN")} wards match.`;
  note.textContent = `Highlights wards active in at least ${threshold} of 5 component lenses.${suffix}`;
}

function applyQueryResult(features, label) {
  highlightedWardNos = new Set(features.map(f => normalizeWardNo(f.properties.ward_no)));
  highlightStyleMode = "query";
  selectedWardNo = null;
  selectedSensorUid = null;
  wardStatusFilter = "";
  quickViewLabel = label;
  clearKpiHighlightState();
  document.querySelectorAll("[data-ward-status]").forEach(c => c.classList.toggle("active", c.dataset.wardStatus === ""));
  closeAllOverlays();
  if (wardLayer) wardLayer.setStyle(defaultWardStyle);
  renderSensors();
  buildLegend();
  updateCommonQueryNote(features.length, commonLensThreshold());
  fitHighlightedWards(features);
}

function applyCommonQuery() {
  if (!wards?.features) return;
  const threshold = commonLensThreshold();
  const input = document.getElementById("common-threshold");
  if (input) input.value = String(threshold);
  const features = wards.features.filter(f => commonLensHitCount(f.properties.ward_no) >= threshold);
  applyQueryResult(features, `Highlighted: Common query >= ${threshold}/5 lenses`);
  updateCommonQueryNote(features.length, threshold);
}

function queryPresetFeatures(preset) {
  if (!wards?.features) return [];
  return wards.features.filter(f => {
    const wardNo = f.properties.ward_no;
    if (preset === "groundwater_critical") return groundwaterWardStatusKey(wardNo) === "critical";
    if (preset === "previous_consumption") return isPreviousConsumptionCriticalWard(wardNo);
    if (preset === "volumetric_deficit") return wardVolumetricDeficit(wardNo).deficitMl >= 10;
    const pumping = pumpingWardSummaryForNo(wardNo);
    if (preset === "extraction") return Boolean(pumping?.criticalByExtraction);
    if (preset === "pumping_stress") return Boolean(pumping?.highNormalizedDrawdown);
    if (preset === "specific_capacity") return Boolean(pumping?.criticalBySpecificCapacity);
    if (preset === "current_stress_critical") return currentStressByNo.get(normalizeWardNo(wardNo))?.stressCategory?.startsWith("Critical");
    if (preset === "current_stress_elevated") return currentStressByNo.get(normalizeWardNo(wardNo))?.stressCategory?.startsWith("Elevated");
    return false;
  });
}

function queryPresetLabel(preset) {
  return ({
    groundwater_critical: "Query result: Groundwater critical",
    previous_consumption: "Query result: Previous consumption critical",
    volumetric_deficit: "Query result: High volumetric deficit",
    extraction: "Query result: High extraction",
    pumping_stress: "Query result: Volume-normalized drawdown",
    specific_capacity: "Query result: Low specific capacity",
    current_stress_critical: "Query result: Current stress critical",
    current_stress_elevated: "Query result: Current stress elevated",
  })[preset] || "Query result";
}

function applyPresetQuery(preset) {
  const features = queryPresetFeatures(preset);
  applyQueryResult(features, queryPresetLabel(preset));
}

function clearKpiHighlightState() {
  document.querySelectorAll("[data-kpi-highlight]").forEach(card => card.classList.remove("active"));
}

function wireKpiCards() {
  document.querySelectorAll("[data-kpi-highlight]").forEach(card => {
    const run = () => applyKpiHighlight(card.dataset.kpiHighlight);
    card.addEventListener("click", run);
    card.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        run();
      }
    });
  });
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
      const cs = currentStressByNo.get(String(p.ward_no));
      let fiveNumRow = "";
      let confidenceBadge = "";
      if (cs && cs.wells && cs.wells.length) {
        const levels = cs.wells.map(w => w.current_ft).filter(v => Number.isFinite(v)).sort((a,b)=>a-b);
        if (levels.length) {
          const q = (arr, p) => arr[Math.min(arr.length-1, Math.max(0, Math.round(p*(arr.length-1))))];
          const fmt = v => v.toFixed(0);
          fiveNumRow = `<div class="kv">Well depths (ft): min <b>${fmt(levels[0])}</b> · P25 <b>${fmt(q(levels,0.25))}</b> · med <b>${fmt(q(levels,0.5))}</b> · P75 <b>${fmt(q(levels,0.75))}</b> · max <b>${fmt(levels[levels.length-1])}</b></div>`;
        }
        const n = cs.wellCount || 0;
        const conf = n >= 5 ? "High" : n >= 3 ? "Medium" : "Low";
        const color = n >= 5 ? "#059669" : n >= 3 ? "#d97706" : "#b91c1c";
        confidenceBadge = `<div class="kv">Confidence: <b style="color:${color}">${conf}</b> (${n} well${n===1?"":"s"} with static data)</div>`;
      }
      const tip = `
        <div class="name">Ward ${p.ward_no} — ${p.ward_name}</div>
        <div class="kv">Sensors with data: <b>${p.sensor_with_data || 0}</b> / ${p.sensor_total || 0}</div>
        <div class="kv">Map status: <b>${wardStatusLabel(wardStatusKey(p))}</b></div>
        ${fiveNumRow}
        ${confidenceBadge}
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

function wardStatusLabel(key) {
  if (currentLens === "current_stress") {
    return ({ critical: "Critical current stress", rise: "Elevated current stress", stable: "Normal / recovered", none: "No current-stress data" })[key] || "All wards";
  }
  return ({ critical: "Critical", rise: "Rising / improving", stable: stableStatusLabel(), high: "High coverage", low: "Needs coverage", none: "No sensors" })[key] || "All wards";
}

// ---------- Sensors ----------
function renderSensors() {
  if (currentSensorMarkers) currentSensorMarkers.remove();
  currentSensorMarkers = L.layerGroup();
  const visible = filteredSensors();
  for (const s of visible) {
    const isSel = selectedSensorUid === s.uid;
    const status = sensorStatusKey(s);
    const m = L.circleMarker([s.lat, s.lng], {
      radius: isSel ? 11 : 6,
      color: isSel ? "#f59e0b" : "#ffffff",
      weight: isSel ? 3 : 1.6,
      fillColor: SENSOR_COLORS[status],
      fillOpacity: 0.95,
    });
    const wardLabel = s.ward_no != null ? `Ward ${s.ward_no} — ${s.ward_name || ""}` : "Unassigned";
    m.bindTooltip(`<b>${s.uid}</b><br/>${wardLabel}<br/>${sensorStatusLabel(status)}${s.last_data_at ? " · " + fmtDate(s.last_data_at) : ""}`, { className: "sensor-tip", direction: "top" });
    m.on("click", () => openSensorDetail(s.uid));
    currentSensorMarkers.addLayer(m);
    if (isSel) m.bringToFront();
  }
  currentSensorMarkers.addTo(map);
}

function sensorStatusLabel(key) {
  return ({ with_data: "Reporting", no_data: "No data" })[key] || "Sensor";
}

function sensorFilterMatch(s) {
  if (sensorStatusFilter === "all") return true;
  if (sensorStatusFilter === "with_data") return !!s.has_data;
  return sensorStatusKey(s) === sensorStatusFilter;
}

function filteredSensors() {
  return sensors.filter(s => {
    if (s.lat == null || s.lng == null) return false;
    if (selectedWardNo != null && s.ward_no !== selectedWardNo) return false;
    if (wardStatusFilter) {
      const wardProps = wards?.features?.find(f => f.properties.ward_no === s.ward_no)?.properties;
      if (!wardProps || wardStatusKey(wardProps) !== wardStatusFilter) return false;
    }
    return sensorFilterMatch(s);
  });
}

function visibleWardFeaturesForLegend() {
  if (!wards?.features) return [];
  return wards.features.filter(f => {
    const wardNo = normalizeWardNo(f.properties.ward_no);
    if (selectedWardNo != null && wardNo !== normalizeWardNo(selectedWardNo)) return false;
    if (highlightedWardNos.size > 0 && !highlightedWardNos.has(wardNo)) return false;
    if (wardStatusFilter && wardStatusKey(f.properties) !== wardStatusFilter) return false;
    return true;
  });
}

// ---------- Legend ----------
function buildLegend() {
  const el = document.getElementById("legend-scale");
  if (el) {
    el.style.display = isAnalysisLens(currentLens) ? "none" : "flex";
    el.innerHTML = CHORO.map(c => `<span style="background:${c}"></span>`).join("");
  }
  const items = document.getElementById("legend-items");
  if (items) {
    const visibleWards = visibleWardFeaturesForLegend();
    const wardItems = isAnalysisLens(currentLens) && analyticsLoaded
      ? [
          ["critical", CRITICALITY_COLORS.critical, analysisCriticalLabel()],
          ["rise", CRITICALITY_COLORS.rise, currentLens === "current_stress" ? "Elevated current stress" : "Groundwater Rise"],
          ["stable", CRITICALITY_COLORS.stable, stableStatusLabel()],
          ["none", BASE_WARD_COLOR.fill, "Other wards"],
        ]
          .filter(([key]) => key !== "rise" || ["groundwater", "current_stress"].includes(currentLens))
          .filter(([key]) => key !== "stable" || !["overall", "consumption"].includes(currentLens))
          .filter(([key]) => visibleWards.some(f => wardStatusKey(f.properties) === key))
          .map(([, color, label]) => [color, label])
      : visibleWards.some(f => (currentLens === "readings" ? wardReadingLoad(f.properties) : (f.properties.sensor_with_data || 0)) > 0)
      ? [
          [CHORO[1], currentLens === "readings" ? "Lower reading load" : "Lower coverage"],
          [CHORO[6], currentLens === "readings" ? "Higher reading load" : "Higher coverage"],
        ]
      : [];
    const selectionItems = ["query", "quick"].includes(highlightStyleMode) && highlightedWardNos.size
      ? [["#2563eb", quickViewLabel || "Highlighted wards"]]
      : [];
    const visibleSensorStatuses = new Set(filteredSensors().map(sensorStatusKey));
    const sensorItems = [
      ["with_data", SENSOR_COLORS.with_data, "Reporting sensor"],
      ["no_data", SENSOR_COLORS.no_data, "No-data sensor"],
    ]
      .filter(([key]) => visibleSensorStatuses.has(key))
      .map(([, color, label]) => [color, label]);
    items.innerHTML = [...selectionItems, ...wardItems, ...sensorItems]
      .map(([color, label]) => `<div class="legend-item"><span style="background:${color}"></span>${label}</div>`)
      .join("");
  }
  const cap = document.querySelector(".legend-caption");
  if (cap) {
    const lensLabel = isAnalysisLens(currentLens)
      ? `Wards classified by ${analysisLensLabel()}${currentLens === "groundwater" ? ` (${groundwaterMethodLabel()})` : ""}`
      : ({ coverage: "Wards shaded by reporting sensor coverage", readings: "Wards shaded by reading volume" })[currentLens];
    cap.textContent = selectedWardNo != null
      ? "Ward isolated - click map background to clear"
      : (["query", "quick"].includes(highlightStyleMode) ? lensLabel : (quickViewLabel || lensLabel));
  }
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
  const lensSelect = document.getElementById("analysis-lens");
  if (lensSelect) {
    lensSelect.addEventListener("change", () => {
      currentLens = lensSelect.value || "groundwater";
      syncAnalyticsControls();
      if (wardLayer) wardLayer.setStyle(defaultWardStyle);
      updateMetrics();
      buildLegend();
    });
  }
  const methodSelect = document.getElementById("groundwater-method");
  if (methodSelect) {
    methodSelect.addEventListener("change", () => {
      groundwaterMethodMode = methodSelect.value || "dashboard";
      if (wardLayer) wardLayer.setStyle(defaultWardStyle);
      updateMetrics();
      buildLegend();
      if (!document.getElementById("detail").hidden && activeWardPropsForDetail()) {
        openWardDetail(activeWardPropsForDetail());
      }
    });
  }
  const commonApply = document.getElementById("common-query-apply");
  const commonInput = document.getElementById("common-threshold");
  if (commonApply) commonApply.addEventListener("click", applyCommonQuery);
  if (commonInput) {
    commonInput.addEventListener("change", () => updateCommonQueryNote(null, commonLensThreshold()));
    commonInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        applyCommonQuery();
      }
    });
  }
  document.querySelectorAll("[data-query-preset]").forEach(chip => {
    chip.addEventListener("click", () => applyPresetQuery(chip.dataset.queryPreset));
  });
  document.querySelectorAll("[data-ward-status]").forEach(chip => {
    chip.addEventListener("click", () => {
      wardStatusFilter = chip.dataset.wardStatus;
      document.querySelectorAll("[data-ward-status]").forEach(c => c.classList.toggle("active", c === chip));
      if (wardLayer) wardLayer.setStyle(defaultWardStyle);
      renderSensors();
      buildLegend();
    });
  });
  document.querySelectorAll("[data-sensor-status]").forEach(chip => {
    chip.addEventListener("click", () => {
      sensorStatusFilter = chip.dataset.sensorStatus;
      document.querySelectorAll("[data-sensor-status]").forEach(c => c.classList.toggle("active", c === chip));
      renderSensors();
      buildLegend();
    });
  });
  const tvToggle = document.getElementById("tv-mode-toggle");
  if (tvToggle) {
    tvToggle.addEventListener("change", () => {
      document.body.classList.toggle("tv-mode", tvToggle.checked);
      setTimeout(() => map.invalidateSize(), 120);
    });
  }
  document.querySelectorAll("[data-quick]").forEach(chip => {
    chip.addEventListener("click", () => {
      const which = chip.dataset.quick;
      clearKpiHighlightState();
      highlightStyleMode = "";
      closeAllOverlays();
      if (which === "reset") {
        selectedWardNo = null;
        selectedSensorUid = null;
        highlightedWardNos = new Set();
        highlightStyleMode = "";
        quickViewLabel = "";
        wardStatusFilter = "";
        sensorStatusFilter = "with_data";
        currentLens = analyticsLoaded ? "groundwater" : "coverage";
        document.querySelectorAll("[data-ward-status]").forEach(c => c.classList.toggle("active", c.dataset.wardStatus === ""));
        document.querySelectorAll("[data-sensor-status]").forEach(c => c.classList.toggle("active", c.dataset.sensorStatus === "with_data"));
        syncAnalyticsControls();
        updateCommonQueryNote();
        if (wardLayer) wardLayer.setStyle(defaultWardStyle);
        renderSensors();
        buildLegend();
        map.setView([12.972, 77.594], 11);
        return;
      }
      if (which === "all_wards") {
        highlightedWardNos = new Set(wards.features.map(f => normalizeWardNo(f.properties.ward_no)));
        highlightStyleMode = "quick";
        quickViewLabel = "All wards highlighted";
        if (wardLayer) wardLayer.setStyle(defaultWardStyle);
        buildLegend();
        map.fitBounds(wardLayer.getBounds(), { padding: [40, 40] });
        return;
      }
      const filtered = wards.features
        .filter(f => which === "no_sensors" ? (f.properties.sensor_with_data || 0) === 0 : (f.properties.sensor_with_data || 0) > 0)
        .sort((a, b) => which === "max_sensors" ? (b.properties.sensor_with_data || 0) - (a.properties.sensor_with_data || 0) : (a.properties.sensor_with_data || 0) - (b.properties.sensor_with_data || 0));
      const top = filtered.slice(0, which === "no_sensors" ? filtered.length : 10);
      highlightedWardNos = new Set(top.map(f => normalizeWardNo(f.properties.ward_no)));
      highlightStyleMode = "quick";
      quickViewLabel = which === "max_sensors"
        ? "Highlighted: top 10 wards by sensor count"
        : which === "min_sensors"
        ? "Highlighted: 10 wards with fewest sensors"
        : "Highlighted: wards with no sensors";
      if (wardLayer) wardLayer.setStyle(defaultWardStyle);
      buildLegend();
      if (top.length && top[0].properties.centroid) {
        const bounds = L.latLngBounds(top.map(f => [f.properties.centroid[1], f.properties.centroid[0]]));
        map.fitBounds(bounds, { padding: [40, 40] });
      }
    });
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
  const noData = list.length - withData;
  const gw = groundwaterWardSummary(p.ward_no);
  const fmtInt = v => v == null ? "—" : Math.round(v).toLocaleString("en-IN");
  const fmtSlope = v => v == null ? "—" : `${v.toFixed(3)} ft/week`;
  const fmtMm = v => v == null ? "—" : v.toLocaleString("en-IN", { maximumFractionDigits: 0 }) + " mm";
  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-label">Sensors with data</div><div class="stat-value">${withData}</div><div class="stat-sub">out of ${list.length} total</div></div>
      <div class="stat-card"><div class="stat-label">Ward status</div><div class="stat-value small">${wardStatusLabel(wardStatusKey(p))}</div><div class="stat-sub">${currentLens === "groundwater" ? groundwaterMethodLabel() : "Current map lens"}</div></div>
      <div class="stat-card"><div class="stat-label">No-data devices</div><div class="stat-value small">${noData}</div><div class="stat-sub">from full inventory</div></div>
      ${gw ? `<div class="stat-card"><div class="stat-label">Groundwater</div><div class="stat-value small">${wardStatusLabel(gw.status)}</div><div class="stat-sub">${groundwaterMethodLabel()}</div></div>` : ""}
      ${gw ? `<div class="stat-card"><div class="stat-label">Slope</div><div class="stat-value small">${fmtSlope(gw.slope)}</div><div class="stat-sub">${gw.points} weekly values</div></div>` : ""}
      <div class="stat-card"><div class="stat-label">Area</div><div class="stat-value small">${p.area_km2 ? p.area_km2.toFixed(2) + " km²" : "—"}</div></div>
<!-- Rainfall stat card hidden until KWRIS+KSNDMC pipeline is finalised. Re-enable by restoring this line. -->
      <div class="stat-card"><div class="stat-label">Population 2001</div><div class="stat-value small">${fmtInt(p.population_2001)}</div><div class="stat-sub">Census</div></div>
      <div class="stat-card"><div class="stat-label">Population 2011</div><div class="stat-value small">${fmtInt(p.population_2011)}</div><div class="stat-sub">Census</div></div>
      <div class="stat-card"><div class="stat-label">Projected 2026</div><div class="stat-value small">${fmtInt(p.population_2026)}</div><div class="stat-sub">CAGR from 2001–10</div></div>
    </div>
    ${gw ? `<div class="criticality-summary">
      <div class="section-title">Groundwater criticality</div>
      <div class="criticality-line"><b>${gw.category}</b> · ${gw.direction}${gw.previousCritical ? " · Previous consumption-critical ward" : ""}</div>
      ${gw.reason ? `<div class="criticality-note">${gw.reason}</div>` : ""}
    </div>` : ""}
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
      const status = sensorStatusKey(s);
      row.innerHTML = `<span class="uid-mono">${s.uid}</span><span class="uid-tag ${status}">${status === "with_data" ? "reporting" : "no data"}</span>`;
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
      <div class="stat-card"><div class="stat-label">Status</div><div class="stat-value small">${sensorStatusLabel(sensorStatusKey(s))}</div></div>
      <div class="stat-card"><div class="stat-label">First reading</div><div class="stat-value small">${fmtDate(s.first_data_at)}</div></div>
      <div class="stat-card"><div class="stat-label">Last reading</div><div class="stat-value small">${fmtDate(s.last_data_at)}</div></div>
    </div>
    ${s.has_data ? `
      <div class="sensor-tabs">
        <button class="sensor-tab active" data-tab="charts">Charts</button>
        <button class="sensor-tab" data-tab="sessions">Sessions</button>
      </div>
      <div class="tab-pane active" data-pane="charts">
        <div id="session-tiles" class="session-tiles"></div>
        ${sensorChartsHTML()}
      </div>
      <div class="tab-pane" data-pane="sessions">
        <div id="session-stats-card" class="session-stats-card">Computing session quality…</div>
      </div>` : `<div class="loading">No time-series data for this sensor in the current snapshot.</div>`}
  `;
  panel.hidden = false;
  // If the sensor was clicked without a ward context, zoom in to it (like a ward selection).
  const targetZoom = selectedWardNo == null ? 16 : null;
  if (s.lat != null && s.lng != null) panToLatLngLeftHalf(s.lat, s.lng, targetZoom);
  if (s.has_data) {
    await loadAndRenderSeries(uid);
    if (selectedSensorUid !== uid) return;
    renderSessionStatsCard();
    wireRangeChips();
    wireSensorTabs();
  }
}

function sensorChartsHTML() {
  const chips = ["1W", "1M", "3M", "ALL"].map(r => `<button class="range-chip${r === "1M" ? " active" : ""}" data-range="${r}">${r}</button>`).join("");
  return `
    <div class="chart-block">
      <div class="chart-header">
        <div class="chart-title">Water level (ft below surface)</div>
        <div class="chart-actions"><select class="chart-mode" data-chart="water" title="Level filter"><option value="all">All levels</option><option value="rested8h">Static (rested ≥ 8h)</option><option value="off">Static (pump off, from sessions)</option><option value="on">Pumping (pump on)</option></select>${chips}<button class="dl-btn" data-download="water" title="Download PNG">⬇</button><button class="expand-btn" data-expand="water" title="Expand">⤢</button></div>
      </div>
      <div class="chart-canvas-wrap"><canvas id="chart-water"></canvas></div>
    </div>
    <div class="chart-block">
      <div class="chart-header">
        <div class="chart-title">Recorded discharge (L/min)</div>
        <div class="chart-actions"><select class="chart-mode" data-chart="discharge" title="Discharge filter"><option value="all">All</option><option value="dmax">Daily max</option><option value="dmin">Daily min</option></select>${chips}<button class="dl-btn" data-download="discharge" title="Download PNG">⬇</button><button class="expand-btn" data-expand="discharge" title="Expand">⤢</button></div>
      </div>
      <div class="chart-canvas-wrap"><canvas id="chart-discharge"></canvas></div>
    </div>
  `;
}

// ============================================================
// Backend annotations are authoritative for the current policy version.
const sessionCache = new WeakMap();
let qualityFilter = "all";
let waterMode = "all", dischargeMode = "all";
let sessionPage = 0;
const REASON_LABEL = {
  too_few_samples: "Fewer than 3 readings",
  no_volume: "Yield counter did not advance",
  sensor_relock_jump: "Water-level jump above 20 ft (possible sensor re-lock)",
  net_level_rise: "Ended shallower than it started",
  missing_water_level: "Missing water-level readings",
  missing_yield: "Missing yield readings",
};
function computeSessions(series) {
  if (!series || !series.times) return [];
  if (sessionCache.has(series)) return sessionCache.get(series);
  const raw = series.quality_policy_version === SessionQuality.version && Array.isArray(series.sessions)
    ? series.sessions : SessionQuality.build(series);
  const result = raw.map((ss, i) => ({ ...ss, number: i + 1,
    startIdx: ss.start, stopIdx: ss.stop,
    startTime: new Date(series.times[ss.start]), stopTime: new Date(series.times[ss.stop]),
    nSamples: ss.n, drawdownFt: ss.drawdown_ft, pumpedKl: ss.pumped_kl,
    maxStepFt: ss.max_step_ft,
  }));
  sessionCache.set(series, result);
  return result;
}
function sessionCoverage(sessions, seriesLen) {
  const cover = new Uint8Array(seriesLen);
  for (const sess of sessions) cover.fill({ok: 1, flagged: 2, excluded: 3}[sess.status], sess.startIdx, sess.stopIdx + 1);
  return cover;
}
function summarizeSessions(sessions) {
  const counts = { total: sessions.length, ok: 0, flagged: 0, excluded: 0, byReason: {} };
  for (const s of sessions) {
    counts[s.status]++;
    for (const r of s.reasons) counts.byReason[r] = (counts.byReason[r] || 0) + 1;
  }
  return counts;
}

async function loadAndRenderSeries(uid) {
  const res = await fetch(seriesUrlOf(uid));
  if (!res.ok) return;
  const series = await res.json();
  if (selectedSensorUid !== uid) return;
  currentSensorSeries = series;
  qualityFilter = "all";
  sessionPage = 0;
  currentRange = "1M";
  waterMode = "all"; dischargeMode = "all";
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
    const included = qualityFilter === "all" || cover[i] === {ok: 1, flagged: 2, excluded: 3}[qualityFilter];
    out.water.push(included ? s.water_ft[i] : null);
    out.flow.push(included ? s.flow_lpm[i] : null);
    out.cover.push(cover[i]);
  }
  return out;
}

function qualityDatasets(values, cover) {
  return [
    [1, "OK", "#0e7490", []],
    [2, "Flagged — review", "#d97706", [4, 3]],
    [3, "Excluded from default analysis", "#94a3b8", [2, 3]],
  ].map(([tag, label, color, dash]) => ({ label,
    data: values.map((v, i) => cover[i] === tag ? v : null),
    borderColor: color, borderDash: dash, fill: false, tension: 0,
    pointRadius: values.map((v, i) => v != null && cover[i] === tag &&
      (i === 0 || values[i-1] == null || cover[i-1] !== tag) &&
      (i === values.length-1 || values[i+1] == null || cover[i+1] !== tag) ? 2 : 0),
  }));
}

function rangeFrom() {
  const S = currentSensorSeries; if (!S || !S.times.length) return null;
  const last = new Date(S.times[S.times.length - 1]);
  if (currentRange === "1W") return new Date(last.getTime() - 7 * 86400000);
  if (currentRange === "1M") return new Date(last.getTime() - 30 * 86400000);
  if (currentRange === "3M") return new Date(last.getTime() - 90 * 86400000);
  return null;
}
function restedLevelPoints(minGapHours) {
  const S = currentSensorSeries; if (!S || !S.times || !S.times.length) return [];
  const from = (typeof rangeFrom === "function") ? rangeFrom() : null;
  const gapMs = (minGapHours || 8) * 3600 * 1000;
  const out = [];
  let prev = null;
  for (let i = 0; i < S.times.length; i++) {
    const t = new Date(S.times[i]);
    const y = S.water_ft ? S.water_ft[i] : null;
    if (prev !== null && (t - prev) >= gapMs && y != null) {
      if (!from || t >= from) out.push({ x: t, y });
    }
    prev = t;
  }
  return out;
}

function sessionLevelPoints(which) {
  const S = currentSensorSeries, wl = S.water_ft, from = rangeFrom();
  const pts = [];
  for (const se of computeSessions(S)) {
    if (qualityFilter !== "all" && se.status !== qualityFilter) continue;
    const idx = which === "off" ? se.startIdx : se.stopIdx;
    const y = wl[idx]; if (y == null) continue;
    const x = new Date(S.times[idx]); if (from && x < from) continue;
    pts.push({ x, y });
  }
  return pts;
}
function dailyExtreme(times, values, mode) {
  const byDay = new Map();
  for (let i = 0; i < times.length; i++) {
    if (values[i] == null) continue;
    const t = times[i], key = t.getFullYear() + "-" + t.getMonth() + "-" + t.getDate();
    const cur = byDay.get(key);
    if (!cur || (mode === "dmax" ? values[i] > cur.y : values[i] < cur.y)) byDay.set(key, { x: t, y: values[i] });
  }
  return [...byDay.values()].sort((a, b) => a.x - b.x);
}
function chartBaseOpts(xUnit) {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    interaction: { mode: "nearest", intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: "rgba(11,61,76,0.95)" } },
    scales: {
      x: { type: "time", time: { unit: xUnit, tooltipFormat: "dd MMM yyyy, hh:mm a", displayFormats: { hour: "dd MMM", day: "dd MMM", week: "dd MMM", month: "MMM yyyy" } }, ticks: { color: "#5a6472", maxRotation: 0, autoSkip: true }, grid: { display: false } },
      y: { ticks: { color: "#5a6472" }, grid: { color: "#eef2f5" } },
    },
    elements: { point: { radius: 0 }, line: { borderWidth: 1.6 } },
    spanGaps: true,
  };
}
function drawCharts() {
  if (charts.water) charts.water.destroy();
  if (charts.discharge) charts.discharge.destroy();
  const d = filteredSeries(currentRange);
  const xUnit = currentRange === "3M" ? "week" : currentRange === "ALL" ? "month" : "day";
  const yOpts = t => { const o = chartBaseOpts(xUnit); o.scales.y.title = { display: true, text: t, color: "#5a6472" }; return o; };
  // Water level
  let wDatasets, wLabels;
  if (waterMode === "rested8h") {
    const pts = restedLevelPoints(8);
    wDatasets = [{ label: "Static level (rested ≥ 8h)", data: pts, borderColor: "#0e7490", backgroundColor: "rgba(14,116,144,0.10)", fill: false, tension: 0.2, pointRadius: 2.5, borderWidth: 1.6 }];
  } else if (waterMode === "all") {
    wDatasets = [{ label: "Water level", data: d.water, borderColor: "#0e7490", backgroundColor: "rgba(14,116,144,0.10)", fill: true, tension: 0.25, pointRadius: 0 }];
    wLabels = d.times;
  } else {
    const pts = sessionLevelPoints(waterMode);
    wDatasets = [{ label: waterMode === "off" ? "Static level (pump off)" : "Pumping level (pump on)", data: pts, borderColor: "#0e7490", backgroundColor: "rgba(14,116,144,0.10)", fill: false, tension: 0.2, pointRadius: 2.5, borderWidth: 1.6 }];
  }
  charts.water = new Chart(document.getElementById("chart-water"), {
    type: "line", data: wLabels ? { labels: wLabels, datasets: wDatasets } : { datasets: wDatasets }, options: yOpts("ft below surface"),
  });
  // Discharge
  let fDatasets, fLabels;
  if (dischargeMode === "all") {
    fDatasets = [{ label: "Discharge", data: d.flow, borderColor: "#0891b2", backgroundColor: "rgba(8,145,178,0.10)", fill: true, tension: 0.25, pointRadius: 0 }];
    fLabels = d.times;
  } else {
    const pts = dailyExtreme(d.times, d.flow, dischargeMode);
    fDatasets = [{ label: dischargeMode === "dmax" ? "Daily max discharge" : "Daily min discharge", data: pts, borderColor: "#0891b2", backgroundColor: "rgba(8,145,178,0.10)", fill: false, tension: 0.2, pointRadius: 2.5, borderWidth: 1.6 }];
  }
  charts.discharge = new Chart(document.getElementById("chart-discharge"), {
    type: "line", data: fLabels ? { labels: fLabels, datasets: fDatasets } : { datasets: fDatasets }, options: yOpts("L/min"),
  });
}
function renderSessionStatsCard() {
  if (!currentSensorSeries) return;
  const sessions = computeSessions(currentSensorSeries), stats = summarizeSessions(sessions);
  const number = v => v == null ? "—" : v.toLocaleString("en-IN", {maximumFractionDigits: 2});
  const date = d => d.toLocaleString("en-IN", {day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:true});
  const LBL = {total:"Total", ok:"OK", flagged:"Flagged", excluded:"Excluded"};
  const STAT = {ok:"OK", flagged:"Flagged", excluded:"Excluded"};
  const tiles = document.getElementById("session-tiles");
  if (tiles) {
    const activeKey = qualityFilter === "all" ? "total" : qualityFilter;
    tiles.innerHTML =
      `<div class="session-stats-grid">${["total","ok","flagged","excluded"].map(k =>
        `<div class="ss-tile ${k}${k===activeKey?" active":""}" data-filter="${k}"><div class="ss-num">${number(stats[k])}</div><div class="ss-lbl">${LBL[k]}</div></div>`).join("")}</div>`;
    tiles.querySelectorAll(".ss-tile").forEach(t => t.onclick = () => {
      qualityFilter = t.dataset.filter === "total" ? "all" : t.dataset.filter;
      sessionPage = 0; renderSessionStatsCard(); drawCharts();
    });
  }
  const el = document.getElementById("session-stats-card");
  if (!el) return;
  const visible = sessions.filter(s => qualityFilter === "all" || s.status === qualityFilter);
  const pageSize = 25, pages = Math.max(1, Math.ceil(visible.length / pageSize));
  sessionPage = Math.min(Math.max(0, sessionPage), pages - 1);
  el.hidden = false;
  el.innerHTML = `
    <div class="quality-toolbar">
      <label>Show <select id="quality-filter">${[["all","All sessions"],["ok","OK only"],["flagged","Flagged"],["excluded","Excluded"]].map(([v,l])=>`<option value="${v}" ${v===qualityFilter?"selected":""}>${l}</option>`).join("")}</select></label>
      <button id="download-sessions">Download CSV</button>
    </div>
    <div class="quality-table-wrap"><table class="quality-table"><thead><tr><th>Session</th><th>Read.</th><th>Status</th><th>Vol&nbsp;kL</th><th>Draw&nbsp;ft</th><th>Jumps</th><th>Eligible</th></tr></thead><tbody>
    ${visible.slice(sessionPage*pageSize,(sessionPage+1)*pageSize).map(s=>`<tr class="row-${s.status}"><td><b>#${s.number}</b><br><span class="cell-sub">${date(s.startTime)}<br>\u2192 ${date(s.stopTime)}</span></td><td>${s.n}</td><td><span class="status-pill ${s.status}">${STAT[s.status]}</span>${s.reasons.length?`<br><span class="cell-sub">${s.reasons.map(r=>REASON_LABEL[r]||"Other").join(", ")}</span>`:""}</td><td>${number(s.pumpedKl)}</td><td>${number(s.drawdownFt)}</td><td>${s.jump_count}</td><td><span class="cell-sub">${[s.eligible_volume?"Vol":"",s.eligible_drawdown?"Draw":"",s.eligible_specific_capacity?"Sp.cap":""].filter(Boolean).join(", ")||"—"}</span></td></tr>`).join("") || '<tr><td colspan="7" class="cell-sub">No sessions in this category.</td></tr>'}
    </tbody></table></div>
    <div class="quality-toolbar"><button id="sessions-prev" ${sessionPage===0?"disabled":""}>‹ Prev</button><span class="page-info">Page ${sessionPage+1}/${pages} · ${number(visible.length)} shown</span><button id="sessions-next" ${sessionPage+1>=pages?"disabled":""}>Next ›</button></div>
    <details class="quality-about"><summary>About these numbers &amp; rules</summary>
      <p class="quality-note">All readings are retained. Flagged sessions need review but are not discarded; excluded sessions (fewer than 3 readings, no positive volume, or missing endpoint water levels) stay available here. Counts cover the full sensor history.</p>
      <p class="quality-note">New session: a gap of more than 30 minutes. Volume is reconstructed by integrating flow (L/min × minutes) because the device's cumulative-yield counter is unreliable; the raw counter is retained for audit. A level jump over 20 ft flags a session and blocks drawdown, while its volume can stay usable.</p>
      ${Object.entries(stats.byReason).map(([r,n]) => `<div class="reason-row"><span>${REASON_LABEL[r] || "Other issue"}</span><b>${number(n)}</b></div>`).join("")}
    </details>`;
  el.querySelector("#quality-filter").onchange = e => { qualityFilter = e.target.value; sessionPage = 0; renderSessionStatsCard(); drawCharts(); };
  el.querySelector("#sessions-prev").onclick = () => { sessionPage--; renderSessionStatsCard(); };
  el.querySelector("#sessions-next").onclick = () => { sessionPage++; renderSessionStatsCard(); };
  el.querySelector("#download-sessions").onclick = () => {
    const rows = [["uid","session","start","stop","readings","status","reasons","observed_volume_kl","observed_drawdown_ft","jump_count"],
      ...visible.map(s=>[currentSensorSeries.uid,s.number,date(s.startTime),date(s.stopTime),s.n,s.status,s.reasons.join("; "),s.pumpedKl,s.drawdownFt,s.jump_count])];
    const csv = rows.map(row=>row.map(v=>'"'+String(v ?? "").replaceAll('"','""')+'"').join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
    const a = document.createElement("a"); a.href=url; a.download=`${currentSensorSeries.uid}_sessions_${qualityFilter}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
}

function wireSensorTabs() {
  document.querySelectorAll(".sensor-tab").forEach(tab => {
    tab.onclick = () => {
      const name = tab.dataset.tab;
      document.querySelectorAll(".sensor-tab").forEach(t => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".tab-pane").forEach(pane => pane.classList.toggle("active", pane.dataset.pane === name));
      if (name === "charts") drawCharts();
    };
  });
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
  document.querySelectorAll(".dl-btn").forEach(btn => {
    btn.addEventListener("click", () => downloadChartPng(btn.dataset.download));
  });
  document.querySelectorAll(".chart-mode").forEach(sel => {
    sel.addEventListener("change", () => {
      if (sel.dataset.chart === "water") waterMode = sel.value; else dischargeMode = sel.value;
      drawCharts();
    });
  });
}

function downloadChartPng(which) {
  const chart = which === "modal" ? charts.modal : charts[which];
  if (!chart || !currentSensorSeries) return;
  const src = chart.canvas;
  const tmp = document.createElement("canvas");
  tmp.width = src.width; tmp.height = src.height;
  const ctx = tmp.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, tmp.width, tmp.height);
  ctx.drawImage(src, 0, 0);
  const label = which === "discharge" ? "discharge" : which === "modal" ? "chart" : "water_level";
  const a = document.createElement("a");
  a.href = tmp.toDataURL("image/png");
  a.download = `${currentSensorSeries.uid}_${label}.png`;
  a.click();
}

function openChartModal(which) {
  const isWater = which === "water";
  const mode = isWater ? waterMode : dischargeMode;
  const title = isWater ? "Water level (ft below surface)" : "Discharge (L/min)";
  document.getElementById("chart-modal-title").textContent = `${title} — ${currentSensorSeries.uid}`;
  const body = document.getElementById("chart-modal-body");
  body.innerHTML = `<canvas id="chart-modal-canvas"></canvas>`;
  openOverlay("chart-modal");
  const _mc = document.querySelector("#chart-modal .close-btn");
  if (_mc && !document.getElementById("modal-dl")) {
    const dl = document.createElement("button");
    dl.id = "modal-dl"; dl.className = "close-btn"; dl.title = "Download PNG"; dl.textContent = "⬇";
    dl.onclick = () => downloadChartPng("modal");
    _mc.parentNode.insertBefore(dl, _mc);
  }
  const d = filteredSeries(currentRange);
  const color = isWater ? "#1e3a8a" : "#0891b2";
  const yTitle = isWater ? "ft below surface" : "L/min";
  const xUnit = currentRange === "3M" ? "week" : currentRange === "ALL" ? "month" : "day";
  let datasets, labels;
  if (mode === "all") {
    labels = d.times;
    datasets = [{ data: isWater ? d.water : d.flow, borderColor: color, backgroundColor: color + "1A", fill: true, tension: 0.25, pointRadius: 0 }];
  } else if (isWater && mode === "rested8h") {
    datasets = [{ data: restedLevelPoints(8), borderColor: color, backgroundColor: color + "1A", fill: false, tension: 0.2, pointRadius: 3 }];
  } else if (isWater) {
    datasets = [{ data: sessionLevelPoints(waterMode), borderColor: color, backgroundColor: color + "1A", fill: false, tension: 0.2, pointRadius: 3 }];
  } else {
    datasets = [{ data: dailyExtreme(d.times, d.flow, dischargeMode), borderColor: color, backgroundColor: color + "1A", fill: false, tension: 0.2, pointRadius: 3 }];
  }
  if (charts.modal) charts.modal.destroy();
  charts.modal = new Chart(document.getElementById("chart-modal-canvas"), {
    type: "line",
    data: labels ? { labels, datasets } : { datasets },
    options: {
      responsive: true, maintainAspectRatio: false, spanGaps: true,
      plugins: { legend: { display: false }, tooltip: { backgroundColor: "rgba(11,61,76,0.95)" } },
      scales: {
        x: { type: "time", time: { unit: xUnit, tooltipFormat: "dd MMM yyyy, hh:mm a", displayFormats: { hour: "dd MMM", day: "dd MMM", week: "dd MMM", month: "MMM yyyy" } }, grid: { color: "#eef2f5" } },
        y: { title: { display: true, text: yTitle } },
      },
      elements: { point: { radius: mode === "all" ? 0 : 3 }, line: { borderWidth: 1.8 } },
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


async function switchCriticalityMethod(method) {
  criticalityMethod = method;
  const payload = await loadCriticalityForMethod(method);
  const rows = (payload.wards || []).map(calculateGroundwaterCriticality);
  criticalGroundwaterByNo = new Map(rows.map(w => [normalizeWardNo(w.wardNo), w]));
  analyticsLoaded = criticalGroundwaterByNo.size > 0;
  console.log(`[method] ${method} loaded, wards=${criticalGroundwaterByNo.size}`);
  if (wardLayer) wardLayer.setStyle(defaultWardStyle);
  if (typeof updateMetrics === "function") updateMetrics();
  if (typeof buildLegend === "function") buildLegend();
}

document.addEventListener("DOMContentLoaded", () => {
  const el = document.getElementById("criticality-method");
  if (el) el.addEventListener("change", () => switchCriticalityMethod(el.value));
});


function ensureSensorPanelFooter() {
  const panel = document.getElementById("sensor-detail") || document.querySelector(".sensor-detail-panel");
  if (!panel) return;
  if (document.getElementById("sensor-panel-datawindow")) return;
  const div = document.createElement("div");
  div.id = "sensor-panel-datawindow";
  div.style.cssText = "margin-top:10px; padding:6px 10px; background:#fef3c7; color:#78350f; border-left:3px solid #fbbf24; font-size:11.5px; line-height:1.4; border-radius:4px;";
  div.innerHTML = "<b>Note:</b> Data window Jul 2025 &ndash; Sep 2026. Trend interpretation limited by monsoon-biased record. All slopes computed from static (rested ≥ 8h) readings only.";
  panel.appendChild(div);
}

boot();
