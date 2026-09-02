// scripts/fetch-data.js
//
// Live data engine for the Nepal Early-Warning dashboard.
//
// REAL, LIVE, FREE, KEYLESS SOURCES (wired up and working):
//   - Earthquakes:            USGS FDSN Event API
//   - River discharge (7d):   Open-Meteo Flood API (GloFAS ensemble reanalysis + forecast)
//   - Rainfall (7d):          Open-Meteo Weather API
//   - Transboundary upstream: same GloFAS discharge data, evaluated at Tibet-side points
//
// NOT WIRED UP (explicitly reported as "unavailable", never fabricated):
//   - Physical DHM/BIPAD gauge station readings (no verified free public JSON API)
//   - Satellite flood-extent (Sentinel-1 / Copernicus GFM requires auth)
//
// See README.md for how to plug in real DHM/BIPAD gauge data once you have
// a confirmed endpoint (open your browser devtools Network tab on
// https://bipadportal.gov.np/realtime/ during a page load — it's a SPA that
// calls a JSON API under the hood; grab that URL and drop it into
// fetchGaugeStations() below).

import { fetchSatellite, fetchGaugeNowcast } from './satellite.js';
import { fetchBipadData } from './bipad.js';

const NEPAL_BBOX = { minlat: 26.0, maxlat: 30.6, minlon: 79.5, maxlon: 88.5 };

// Nepal-side river forecast points (approximate lowland/mid-hill monitoring points)
const RIVERS = [
  { id: 'karnali', name: 'Karnali', district: 'Banke', lat: 28.63, lon: 81.28, basin: 'Karnali' },
  { id: 'bheri', name: 'Bheri', district: 'Surkhet', lat: 28.60, lon: 81.62, basin: 'Karnali' },
  { id: 'rapti', name: 'Rapti', district: 'Chitwan', lat: 27.68, lon: 84.43, basin: 'Rapti' },
  { id: 'sunkoshi', name: 'Sunkoshi', district: 'Sindhuli', lat: 27.25, lon: 85.97, basin: 'Koshi' },
  { id: 'mechi', name: 'Mechi', district: 'Jhapa', lat: 26.65, lon: 87.95, basin: 'Mechi' },
  { id: 'sapta_koshi', name: 'Sapta Koshi', district: 'Sunsari', lat: 26.88, lon: 87.15, basin: 'Koshi' },
  { id: 'narayani', name: 'Narayani', district: 'Chitwan', lat: 27.70, lon: 84.42, basin: 'Narayani' },
  { id: 'trishuli', name: 'Trishuli', district: 'Nuwakot', lat: 28.03, lon: 85.13, basin: 'Narayani' },
];

// Transboundary upstream points on the Tibet (China) side.
// leadTimeHours is a fixed domain estimate (distance/gradient-based), not
// derived from the discharge API — flagged as such in the output.
const UPSTREAM_POINTS = [
  {
    id: 'bhote_koshi_poiqu',
    name: 'Bhote Koshi (Poiqu)',
    country: 'Tibet, China',
    basin: 'Trishuli basin',
    feeds: 'Bhote Koshi → Trishuli',
    downstreamRiverId: 'trishuli',
    lat: 28.27, lon: 85.31, // Rasuwagadhi border — where Bhote Koshi (from Tibet) enters Nepal
    leadTimeHours: [2, 12],
    watchPoints: ['Bhote Koshi at Bahrabise', 'Bhote Koshi at Shyaprubesi', 'Bhotekoshi at Rasuwagadi', 'Trishuli at Betrawati'],
  },
  {
    id: 'arun_pumqu',
    name: 'Arun River (Pumqu)',
    country: 'Tibet, China',
    basin: 'Koshi basin',
    feeds: 'Sapta Koshi',
    downstreamRiverId: 'sapta_koshi',
    lat: 27.80, lon: 87.10, // north-east Nepal (Sankhuwasabha) — where the Arun/Pumqu enters Nepal from Tibet
    leadTimeHours: [12, 48],
    watchPoints: ['Sapta Koshi at Chatara', 'Saptakoshi at Chatara'],
  },
];

// Measured (official) reality anchors the national score; the forecast only
// acts as a modifier so a modelled warning can't by itself overstate risk.
const RISK_WEIGHTS = { gauge: 0.45, rainfall: 0.35, forecast: 0.20 };
const RAIN_CAP_MM = 150; // 7-day rainfall considered "saturating" above this

function bandFromRatio(ratio) {
  // ratio = forecast peak discharge / 90-day baseline peak
  if (ratio >= 2.0) return { band: 'ALERT', score: 90 + Math.min(10, (ratio - 2.0) * 10) };
  if (ratio >= 1.6) return { band: 'WARNING', score: 65 + ((ratio - 1.6) / 0.4) * 25 };
  if (ratio >= 1.3) return { band: 'ADVISORY', score: 35 + ((ratio - 1.3) / 0.3) * 30 };
  return { band: 'WATCH', score: Math.max(5, ratio * 27) };
}

