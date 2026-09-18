"""One-shot patcher: add per-lens Critical/Rising/Stable KPI cards + fix
Total sensors to show only 579 reporting sensors. Idempotent — safe to re-run.

Edits three files:
  index.html      — inject 3 new metric cards into #status-strip
  js/app.js       — load sensor_qc.json, replace updateMetrics(),
                    call it from the lens change handler
  css/style.css   — color the new metric values, widen the strip grid
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HTML = ROOT / "index.html"
APP  = ROOT / "js" / "app.js"
CSS  = ROOT / "css" / "style.css"

# ---------- index.html : add 3 metric cards ----------
html = HTML.read_text(encoding="utf-8")
CARDS_MARK = 'id="metric-critical"'
if CARDS_MARK not in html:
    old = ('  <div class="metric-card">\n'
           '    <div class="metric-value" id="metric-wards">—</div>\n'
           '    <div class="metric-label">Wards covered</div>\n'
           '  </div>\n'
           '</div>')
    add = ('  <div class="metric-card">\n'
           '    <div class="metric-value" id="metric-wards">—</div>\n'
           '    <div class="metric-label">Wards covered</div>\n'
           '  </div>\n'
           '  <div class="metric-card">\n'
           '    <div class="metric-value metric-critical" id="metric-critical">—</div>\n'
           '    <div class="metric-label" id="metric-critical-label">Critical wards</div>\n'
           '  </div>\n'
           '  <div class="metric-card">\n'
           '    <div class="metric-value metric-rise" id="metric-rise">—</div>\n'
           '    <div class="metric-label">Rising</div>\n'
           '  </div>\n'
           '  <div class="metric-card">\n'
           '    <div class="metric-value metric-stable" id="metric-stable">—</div>\n'
           '    <div class="metric-label">Stable</div>\n'
           '  </div>\n'
           '</div>')
    assert old in html, "index.html: could not find #status-strip closing block"
    HTML.write_text(html.replace(old, add), encoding="utf-8")
    print("index.html: added 3 KPI cards")
else:
    print("index.html: KPI cards already present, skipped")

# ---------- js/app.js ----------
app = APP.read_text(encoding="utf-8")

# 1) global sensorQcByUid
if "let sensorQcByUid" not in app:
    old = "let analyticsLoaded = false;"
    assert old in app
    app = app.replace(old, old + "\nlet sensorQcByUid = new Map();", 1)
    print("app.js: added sensorQcByUid global")

# 2) fetch data/sensor_qc.json in loadData()
if "sensor_qc.json" not in app:
    old = ('  const [ws, ss, mf, qs, analytics] = await Promise.all([\n'
           '    fetch(urlOf("wards.geojson")).then(r => r.json()),\n'
           '    fetch(urlOf("sensors.json")).then(r => r.json()),\n'
           '    fetch(urlOf("manifest.json")).then(r => r.json()),\n'
           '    fetch("./data/session_quality_summary.json").then(r => r.ok ? r.json() : null).catch(() => null),\n'
           '    loadAnalyticsData(),\n'
           '  ]);')
    new = ('  const [ws, ss, mf, qs, analytics, qcPayload] = await Promise.all([\n'
           '    fetch(urlOf("wards.geojson")).then(r => r.json()),\n'
           '    fetch(urlOf("sensors.json")).then(r => r.json()),\n'
           '    fetch(urlOf("manifest.json")).then(r => r.json()),\n'
           '    fetch("./data/session_quality_summary.json").then(r => r.ok ? r.json() : null).catch(() => null),\n'
           '    loadAnalyticsData(),\n'
           '    fetch("./data/sensor_qc.json").then(r => r.ok ? r.json() : null).catch(() => null),\n'
           '  ]);\n'
           '  if (qcPayload && Array.isArray(qcPayload.sensors)) {\n'
           '    for (const row of qcPayload.sensors) sensorQcByUid.set(String(row.uid), row);\n'
           '  }')
    assert old in app, "app.js: loadData() Promise.all anchor not found"
    app = app.replace(old, new, 1)
    print("app.js: wired sensor_qc.json fetch")

# 3) replace updateMetrics() — count only reporting sensors + call updateLensCounts
old_um = ('function updateMetrics() {\n'
          '  const number = v => v == null ? "—" : Number(v).toLocaleString("en-IN");\n'
          '  document.getElementById("metric-total-sensors").textContent = number(sensors.length);\n'
          '  const wardsWithData = wards?.features?.filter(f => (f.properties.sensor_with_data || 0) > 0).length || 0;\n'
          '  document.getElementById("metric-wards").textContent = `${number(wardsWithData)}/${number(wards?.features?.length || manifest?.wards || 0)}`;\n'
          '}')
new_um = ('function updateMetrics() {\n'
          '  const number = v => v == null ? "—" : Number(v).toLocaleString("en-IN");\n'
          '  const reporting = sensors.filter(s => s && s.has_data).length;\n'
          '  document.getElementById("metric-total-sensors").textContent = number(reporting);\n'
          '  const wardsWithData = wards?.features?.filter(f => (f.properties.sensor_with_data || 0) > 0).length || 0;\n'
          '  document.getElementById("metric-wards").textContent = `${number(wardsWithData)}/${number(wards?.features?.length || manifest?.wards || 0)}`;\n'
          '  updateLensCounts();\n'
          '}\n'
          '\n'
          'function updateLensCounts() {\n'
          '  let critical = 0, rise = 0, stable = 0;\n'
          '  if (wards?.features) {\n'
          '    for (const f of wards.features) {\n'
          '      const key = wardStatusKey(f.properties);\n'
          '      if (key === "critical") critical++;\n'
          '      else if (key === "rise") rise++;\n'
          '      else if (key === "stable") stable++;\n'
          '    }\n'
          '  }\n'
          '  const num = v => Number(v).toLocaleString("en-IN");\n'
          '  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = num(val); };\n'
          '  set("metric-critical", critical);\n'
          '  set("metric-rise", rise);\n'
          '  set("metric-stable", stable);\n'
          '  const lbl = document.getElementById("metric-critical-label");\n'
          '  if (lbl && typeof analysisLensLabel === "function") {\n'
          '    lbl.textContent = `Critical · ${analysisLensLabel()}`;\n'
          '  }\n'
          '}')
if "function updateLensCounts()" not in app:
    assert old_um in app, "app.js: updateMetrics() anchor not found (was it edited?)"
    app = app.replace(old_um, new_um, 1)
    print("app.js: replaced updateMetrics + added updateLensCounts")

# 4) call updateMetrics() from the analysis-lens change handler
old_lens = ('  const lensSelect = document.getElementById("analysis-lens");\n'
            '  if (lensSelect) {\n'
            '    lensSelect.addEventListener("change", () => {\n'
            '      currentLens = lensSelect.value || "groundwater";\n'
            '      syncAnalyticsControls();\n'
            '      if (wardLayer) wardLayer.setStyle(defaultWardStyle);\n'
            '      buildLegend();\n'
            '    });\n'
            '  }')
new_lens = ('  const lensSelect = document.getElementById("analysis-lens");\n'
            '  if (lensSelect) {\n'
            '    lensSelect.addEventListener("change", () => {\n'
            '      currentLens = lensSelect.value || "groundwater";\n'
            '      syncAnalyticsControls();\n'
            '      if (wardLayer) wardLayer.setStyle(defaultWardStyle);\n'
            '      updateMetrics();\n'
            '      buildLegend();\n'
            '    });\n'
            '  }')
if new_lens not in app:
    assert old_lens in app, "app.js: lens change handler anchor not found"
    app = app.replace(old_lens, new_lens, 1)
    print("app.js: hooked updateMetrics into lens change")

APP.write_text(app, encoding="utf-8")

# ---------- css/style.css ----------
css = CSS.read_text(encoding="utf-8")
if "/* KPI-strip lens colors */" not in css:
    add = ("\n\n/* KPI-strip lens colors */\n"
           "#status-strip { grid-template-columns: repeat(5, minmax(0, auto)); }\n"
           ".metric-value.metric-critical { color: #b91c1c; }\n"
           ".metric-value.metric-rise { color: #059669; }\n"
           ".metric-value.metric-stable { color: #b45309; }\n"
           "@media (max-width: 900px) {\n"
           "  #status-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }\n"
           "}\n"
           "body.tv-mode #status-strip { grid-template-columns: repeat(5, minmax(160px, 1fr)); }\n")
    CSS.write_text(css.rstrip() + add, encoding="utf-8")
    print("css/style.css: added KPI strip colors")
else:
    print("css/style.css: KPI colors already present, skipped")

print("\nAll patches applied. Reload the dashboard (Ctrl-Shift-R) to see the new cards.")
