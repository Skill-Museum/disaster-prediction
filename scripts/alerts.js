// scripts/alerts.js
//
// Turns the fetched state into alert events. Fires only on NEW conditions or
// ESCALATIONS (not every 2-minute cycle for the same steady condition), so
// the alert log/websocket stream doesn't spam the same warning 720x/day.

const BAND_RANK = { WATCH: 0, ADVISORY: 1, WARNING: 2, ALERT: 3, UNKNOWN: -1 };
const RISK_RANK = { MINIMAL: 0, LOW: 1, MODERATE: 2, HIGH: 3, EXTREME: 4 };
const GAUGE_RANK = { normal: 0, rising: 1, near_danger: 2, warning: 2, danger: 3 };

// module-level memory of what we last alerted on, so cycles don't repeat
const lastSeen = {
  upstream: new Map(),   // id -> band rank
  forecast: new Map(),   // id -> band rank
  riskBand: null,        // last national band
  gauges: new Map(),     // stationId -> level rank
  quakeIds: new Set(),   // ids already alerted
};

function makeAlert(type, severity, message, meta = {}) {
  return {
    id: `${type}-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    type,          // 'transboundary' | 'forecast' | 'risk' | 'gauge' | 'earthquake'
    severity,       // 'info' | 'advisory' | 'warning' | 'alert' | 'danger'
    message,
    at: new Date().toISOString(),
    ...meta,
  };
}

export function evaluateAlerts(state) {
  const alerts = [];

  // 1) Transboundary upstream escalations — the earliest possible signal,
  //    this is the one that would have caught a Bhote Koshi surge before
  //    it reaches Rasuwa.
  for (const item of state.upstream?.items || []) {
    const rank = BAND_RANK[item.band] ?? -1;
    const prev = lastSeen.upstream.get(item.id) ?? -1;
    if (rank >= 1 && rank > prev) { // ADVISORY or above, and escalating
      const [lo, hi] = item.leadTimeHours || [];
      alerts.push(makeAlert(
        'transboundary',
        item.band.toLowerCase(),
        `TRANSBOUNDARY ${item.band} — ${item.name} (${item.country}): feeds ${item.feeds}. ` +
        `Estimated lead time to Nepal: ${lo ?? '?'}-${hi ?? '?'}h. ` +
        `Watch: ${(item.watchPoints || []).join(', ')}.`,
        { riverId: item.downstreamRiverId, band: item.band, leadTimeHours: item.leadTimeHours }
      ));
    }
    lastSeen.upstream.set(item.id, rank);
  }

  // 2) Nepal-side river forecast escalations (GloFAS 7-day discharge)
  for (const r of state.forecast?.rivers || []) {
    const rank = BAND_RANK[r.band] ?? -1;
    const prev = lastSeen.forecast.get(r.id) ?? -1;
    if (rank >= 2 && rank > prev) { // WARNING or above, and escalating
      alerts.push(makeAlert(
        'forecast',
        r.band.toLowerCase(),
        `${r.name} (${r.district}) forecast at ${r.band}` +
        (r.peakInDays != null ? ` — peak in ~${r.peakInDays}d` : '') +
        (r.peakDischargeM3s ? ` (${Math.round(r.peakDischargeM3s)} m³/s)` : '') + '.',
        { riverId: r.id, band: r.band, peakInDays: r.peakInDays }
      ));
    }
    lastSeen.forecast.set(r.id, rank);
  }

  // 3) National AI risk score escalating into HIGH/EXTREME
  const band = state.risk?.national?.band;
  if (band && (band === 'HIGH' || band === 'EXTREME')) {
    const rank = RISK_RANK[band] ?? 0;
    const prevRank = lastSeen.riskBand ? (RISK_RANK[lastSeen.riskBand] ?? 0) : -1;
    if (rank > prevRank) {
      alerts.push(makeAlert(
        'risk',
        band === 'EXTREME' ? 'alert' : 'warning',
        `National AI Risk Score escalated to ${band} (${state.risk.national.score}/100).`,
        { score: state.risk.national.score, band }
      ));
    }
  }
  lastSeen.riskBand = band || lastSeen.riskBand;

  // 4) Gauge stations — only fires once live gauge data is connected
  //    (fetchGaugeStations() currently returns none; this stays dormant
  //    until you wire in a real source, see README).
  for (const s of state.flood?.stations || []) {
    const level = (s.level || '').toLowerCase();
    const rank = GAUGE_RANK[level] ?? 0;
    const prev = lastSeen.gauges.get(s.id) ?? 0;
    if (rank >= 2 && rank > prev) {
      alerts.push(makeAlert(
        'gauge',
        rank >= 3 ? 'danger' : 'warning',
        `${s.name}: ${s.level.toUpperCase()} (${s.value}${s.unit || 'm'}).`,
        { stationId: s.id }
      ));
    }
    lastSeen.gauges.set(s.id, rank);
  }

  // 5) Earthquakes M >= 4.5, new only
  for (const q of state.earthquake?.quakes || []) {
    if (q.mag >= 4.5 && !lastSeen.quakeIds.has(q.id)) {
      alerts.push(makeAlert(
        'earthquake',
        q.mag >= 6 ? 'alert' : 'warning',
        `M${q.mag} earthquake — ${q.place} (depth ${q.depthKm ?? '?'}km).`,
        { quakeId: q.id, mag: q.mag }
      ));
      lastSeen.quakeIds.add(q.id);
    }
  }

  // 6) GLOF / quake-triggered cascade nowcast — the Mailung-type scenario.
  //    A strong shallow quake in the Himalayan headwater zone (near a glacial
  //    lake / gorge that feeds a monitored river) raises the risk of a
  //    landslide-dam or GLOF burst that GloFAS daily-mean discharge can NOT see.
  const GLACIAL_LAKE_ARC = [ // approximate centers of glacial moraine zones feeding Nepal rivers
    { lat: 29.0, lon: 86.8, rivers: ['sapta_koshi', 'arun_pumqu'] }, // Arun/Pumqu
    { lat: 28.7, lon: 85.1, rivers: ['trishuli', 'bhote_koshi_poiqu'] }, // Bhote Koshi headwater
    { lat: 28.9, lon: 82.9, rivers: ['karnali', 'bheri'] }, // Karnali headwater
    { lat: 28.3, lon: 84.6, rivers: ['kali_gandaki', 'narayani'] }, // Narayani headwater
  ];
  const GLOF_DIST_KM = 110;
  for (const zone of GLACIAL_LAKE_ARC) {
    for (const q of state.earthquake?.quakes || []) {
      if (q.mag < 5.0) continue;
      const dKm = Math.hypot((q.lat - zone.lat) * 111, (q.lon - zone.lon) * 91);
      if (dKm > GLOF_DIST_KM) continue;
      const key = `glof-${zone.rivers.join('+')}-${q.id}`;
      if (!lastSeen.quakeIds.has(key)) {
        alerts.push(makeAlert(
          'glof',
          q.mag >= 6 ? 'alert' : 'warning',
          `GLOF/CASCADE WATCH — M${q.mag} at depth ${q.depthKm ?? '?'}km, ${Math.round(dKm)}km from the ` +
          `${zone.rivers.join(' / ')} headwater zone. A landslide-dam or glacial-lake burst here ` +
          `produces a flash surge no river-forecast model can resolve. Watch downstream gauges + NASA flood overlay.`,
          { quakeId: q.id, mag: q.mag, zone: zone.rivers, proximityKm: Math.round(dKm) }
        ));
        lastSeen.quakeIds.add(key);
      }
    }
  }

  return { alerts };
}