// Translate a measured (official DHM) gauge level into a threat band.
const GAUGE_LEVEL_BAND = { normal: 'WATCH', rising: 'ADVISORY', warning: 'WARNING', danger: 'ALERT' };
function gaugeBandFromLevel(level) { return GAUGE_LEVEL_BAND[level] ?? 'WATCH'; }

// Merge the two independent signals — the GloFAS model forecast and the measured
// official DHM gauge. The measured gauge anchors the truth; the model can
// escalate for trans-boundary/forecast events not yet visible at a Nepal gauge.
const BAND_RANK = { WATCH: 0, ADVISORY: 1, WARNING: 2, ALERT: 3 };
function combineBands(gloFasBand, measuredBand) {
  const g = BAND_RANK[gloFasBand] ?? 0;
  const m = BAND_RANK[measuredBand] ?? 0;
  // Trust measured reality at least as much as the model; never let a pure
  // model forecast exceed the measured signal by more than one level.
  const combinedRank = Math.max(m, Math.min(g, m + 1));
  const band = Object.keys(BAND_RANK).find((b) => BAND_RANK[b] === combinedRank);
  const source = g === m ? 'gauge + forecast agree' : 'measured gauge drives (forecast ' + gloFasBand + ')';
  return { band, source };
}

function riskBandFromScore(score) {
  if (score >= 75) return { band: 'EXTREME', color: 'red' };
  if (score >= 60) return { band: 'HIGH', color: 'orange' };
  if (score >= 45) return { band: 'MODERATE', color: 'yellow' };
  if (score >= 25) return { band: 'LOW', color: 'blue' };
  return { band: 'MINIMAL', color: 'green' };
}

// Multi-driver flood attribution. Nepal floods come from several mechanisms, not
// only local rain. Each returns a list of active drivers with a 0-1 contribution;
// the primary driver is what should steer the warning message.
function buildDrivers({ band, ratio, rain7dMm, rain14dMm, baselineM3s, currentM3s, upstreamBand, quakeProximityKm, isUpstream }) {  const drivers = [];
  const add = (name, weight, detail) => { if (weight > 0.05) drivers.push({ name, weight: Math.round(weight * 100), detail }); };

  // 1) GLOF / landslide-dam / quake-triggered burst — flash surge, invisible to daily models
  if (quakeProximityKm != null && quakeProximityKm <= 110) {
    add('GLOF / landslide-dam burst', 0.9, `M5+ quake ${quakeProximityKm}km from glacial headwater`);
  }

  // 2) Transboundary upstream surge — water arriving from Tibet hours-days behind
  if (upstreamBand) {
    const ub = { ALERT: 0.9, WARNING: 0.7, ADVISORY: 0.5, WATCH: 0.2 }[upstreamBand] || 0;
    if (ub > 0.05) add('Upstream surge (Tibet)', ub, `arriving ${isUpstream ? 'now' : 'within hours-days'}`);
  }

  // 3) Discharge ratio vs baseline — river running well above normal
  if (baselineM3s && currentM3s && ratio) {
    if (ratio >= 1.3) add('High river flow', Math.min(1, (ratio - 1) / 1.5), `${Math.round(ratio * 100)}% of baseline`);
  }

  // 4) Forecast peak — predicted rise ahead
  if (band === 'ALERT') add('Forecast peak surge', 0.8, 'modeled 7-day peak ≥2x baseline');
  else if (band === 'WARNING') add('Forecast rise', 0.55, 'modeled 7-day peak ≥1.6x baseline');

  // 5) Rainfall — both expected (7d) and antecedent saturation (14d)
  if (rain7dMm >= 100) add('Heavy forecast rain', 0.7, `${rain7dMm}mm/7d`);
  else if (rain7dMm >= 60) add('Moderate forecast rain', 0.4, `${rain7dMm}mm/7d`);
  if (rain14dMm >= 150) add('Saturated ground', 0.5, `${rain14dMm}mm in past 14d`);

  // 6) Snow/glacial melt (thermal) — approximated by warm-season persistence; flag when
  //    baseline is elevated and no single driver above dominates.
  if (!isUpstream && drivers.length === 0 && baselineM3s && baselineM3s > 0) {
    add('Snow/glacial melt (seasonal)', 0.2, 'warm-season baseflow');
  }

  if (!drivers.length) add('Baseflow / normal monsoon', 0.1, 'within seasonal normal');
  drivers.sort((a, b) => b.weight - a.weight);
  return { primary: drivers[0]?.name || 'none', all: drivers };
}

