// Fallback for older snapshots/API responses; kept in parity with session_quality.py.
// Policy v3: yield counter is unreliable -> segment on >30 min gap only, and
// reconstruct volume by integrating flow (flow_lpm * minutes / 1000) per session.
(function (root) {
  function build(series) {
    const times = series.times || [], water = series.water_ft || [],
      flow = series.flow_lpm || [], yield_ = series.yield_kl || [];
    if (!times.length) return [];
    const boundaries = [0];
    for (let i = 1; i < times.length; i++) {
      if (new Date(times[i]) - new Date(times[i - 1]) > 1800000) boundaries.push(i);
    }
    boundaries.push(times.length);
    const result = [];
    for (let b = 0; b < boundaries.length - 1; b++) {
      const a = boundaries[b], end = boundaries[b + 1], e = end - 1, n = end - a;
      const missingWater = water.slice(a, end).some(v => v == null);
      const missingYield = yield_.slice(a, end).some(v => v == null);
      const missingFlow = flow.slice(a, end).some(v => v == null);
      let maxStep = 0, jumps = 0;
      for (let i = a + 1; i < end; i++) {
        if (water[i] == null || water[i - 1] == null) continue;
        const step = Math.abs(water[i] - water[i - 1]);
        maxStep = Math.max(maxStep, step);
        if (step > 20) jumps++;
      }
      const drawdown = water[e] != null && water[a] != null ? water[e] - water[a] : null;
      let volume = 0;
      for (let i = a + 1; i < end; i++) {
        if (flow[i - 1] != null) {
          const minutes = (new Date(times[i]) - new Date(times[i - 1])) / 60000;
          if (minutes >= 0) volume += flow[i - 1] * minutes / 1000;
        }
      }
      const reasons = [];
      if (n < 3) reasons.push('too_few_samples');
      if (volume <= 0) reasons.push('no_volume');
      if (jumps) reasons.push('sensor_relock_jump');
      if (drawdown != null && drawdown < 0) reasons.push('net_level_rise');
      if (missingWater) reasons.push('missing_water_level');
      if (missingYield) reasons.push('missing_yield');
      const excluded = n < 3 || volume <= 0 || drawdown == null;
      const status = excluded ? 'excluded' : reasons.length ? 'flagged' : 'ok';
      const volumeOk = n >= 2 && !missingFlow && volume > 0;
      const drawdownOk = n >= 3 && !missingWater && !jumps && drawdown != null && drawdown > 0;
      const round = v => v == null ? null : Math.round((v + Number.EPSILON) * 100) / 100;
      result.push({ start: a, stop: e, n, drawdown_ft: round(drawdown), pumped_kl: round(volume),
        max_step_ft: round(maxStep), jump_count: jumps, status, usable: status === 'ok', reasons,
        eligible_volume: volumeOk, eligible_drawdown: drawdownOk,
        eligible_specific_capacity: volumeOk && drawdownOk });
    }
    return result;
  }
  const api = { build, version: 3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionQuality = api;
})(typeof window !== 'undefined' ? window : globalThis);