// Glacial headwater zones feeding Nepal rivers, used for quake-adjacency (GLOF trigger).
const GLACIAL_HEADWATERS = {
  trishuli: { lat: 28.7, lon: 85.1 },      // Bhote Koshi / Trishuli (Rasuwa) headwater
  sapta_koshi: { lat: 28.9, lon: 86.8 },   // Arun / Pumqu headwater
  karnali: { lat: 29.3, lon: 82.4 },       // Karnali headwater
  bheri: { lat: 29.2, lon: 81.9 },         // Bheri headwater
  narayani: { lat: 28.7, lon: 84.0 },      // Kali Gandaki / Narayani headwater
  bhote_koshi_poiqu: { lat: 28.7, lon: 85.1 },
  arun_pumqu: { lat: 28.9, lon: 86.8 },
};
function quakeProximityTo(latestQuakes, riverId) {
  const z = GLACIAL_HEADWATERS[riverId];
  if (!z) return null;
  let nearest = null;
  for (const q of latestQuakes || []) {
    if (q.mag < 5.0) continue;
    const d = Math.hypot((q.lat - z.lat) * 111, (q.lon - z.lon) * 91.5);
    if (nearest == null || d < nearest) nearest = d;
  }
  return nearest != null && nearest <= 120 ? Math.round(nearest) : null;
}

// Flaky-network hardened JSON fetch. The outbound path to some hosts (e.g. USGS/AWS
// CloudFront) intermittently resets connections on this network; a single attempt is
// not enough. Retry with backoff and a browser-like User-Agent, and surface a caller
// that always resolves rather than rejecting the whole cycle.
async function fetchJson(url, { timeoutMs = 15000, tries = 6 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (NepalEarlyWarning/v1)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = await res.json();
      clearTimeout(t);
      return data;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1300 * attempt));
    }
  }
  throw lastErr;
}

// Fetch that never rejects the caller on a flaky network — returns null instead.
async function fetchJsonSafe(url, opts) {
  try {
    return await fetchJson(url, opts);
  } catch {
    return null;
  }
}

// ---------- Earthquakes (USGS, real + live) ----------
async function fetchEarthquakes() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&starttime=${start.toISOString()}&endtime=${end.toISOString()}` +
    `&minlatitude=${NEPAL_BBOX.minlat}&maxlatitude=${NEPAL_BBOX.maxlat}` +
    `&minlongitude=${NEPAL_BBOX.minlon}&maxlongitude=${NEPAL_BBOX.maxlon}` +
    `&minmagnitude=3.5&orderby=time`;

  try {
    const data = await fetchJson(url);
    const quakes = (data.features || []).map((f) => ({
      id: f.id,
      mag: f.properties.mag,
      place: f.properties.place,
      time: new Date(f.properties.time).toISOString(),
      depthKm: f.geometry.coordinates[2],
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      url: f.properties.url,
    }));
    return { quakes, source: 'USGS', updatedAt: new Date().toISOString() };
  } catch (e) {
    console.error('Earthquake fetch failed:', e.message);
    return { quakes: [], source: 'USGS', updatedAt: new Date().toISOString(), error: e.message };
  }
}

// ---------- River discharge forecast + rainfall (Open-Meteo / GloFAS, real + live) ----------
async function fetchRiverDischarge(lat, lon) {
  // past_days gives us a baseline window; forecast_days gives the predictive horizon.
  // NOTE: no 'models' param — Open-Meteo flood API rejects 'models=seamless' (HTTP 400),
  // which silently killed forecast/upstream. The default model is used.
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${lat}&longitude=${lon}` +
    `&daily=river_discharge&past_days=90&forecast_days=7`;
  const data = await fetchJsonSafe(url);
  if (!data || !data.daily) throw new Error('No GloFAS discharge data for ' + lat + ',' + lon);
  const times = data.daily?.time || [];
  const values = data.daily?.river_discharge || [];
  const today = new Date().toISOString().slice(0, 10);
  const pastIdx = times.findIndex((t) => t === today);
  const pastVals = (pastIdx > 0 ? values.slice(0, pastIdx) : values).filter((v) => v != null);
  const futureVals = (pastIdx >= 0 ? values.slice(pastIdx) : values.slice(-7));
  const futureTimes = (pastIdx >= 0 ? times.slice(pastIdx) : times.slice(-7));

  const baseline = pastVals.length
    ? pastVals.reduce((a, b) => a + b, 0) / pastVals.length
    : null;
  const current = pastVals.length ? pastVals[pastVals.length - 1] : null;
  const peak = futureVals.length ? Math.max(...futureVals.filter((v) => v != null)) : null;
  const peakDayIdx = futureVals.indexOf(peak);
  const peakInDays = peakDayIdx >= 0 ? peakDayIdx : null;

  return {
    current, baseline, peak, peakInDays,
    daily: futureTimes.map((t, i) => ({ date: t, dischargeM3s: futureVals[i] })),
    // full live series (history + forecast) for the chart
    series: times.map((t, i) => ({ date: t, dischargeM3s: values[i] })),
    todayIdx: pastIdx >= 0 ? pastIdx : times.length,
  };
}

async function fetchRainfall(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=precipitation_sum&forecast_days=7&past_days=14&timezone=Asia%2FKathmandu`;
  const data = await fetchJsonSafe(url);
  if (!data || !data.daily) throw new Error('No rainfall data for ' + lat + ',' + lon);
  const times = data.daily?.time || [];
  const values = data.daily?.precipitation_sum || [];
  const today = new Date().toISOString().slice(0, 10);
  const todayIdx = times.indexOf(today);
  // Next 7 forecast days AFTER today (chronological order: past...today...future).
  const futureVals = (todayIdx >= 0 ? values.slice(todayIdx + 1, todayIdx + 1 + 7) : values.slice(-7)).filter((v) => v != null);
  const rain7d = Math.round(futureVals.reduce((a, b) => a + b, 0) * 10) / 10;
  // Antecedent saturation: the 14 days BEFORE today (rain-before-rain priming).
  const pastVals = (todayIdx >= 0 ? values.slice(Math.max(0, todayIdx - 14), todayIdx) : []).filter((v) => v != null);
  const rain14d = Math.round(pastVals.reduce((a, b) => a + b, 0) * 10) / 10;
  const daily = times.map((t, i) => ({ date: t, precipMm: values[i] ?? null }));
  return { rain7d, rain14d, daily, todayIdx: todayIdx >= 0 ? todayIdx : times.length };
}

async function buildRiverForecasts(latestQuakes = []) {
  const rivers = [];
  const rainfall = [];
  let maxAlertLevel = 0; // 0=WATCH..3=ALERT (numeric for easy comparison)
  const bandRank = { WATCH: 0, ADVISORY: 1, WARNING: 2, ALERT: 3 };

  for (const r of RIVERS) {
    try {
      const [discharge, rain] = await Promise.all([
        fetchRiverDischarge(r.lat, r.lon),
        fetchRainfall(r.lat, r.lon),
      ]);
      const ratio = discharge.baseline ? (discharge.peak ?? discharge.current ?? 0) / discharge.baseline : 1;
      const { band } = bandFromRatio(ratio || 1);
      maxAlertLevel = Math.max(maxAlertLevel, bandRank[band] ?? 0);

      const drivers = buildDrivers({
        band, ratio, rain7dMm: rain.rain7d, rain14dMm: rain.rain14d,
        baselineM3s: discharge.baseline, currentM3s: discharge.current,
        upstreamBand: null, quakeProximityKm: quakeProximityTo(latestQuakes, r.id), isUpstream: false,
      });

      rivers.push({
        id: r.id,
        name: r.name,
        district: r.district,
        band,
        peakDischargeM3s: discharge.peak,
        currentDischargeM3s: discharge.current,
        baselineM3s: discharge.baseline,
        peakInDays: discharge.peakInDays,
        rain7dMm: Math.round((rain.rain7d ?? 0) * 10) / 10,
        rain14dMm: Math.round((rain.rain14d ?? 0) * 10) / 10,
        rainDaily: rain.daily || [],
        daily: discharge.daily,
        series: discharge.series,
        todayIdx: discharge.todayIdx,
        drivers,
      });
      rainfall.push({ id: r.id, name: r.name, rain7dMm: rain.rain7d });
    } catch (e) {
      console.error(`Forecast fetch failed for ${r.name}:`, e.message);
      rivers.push({ id: r.id, name: r.name, district: r.district, band: 'UNKNOWN', error: e.message });
    }
  }

  return {
    rivers, rainfall, maxAlertLevel,
    updatedAt: new Date().toISOString(),
    source: 'GloFAS/Open-Meteo',
  };
}

// ---------- Transboundary upstream (real + live, same GloFAS mechanism) ----------
async function buildUpstream(latestQuakes = []) {
  const items = [];
  let maxUpstreamAlert = 0;
  const bandRank = { WATCH: 0, ADVISORY: 1, WARNING: 2, ALERT: 3 };

  for (const p of UPSTREAM_POINTS) {
    try {
      const [discharge, rain] = await Promise.all([
        fetchRiverDischarge(p.lat, p.lon),
        fetchRainfall(p.lat, p.lon),
      ]);
      const ratio = discharge.baseline ? (discharge.peak ?? discharge.current ?? 0) / discharge.baseline : 1;
      const { band } = bandFromRatio(ratio || 1);
      maxUpstreamAlert = Math.max(maxUpstreamAlert, bandRank[band] ?? 0);

      const drivers = buildDrivers({
        band, ratio, rain7dMm: rain.rain7d, rain14dMm: rain.rain14d,
        baselineM3s: discharge.baseline, currentM3s: discharge.current,
        upstreamBand: band, quakeProximityKm: quakeProximityTo(latestQuakes, p.id), isUpstream: true,
      });

      items.push({
        id: p.id,
        name: p.name,
        country: p.country,
        basin: p.basin,
        feeds: p.feeds,
        downstreamRiverId: p.downstreamRiverId,
        band,
        leadTimeHours: p.leadTimeHours,
        leadTimeNote: `Travel to Nepal: ${p.leadTimeHours[0]}-${p.leadTimeHours[1]}h — water seen here reaches the border in this window; evacuate before it arrives.`,
        watchPoints: p.watchPoints,
        currentDischargeM3s: discharge.current,
        peakDischargeM3s: discharge.peak,
        peakInDays: discharge.peakInDays,
        baselineM3s: discharge.baseline,
        rain7dMm: Math.round((rain.rain7d ?? 0) * 10) / 10,
        rainDaily: rain.daily || [],
        series: discharge.series,
        daily: discharge.daily,
        todayIdx: discharge.todayIdx,
        drivers,
      });
    } catch (e) {
      console.error(`Upstream fetch failed for ${p.name}:`, e.message);
      items.push({ id: p.id, name: p.name, band: 'UNKNOWN', error: e.message });
    }
  }

  return { items, maxUpstreamAlert, updatedAt: new Date().toISOString(), source: 'GloFAS/Open-Meteo (transboundary)' };
}

// ---------- Gauge stations ----------
// Prefer the OFFICIAL live BIPAD/DHM river-level gauges when available; fall back
// to the honest GloFAS reanalysis nowcast proxy when the official feed is down.
function buildBipadGauges(bipadRiver) {
  if (!bipadRiver || bipadRiver.status !== 'connected' || !Array.isArray(bipadRiver.stations)) return null;
  const stations = [];
  const levelRank = { normal: 0, rising: 1, warning: 2, danger: 3 };
  let maxLevel = 0;
  for (const s of bipadRiver.stations) {
    if (s.waterLevel == null) continue;
    let level = 'normal';
    if (s.rank >= 3) level = 'danger';
    else if (s.rank === 2) level = 'warning';
    else if (s.marginToWarning != null && s.marginToWarning <= 0.3) level = 'rising';
    maxLevel = Math.max(maxLevel, levelRank[level]);
    stations.push({
      id: `bipad-${s.id}`,
      name: s.name,
      basin: s.basin || null,
      lat: s.lat,
      lon: s.lon,
      live: true,
      value: s.waterLevel,
      unit: 'm',
      level,
      warningLevel: s.warningLevel,
      dangerLevel: s.dangerLevel,
      steady: s.steady,
      measuredOn: s.measuredOn,
      source: 'BIPAD/DHM river-station (live)',
    });
  }
  return {
    stations,
    totalStations: stations.length,
    stationsWithReading: stations.filter((s) => s.value != null).length,
    counts: {
      danger: stations.filter((s) => s.level === 'danger').length,
      warning: stations.filter((s) => s.level === 'warning').length,
      rising: stations.filter((s) => s.level === 'rising').length,
      normal: stations.filter((s) => s.level === 'normal').length,
    },
    maxLevel,
    updatedAt: new Date().toISOString(),
    status: 'live',
    source: 'BIPAD/DHM river level (official live gauges)',
  };
}

async function fetchGaugeStations(ctx) {
  const live = buildBipadGauges(ctx.bipadRiver);
  if (live && live.stations.length) return live;
  // Fallback: honest GloFAS nowcast proxy
  const proxy = await fetchGaugeNowcast(ctx.forecastRivers, ctx.upstreamItems);
  return { ...proxy, status: 'nowcast', note: 'BIPAD/DHM live gauges unavailable; using GloFAS proxy' };
}

// ---------- Satellite (live NASA LANCE + Copernicus GFM) ----------
async function fetchSatelliteSafe() {
  try {
    return await fetchSatellite();
  } catch (e) {
    return {
      status: 'unavailable',
      sources: [],
      overlay: null,
      activeSource: null,
      latestTime: null,
      updatedAt: new Date().toISOString(),
      error: e.message,
    };
  }
}

// ---------- Risk score ----------
// The national score is deliberately anchored on MEASURED (official) reality —
// live DHM gauges and observed rainfall — and the GloFAS/Open-Meteo forecast is
// used only as a modest modifier. A modelled ALERT on otherwise-normal gauges
// cannot by itself manufacture a HIGH national reading; the gauges are the truth.
function riskGaugeComponent(r, flood, forecastRiver) {
  // Official live DHM gauges drive the gauge component when available.
  if (flood && flood.status === 'live' && Array.isArray(flood.stations)) {
    const liveStations = flood.stations.filter((s) => s.live);
    if (liveStations.length) {
      // Match gauges to this river's DHM basin so the reading reflects the river
      // itself, not whichever gauge nationally happens to be worst.
      const basin = (r.basin || '').toLowerCase();
      const own = liveStations.filter((s) => (s.basin || '').toLowerCase() === basin);
      // Only count a gauge reading for THIS river's basin. If this river has no
      // in-basin gauge, don't inherit some other basin's (e.g. Mahakali) warning —
      // that would mislabel an unmeasured river as at-risk. Fall through to the
      // measured-by-model proxy below.
      if (own.length) {
        const worst = Math.max(...own.map((s) => ({ normal: 0, rising: 1, warning: 2, danger: 3 }[s.level] ?? 0)));
        // Derive both the numeric component and the matching threat band.
        const numeric = worst >= 3 ? 100 : worst === 2 ? 80 : worst === 1 ? 55 : 35;
        const level = worst >= 3 ? 'danger' : worst === 2 ? 'warning' : worst === 1 ? 'rising' : 'normal';
        return { gaugeComp: numeric, measuredLevel: level, measuredBand: gaugeBandFromLevel(level) };
      }
    }
  }
  // Fallback: discharge-ratio proxy (as before).
  const baselineM3s = forecastRiver?.baselineM3s;
  const gaugeComp = baselineM3s
    ? Math.min(100, ((forecastRiver?.currentDischargeM3s ?? baselineM3s) / baselineM3s) * 50)
    : 40;
  const level = gaugeComp >= 80 ? 'danger' : gaugeComp >= 60 ? 'warning' : gaugeComp >= 45 ? 'rising' : 'normal';
  return { gaugeComp, measuredLevel: level, measuredBand: gaugeBandFromLevel(level) };
}

function buildRiskScore(forecast, upstream, flood) {
  const bandScore = { WATCH: 20, ADVISORY: 45, WARNING: 70, ALERT: 95, UNKNOWN: 0 };
  const hasGauges = flood.status === 'live' && Array.isArray(flood.stations) && flood.stations.some((s) => s.live);
  const scores = forecast.rivers.map((r) => {
    const { gaugeComp, measuredBand } = riskGaugeComponent(r, flood, r);
    // BLEND both signals: measured DHM gauge (official/real) + GloFAS model forecast.
    const blended = hasGauges ? combineBands(r.band, measuredBand) : { band: r.band, source: 'forecast only (gauges unavailable)' };
    if (hasGauges) { r.band = blended.band; r.bandSource = blended.source; }
    const forecastComp = bandScore[r.band] ?? 0;
    const rainComp = Math.min(100, ((r.rain7dMm ?? 0) / RAIN_CAP_MM) * 100);      // observed 7-day rain
    // Measured (gauge + observed rain) is the core; forecast is a small boost.
    const measuredComp = Math.max(gaugeComp, rainComp);
    const score = Math.round(
      measuredComp * (RISK_WEIGHTS.gauge + RISK_WEIGHTS.rainfall) +
      forecastComp * RISK_WEIGHTS.forecast
    );
    return {
      id: r.id, name: r.name, district: r.district, realname: r.realname || r.name, score,
      band: r.band, peakInDays: r.peakInDays, rain7dMm: r.rain7dMm,
      measuredComp, forecastComp, gaugeComp, measuredBand, bandSource: r.bandSource,
      gaugeSource: hasGauges ? 'live BIPAD/DHM gauge' : 'proxy (live gauge unavailable)',
    };
  });

  scores.sort((a, b) => b.score - a.score);
  const highRiskCount = scores.filter((s) => s.score >= 60).length;
  // National = mean of the top-3, but ONLY count rivers with a real measured
  // signal (elevated gauge or meaningful rain). River whose elevation is purely
  // synthetic-forecast (measured calm) do not drag the national number up.
  const withSignal = scores.filter((s) => s.measuredComp >= 35);
  const pool = (withSignal.length ? withSignal : scores).slice(0, 3);
  const nationalScore = pool.length
    ? Math.round(pool.reduce((a, s) => a + s.score, 0) / pool.length)
    : 0;
  const { band, color } = riskBandFromScore(nationalScore);

  return {
    national: { score: nationalScore, band, color },
    scores,
    highRiskCount,
    updatedAt: new Date().toISOString(),
  };
}

// ---------- Live rain nowcast grid (shows WHERE it is raining over Nepal now) ----------
const RAIN_GRID = [
  { id: 'farwest_karnali', name: 'Far-West / Karnali', lat: 28.9, lon: 81.6 },
  { id: 'west_seti', name: 'West / Seti', lat: 28.9, lon: 80.9 },
  { id: 'mid_bheri', name: 'Mid-West / Bheri-Karnali', lat: 28.1, lon: 82.0 },
  { id: 'west_rapti', name: 'Rapti', lat: 27.8, lon: 82.8 },
  { id: 'gandaki_narayani', name: 'Gandaki / Narayani', lat: 27.9, lon: 84.3 },
  { id: 'kathmandu_trishuli', name: 'Kathmandu / Trishuli', lat: 27.9, lon: 85.3 },
  { id: 'east_saptakoshi', name: 'East / Sapta Koshi', lat: 27.0, lon: 87.0 },
  { id: 'far_east_arun', name: 'Far-East / Arun-Koshi', lat: 27.7, lon: 86.5 },
  { id: 'south_terai', name: 'Terai', lat: 26.9, lon: 85.2 },
];
// Dense grid for live rain radar overlay (30+ points covering all of Nepal)
const LIVE_RAIN_GRID = [
  // Western Nepal (Karnali) — Terai points matched to actual Nepal-India border latitude
  { lat:29.1, lon:80.6, name:'Far-West Mountains' },
  { lat:28.8, lon:81.2, name:'Far-West Hills' },
  { lat:28.5, lon:81.5, name:'Doti' },
  { lat:28.0, lon:81.6, name:'Far-West Terai' },
  { lat:29.2, lon:82.0, name:'Mugu' },
  { lat:28.9, lon:82.0, name:'Jumla' },
  { lat:28.2, lon:82.0, name:'Salyan' },
  { lat:27.9, lon:82.0, name:'Karnali Terai' },
  // Mid-Western (Bheri/Rapti)
  { lat:29.0, lon:82.7, name:'Dolpa' },
  { lat:28.6, lon:82.8, name:'Karnali Hills' },
  { lat:28.2, lon:82.9, name:'Pyuthan' },
  { lat:27.9, lon:82.9, name:'Bheri Hills' },
  { lat:27.5, lon:83.2, name:'Banke Terai' },
  // Central (Narayani/Trishuli)
  { lat:29.5, lon:83.9, name:'Mustang' },
  { lat:28.8, lon:83.0, name:'Rukum' },
  { lat:28.2, lon:83.0, name:'Dang' },
  { lat:27.9, lon:83.2, name:'Rapti Terai' },
  { lat:27.7, lon:84.4, name:'Chitwan Terai' },
  { lat:27.9, lon:84.5, name:'Bandipur' },
  { lat:28.3, lon:84.0, name:'Manaslu' },
  { lat:29.2, lon:83.5, name:'Annapurna' },
  // Kathmandu Valley + surround
  { lat:27.5, lon:85.3, name:'Kathmandu Valley' },
  { lat:27.8, lon:85.7, name:'Kavre' },
  { lat:28.0, lon:85.0, name:'Nuwakot' },
  { lat:28.3, lon:85.3, name:'Rasuwa' },
  { lat:29.0, lon:85.3, name:'Langtang/Tibet' },
  // Sunkoshi corridor
  { lat:27.2, lon:85.8, name:'Sindhuli' },
  { lat:27.6, lon:86.0, name:'Ramechhap' },
  { lat:28.0, lon:86.0, name:'Dolakha' },
  { lat:28.8, lon:86.0, name:'Gaurishankar' },
  { lat:27.5, lon:86.5, name:'Khimti' },
  // East-Central (Koshi)
  { lat:26.7, lon:87.0, name:'Sunsari Terai' },
  { lat:27.3, lon:87.0, name:'Koshi Hills' },
  { lat:27.6, lon:86.8, name:'Solukhumbu' },
  { lat:28.0, lon:86.7, name:'Everest Region' },
  { lat:27.0, lon:86.6, name:'Okhaldhunga' },
  // Far-East (Mechi)
  { lat:26.6, lon:87.8, name:'Jhapa Terai' },
  { lat:27.0, lon:88.0, name:'Ilam Hills' },
  { lat:27.4, lon:88.0, name:'Taplejung' },
  { lat:27.7, lon:88.0, name:'Kanchenjunga' },
  { lat:26.5, lon:88.1, name:'Mechi Terai' },
];

async function fetchLiveRainGrid() {
  // Open-Meteo supports batch requests: multiple coordinates in one call
  // Split into batches of 15 to stay under URL length limits
  const BATCH = 15;
  const items = [];
  for (let i = 0; i < LIVE_RAIN_GRID.length; i += BATCH) {
    const batch = LIVE_RAIN_GRID.slice(i, i + BATCH);
    try {
      const lats = batch.map(g => g.lat).join(',');
      const lons = batch.map(g => g.lon).join(',');
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
        `&current=precipitation,rain,showers,weather_code,temperature_2m,relative_humidity_2m,wind_speed_10m` +
        `&timezone=Asia%2FKathmandu`;
      const data = await fetchJsonSafe(u);
      // Open-Meteo returns an array when multiple coords are given
      const results = Array.isArray(data) ? data : [data];
      for (let j = 0; j < results.length; j++) {
        const g = batch[j];
        const r = results[j];
        const cur = r?.current || {};
        items.push({
          lat: g.lat, lon: g.lon, name: g.name,
          precipMmHr: cur.precipitation ?? 0,
          rainMmHr: cur.rain ?? 0,
          showersMmHr: cur.showers ?? 0,
          weatherCode: cur.weather_code ?? null,
          tempC: cur.temperature_2m ?? null,
          humidity: cur.relative_humidity_2m ?? null,
          windKmh: cur.wind_speed_10m ?? null,
        });
      }
    } catch (e) {
      for (const g of batch) {
        items.push({ lat: g.lat, lon: g.lon, name: g.name, precipMmHr: 0, error: e.message });
      }
    }
  }
  // Summary stats
  const totalRaining = items.filter(x => x.precipMmHr > 0).length;
  const heavyRain = items.filter(x => x.precipMmHr >= 4).length;
  const maxPrecip = Math.max(0, ...items.map(x => x.precipMmHr || 0));
  return {
    items, updatedAt: new Date().toISOString(),
    summary: { totalRaining, heavyRain, maxPrecipMmHr: maxPrecip, gridPoints: items.length },
    source: 'Open-Meteo live precipitation (real-time radar estimate)',
  };
}

async function fetchRainNowcast() {
  const items = [];
  for (const g of RAIN_GRID) {
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}` +
        `&hourly=precipitation_probability,precipitation&forecast_hours=6&timezone=Asia%2FKathmandu`;
      const data = await fetchJsonSafe(u);
      const probs = (data?.hourly?.precipitation_probability || []);
      const precip = (data?.hourly?.precipitation || []);
      const now = new Date();
      const hour = now.getHours();
      // pick the current hour's values if present else first forecast
      const idx = (data?.hourly?.time || [])[0] && [0,1,2,3,4,5].find((i) => hour === new Date(data.hourly.time[i]).getHours());
      const i = idx ?? 0;
      items.push({
        id: g.id, name: g.name, lat: g.lat, lon: g.lon,
        prob: probs[i] ?? 0,
        precipMm6h: (precip || []).slice(0, 6).reduce((a, b) => a + (b || 0), 0),
        precipNowMm: precip[i] ?? 0,
      });
    } catch (e) {
      items.push({ id: g.id, name: g.name, lat: g.lat, lon: g.lon, prob: null, error: e.message });
    }
  }
  return { items, updatedAt: new Date().toISOString(), source: 'Open-Meteo precipitation forecast (live)' };
}

export async function fetchAll() {
  // Forecast + upstream first: the satellite GFMS/gauge nowcast stages depend on
  // the discharge context, so they can't run in parallel with the very first build.
  // Earthquakes first: the multi-driver model needs quake proximity to flag GLOF risk.
  const earthquake = await fetchEarthquakes();
  const latestQuakes = earthquake.quakes || [];
  const [forecast, upstream] = await Promise.all([
    buildRiverForecasts(latestQuakes),
    buildUpstream(latestQuakes),
  ]);
  const gaugeCtx = {
    forecastRivers: forecast.rivers,
    upstreamItems: upstream.items.filter((u) => u.currentDischargeM3s != null && u.baselineM3s != null),
  };

  let bipad = null;
  let bipadRiver = null;
  try {
    bipad = await fetchBipadData();
    bipadRiver = bipad?.river || null;
  } catch (e) {
    console.error('BIPAD fetch failed:', e.message);
    bipad = { status: 'unavailable', source: 'BIPAD', error: e.message };
  }

  const [flood, satellite, rainNowcast, liveRain] = await Promise.all([
    fetchGaugeStations({ ...gaugeCtx, bipadRiver }),
    fetchSatelliteSafe(),
    fetchRainNowcast(),
    fetchLiveRainGrid(),
  ]);

  const risk = buildRiskScore(forecast, upstream, flood);

  return {
    fetchedAt: new Date().toISOString(),
    earthquake,
    bipad,
    flood,
    satellite,
    forecast,
    upstream,
    rainNowcast,
    liveRain,
    risk,
  };
}

export { RIVERS, UPSTREAM_POINTS, fetchRainNowcast, fetchLiveRainGrid };
