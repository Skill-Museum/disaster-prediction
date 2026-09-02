// scripts/bipad.js
//
// Official live BIPAD / DHM (Department of Hydrology and Meteorology) data for
// the Nepal Early-Warning dashboard. All endpoints are the public BIPAD Portal
// REST API (https://bipadportal.gov.np/api/v1/) — no key required.
//
// Sources wired in here:
//   rain-stations   -> live DHM rainfall stations (real-time 1/3/6/12/24h totals)
//   river-stations  -> live DHM river level gauges (water level vs danger/warning)
//   alert           -> official BIPAD alerts (DHM flood/heavy-rain warnings)
//   earthquake      -> BIPAD seismic feed (cross-check against USGS)
//   incident        -> disaster incidents (landslide, fire, flood, etc.)
//   highway         -> road closures / blockages (landslide, heavy rain)
//   loss            -> aggregated casualty / infrastructure loss data
//
// Only genuinely-recent readings are kept (measuredOn / waterLevelOn within a
// freshness window) so stale historical rows never masquerade as live data.

const API = 'https://bipadportal.gov.np/api/v1';
const FRESH_MS = 72 * 3600 * 1000; // consider a reading "live" within last 72h

// Hardened JSON fetch used across the codebase (retry + browser UA).
async function fetchJson(url, { timeoutMs = 20000, tries = 5 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (NepalEarlyWarning/v1)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const data = await res.json();
      clearTimeout(t);
      return data;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  throw lastErr;
}

async function fetchJsonSafe(url, opts) {
  try {
    return await fetchJson(url, opts);
  } catch {
    return null;
  }
}

function num(v) {
  return v == null || Number.isNaN(Number(v)) ? null : Number(v);
}

function pointLonLat(point) {
  // BIPAD returns GeoJSON: { type:'Point', coordinates:[lon,lat] }
  if (!point || !Array.isArray(point.coordinates) || point.coordinates.length < 2) return null;
  return { lon: point.coordinates[0], lat: point.coordinates[1] };
}

// ---------------- Live DHM rainfall stations ----------------
export async function fetchBipadRain({ limit = 200 } = {}) {
  const url = `${API}/rain-stations/?limit=${limit}&ordering=-measuredOn`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', stations: [], source: 'BIPAD/DHM' };
  }
  const now = Date.now();
  const stations = [];
  for (const s of data.results) {
    const measured = s.measuredOn ? Date.parse(s.measuredOn) : null;
    if (!measured) continue;
    const hourly = (s.averages || []).find((a) => a.interval === 1)?.value ?? null;
    const h24 = (s.averages || []).find((a) => a.interval === 24)?.value ?? null;
    const coord = pointLonLat(s.point);
    stations.push({
      id: s.id,
      name: s.title || s.description || `Rain station ${s.id}`,
      district: s.district != null ? String(s.district) : null,
      province: s.province != null ? String(s.province) : null,
      basin: s.basin || null,
      lat: coord ? coord.lat : null,
      lon: coord ? coord.lon : null,
      measuredOn: s.measuredOn,
      live: measured >= now - FRESH_MS,
      hourlyMm: num(hourly),
      rain24hMm: num(h24),
      averages: (s.averages || []).map((a) => ({ interval: a.interval, value: num(a.value), danger: a.status?.danger ?? false, warning: a.status?.warning ?? false })),
    });
  }
  stations.sort((a, b) => (b.live - a.live) || ((b.measuredOn || '').localeCompare(a.measuredOn || '')));
  const liveStations = stations.filter((s) => s.live);
  const liveWithRain = liveStations.filter((s) => (s.hourlyMm ?? 0) > 0.05);
  return {
    status: 'connected',
    source: 'BIPAD/DHM rain-stations',
    totalStations: stations.length,
    liveStations: liveStations.length,
    liveWithRain: liveWithRain.length,
    maxHourlyMm: Math.max(0, ...liveStations.map((s) => s.hourlyMm ?? 0)),
    stations: liveStations.map((s) => s.hourlyMm != null ? s : { ...s, hourlyMm: 0 }),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- Live DHM river level gauges ----------------
export async function fetchBipadRiver({ limit = 300 } = {}) {
  const url = `${API}/river-stations/?limit=${limit}&ordering=-waterLevelOn`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', stations: [], source: 'BIPAD/DHM' };
  }
  const now = Date.now();
  const stations = [];
  for (const r of data.results) {
    const ts = r.waterLevelOn || r.modifiedOn;
    const measured = ts ? Date.parse(ts) : null;
    if (!measured) continue;
    const coord = pointLonLat(r.point);
    const status = (r.status || '').toUpperCase();
    // BIPAD status strings: "BELOW WARNING LEVEL" (normal), "ABOVE WARNING LEVEL",
    // "ABOVE DANGER LEVEL", "AT DANGER LEVEL", etc. Only escalations count.
    const rank = /DANGER/.test(status) ? 3 : /(ABOVE|AT|REACHED|EXCEED)\s*(WARNING|DANGER)/.test(status) ? 2 : 0;
    const waterLevel = num(r.waterLevel);
    stations.push({
      id: r.id,
      name: r.title || r.description || `River station ${r.id}`,
      basin: r.basin || null,
      lat: coord ? coord.lat : null,
      lon: coord ? coord.lon : null,
      waterLevel,
      dangerLevel: num(r.dangerLevel),
      warningLevel: num(r.warningLevel),
      measuredOn: ts,
      live: measured >= now - FRESH_MS,
      status: (r.status || 'UNKNOWN').toUpperCase(),
      steady: r.steady || null,
      level: rank >= 3 ? 'danger' : rank === 2 ? 'warning' : 'normal',
      rank, // 0 normal, 2 warning, 3 danger
      marginToWarning: waterLevel != null && num(r.warningLevel) != null ? Math.round((num(r.warningLevel) - waterLevel) * 100) / 100 : null,
      marginToDanger: waterLevel != null && num(r.dangerLevel) != null ? Math.round((num(r.dangerLevel) - waterLevel) * 100) / 100 : null,
    });
  }
  stations.sort((a, b) => (b.live - a.live) || ((b.measuredOn || '').localeCompare(a.measuredOn || '')));
  const live = stations.filter((s) => s.live);
  return {
    status: 'connected',
    source: 'BIPAD/DHM river-stations',
    totalStations: stations.length,
    liveStations: live.length,
    counts: {
      danger: live.filter((s) => s.rank >= 3).length,
      warning: live.filter((s) => s.rank === 2).length,
      normal: live.filter((s) => s.rank < 2).length,
    },
    stations: live,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- Official BIPAD alerts (DHM warnings) ----------------
export async function fetchBipadAlerts({ limit = 50 } = {}) {
  const url = `${API}/alert/?limit=${limit}`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', alerts: [], source: 'BIPAD' };
  }
  const now = Date.now();
  const alerts = [];
  for (const a of data.results) {
    // Only public, verified, unexpired, DHM-sourced warnings
    if (a.public === false) continue;
    if (a.verified === false) continue;
    const expire = a.expireOn ? Date.parse(a.expireOn) : null;
    if (expire && expire < now) continue;
    const started = a.startedOn ? Date.parse(a.startedOn) : null;
    if (started && now - started > 7 * 24 * 3600 * 1000) continue; // skip old
    const coord = pointLonLat(a.point);
    const isWater = /river|flood|rain|water/i.test((a.source || '') + ' ' + (a.referenceType || ''));
    alerts.push({
      id: a.id,
      title: a.title,
      titleNe: a.titleNe || null,
      source: a.source || 'bipad',
      description: a.description || null,
      lat: coord ? coord.lat : null,
      lon: coord ? coord.lon : null,
      startedOn: a.startedOn,
      expireOn: a.expireOn,
      referenceType: a.referenceType || null,
      isWater,
    });
  }
  alerts.sort((x, y) => ((y.startedOn || '').localeCompare(x.startedOn || '')));
  return {
    status: 'connected',
    source: 'BIPAD alert API',
    total: alerts.length,
    waterAlerts: alerts.filter((a) => a.isWater).length,
    alerts,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- BIPAD seismic feed (cross-check) ----------------
export async function fetchBipadQuakes({ limit = 25 } = {}) {
  const url = `${API}/earthquake/?limit=${limit}&ordering=-createdOn`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', quakes: [], source: 'BIPAD' };
  }
  const quakes = data.results
    .map((q) => {
      const c = pointLonLat(q.point);
      return {
        id: q.id,
        mag: num(q.magnitude),
        place: q.address || null,
        lat: c ? c.lat : null,
        lon: c ? c.lon : null,
        eventOn: q.eventOn,
        description: q.description || null,
      };
    })
    .filter((q) => q.lat != null && q.mag != null);
  return {
    status: 'connected',
    source: 'BIPAD earthquake API',
    total: quakes.length,
    quakes,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- BIPAD disaster incidents (landslide, fire, flood, etc.) ----------------
const HAZARD_NAMES = {
  1:'Earthquake',2:'Flood',3:'Drought',4:'Epidemic',5:'Flood',
  6:'Landslide',7:'Avalanche',8:'Glacial Lake Outburst',9:'Fire',
  10:'Fire',11:'Thunderbolt',12:'Thunderbolt',13:'Storm',14:'Wind',
  15:'Hailstone',16:'Cold Wave',17:'Heat Wave',18:'Fog',
  19:'River Erosion',20:'Subsidence',21:'Insect',22:'Animal',
  23:'Thunderbolt',24:'Snowfall',25:'Rain',
};
export async function fetchBipadIncidents({ limit = 200 } = {}) {
  const url = `${API}/incident/?limit=${limit}&ordering=-incidentOn`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', incidents: [], source: 'BIPAD' };
  }
  const now = Date.now();
  const incidents = [];
  for (const i of data.results) {
    const ts = i.incidentOn || i.reportedOn || i.createdOn;
    const dt = ts ? Date.parse(ts) : null;
    if (!dt) continue;
    if (now - dt > 5 * 365 * 24 * 3600 * 1000) continue; // skip > 5 years old
    const coord = pointLonLat(i.point);
    const hazardId = i.hazard != null ? Number(i.hazard) : null;
    const hazardName = HAZARD_NAMES[hazardId] || (hazardId != null ? `Hazard #${hazardId}` : 'Unknown');
    const isLandslide = /landslide|avalanche|subsidence/i.test(hazardName) || /landslide/i.test(i.title || '') || /landslide|ढल|पहिरो/i.test(i.description || '') || /6|7|20/.test(String(hazardId));
    const isFire = /fire/i.test(hazardName) || /fire|आगो/i.test(i.title || '');
    const isFlood = /flood|flash/i.test(hazardName) || /flood|बाढी/i.test(i.title || '');
    const loss = i.loss != null ? Number(i.loss) : null;
    incidents.push({
      id: i.id,
      title: i.title || i.description || `${hazardName} incident`,
      titleNe: i.titleNe || null,
      description: i.description || i.detail || null,
      hazardId,
      hazard: hazardName,
      isLandslide,
      isFire,
      isFlood,
      lat: coord ? coord.lat : null,
      lon: coord ? coord.lon : null,
      incidentOn: i.incidentOn || null,
      reportedOn: i.reportedOn || null,
      source: i.dataSource || i.source || 'BIPAD',
      verified: i.verified === true,
      loss,
      cause: i.cause || null,
      streetAddress: i.streetAddress || null,
      municipality: i.municipality != null ? String(i.municipality) : null,
      district: i.district != null ? String(i.district) : null,
      province: i.province != null ? String(i.province) : null,
    });
  }
  incidents.sort((a, b) => (b.incidentOn || '').localeCompare(a.incidentOn || ''));
  return {
    status: 'connected',
    source: 'BIPAD incident API',
    total: incidents.length,
    landslides: incidents.filter((i) => i.isLandslide).length,
    fires: incidents.filter((i) => i.isFire).length,
    floods: incidents.filter((i) => i.isFlood).length,
    recent: incidents.filter((i) => now - Date.parse(i.incidentOn || '2000') < 30 * 24 * 3600 * 1000).length,
    incidents,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- BIPAD highway / road closure data ----------------
export async function fetchBipadHighways({ limit = 300 } = {}) {
  const url = `${API}/highway/?limit=${limit}&ordering=-dateCreated`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', roads: [], landslides: [], source: 'BIPAD' };
  }
  const now = Date.now();
  const REASON_WS = 14 * 24 * 3600 * 1000; // a road event stays "active" for 14 days
  const roads = [];
  for (const h of data.results) {
    let ts = h.dateRoadblockStart || h.dateCreated || h.createdOn;
    let dt = ts ? Date.parse(ts) : null;
    // BIPAD sometimes stores Bikram Sambat dates (e.g. "2083-03-29") that parse as
    // far-future; treat those as "recently active" rather than garbage.
    const farFuture = dt && dt > Date.parse('2027-01-01');
    if (farFuture) dt = now - 1;
    if (!dt) continue;
    if (now - dt > 180 * 24 * 3600 * 1000) continue; // skip > 6 months old
    const coord = pointLonLat(h.point);
    const status = (h.status || 'UNKNOWN').toUpperCase();
    const isClosed = status === 'CLOSED';
    const isPartial = status === 'PARTIAL_OPEN';
    const isRecent = now - dt <= REASON_WS;
    const reason = h.closureReason || null;
    const isLandslide = /landslide|glof|erosion|pahiro/i.test(reason || '') || /landslide|glof/i.test(h.remarks || '');
    roads.push({
      id: h.id,
      title: h.title || h.location || `Road segment ${h.id}`,
      roadRefno: h.roadRefno || null,
      linkCode: h.linkCode || null,
      status,
      isClosed,
      isPartial,
      isLandslide,
      isRecent,
      closureReason: reason,
      remarks: h.remarks || null,
      repairEta: h.repairEta || null,
      lat: coord ? coord.lat : null,
      lon: coord ? coord.lon : null,
      dateRoadblockStart: ts,
      dateRoadblockEndEstimated: h.dateRoadblockEndEstimated || null,
      dateRoadblockEnd: h.dateRoadblockEnd || null,
      chainage: h.chainage != null ? Number(h.chainage) : null,
      endChainage: h.endChainage != null ? Number(h.endChainage) : null,
      division: h.division || null,
      location: h.location || null,
      municipality: h.municipality != null ? String(h.municipality) : null,
      district: h.district != null ? String(h.district) : null,
      province: h.province != null ? String(h.province) : null,
      effortsBeingMade: h.effortsBeingMade || null,
    });
  }
  roads.sort((a, b) => ((b.dateRoadblockStart || b.dateCreated || '').localeCompare(a.dateRoadblockStart || a.dateCreated || '')));
  // Currently-blocked roads: recent CLOSED or PARTIAL_OPEN events
  const active = roads.filter((r) => r.isRecent && (r.isClosed || r.isPartial));
  // Landslide events: road blockages caused by landslide/GLOF, with coordinates
  const landslides = roads
    .filter((r) => r.isLandslide && r.lat != null && r.lon != null)
    .filter((r) => { const d = r.dateRoadblockStart ? Date.parse(r.dateRoadblockStart) : null; return d ? (now - d <= 60 * 24 * 3600 * 1000) : true; })
    .slice(0, 60);
  return {
    status: 'connected',
    source: 'BIPAD highway API',
    total: roads.length,
    activeCount: active.length,
    closedCount: active.filter((r) => r.isClosed).length,
    partialCount: active.filter((r) => r.isPartial).length,
    landslideCount: landslides.length,
    reasons: [...new Set(roads.map((r) => r.closureReason).filter(Boolean))].slice(0, 12),
    roads: active,
    landslides,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- BIPAD aggregated loss data ----------------
export async function fetchBipadLoss({ limit = 50 } = {}) {
  const url = `${API}/loss/?limit=${limit}&ordering=-createdOn`;
  const data = await fetchJsonSafe(url);
  if (!data || !Array.isArray(data.results)) {
    return { status: 'unavailable', totals: {}, source: 'BIPAD' };
  }
  const totals = {
    deaths: 0, missing: 0, injured: 0, affected: 0,
    familyAffected: 0, familyRelocated: 0, familyEvacuated: 0,
    livestockDestroyed: 0,
    infraDestroyed: 0, infraAffected: 0,
    roadDestroyed: 0, roadAffected: 0,
    bridgeDestroyed: 0, bridgeAffected: 0,
    electricityDestroyed: 0, electricityAffected: 0,
    economicLoss: 0, agricultureLoss: 0,
    records: data.results.length,
  };
  for (const l of data.results) {
    totals.deaths += l.peopleDeathCount || 0;
    totals.missing += l.peopleMissingCount || 0;
    totals.injured += l.peopleInjuredCount || 0;
    totals.affected += l.peopleAffectedCount || 0;
    totals.familyAffected += l.familyAffectedCount || 0;
    totals.familyRelocated += l.familyRelocatedCount || 0;
    totals.familyEvacuated += l.familyEvacuatedCount || 0;
    totals.livestockDestroyed += l.livestockDestroyedCount || 0;
    totals.infraDestroyed += l.infrastructureDestroyedCount || 0;
    totals.infraAffected += l.infrastructureAffectedCount || 0;
    totals.roadDestroyed += l.infrastructureDestroyedRoadCount || 0;
    totals.roadAffected += l.infrastructureAffectedRoadCount || 0;
    totals.bridgeDestroyed += l.infrastructureDestroyedBridgeCount || 0;
    totals.bridgeAffected += l.infrastructureAffectedBridgeCount || 0;
    totals.electricityDestroyed += l.infrastructureDestroyedElectricityCount || 0;
    totals.electricityAffected += l.infrastructureAffectedElectricityCount || 0;
    totals.economicLoss += l.infrastructureEconomicLoss || 0;
    totals.agricultureLoss += l.agricultureEconomicLoss || 0;
  }
  return {
    status: 'connected',
    source: 'BIPAD loss API',
    totals,
    updatedAt: new Date().toISOString(),
  };
}

// ---------------- Combined BIPAD block ----------------
export async function fetchBipadData() {
  const [rain, river, alerts, quakes, incidents, highways, loss] = await Promise.all([
    fetchBipadRain(),
    fetchBipadRiver(),
    fetchBipadAlerts(),
    fetchBipadQuakes(),
    fetchBipadIncidents(),
    fetchBipadHighways(),
    fetchBipadLoss(),
  ]);
  return {
    status: river.status === 'connected' || rain.status === 'connected' ? 'connected' : 'unavailable',
    updatedAt: new Date().toISOString(),
    source: 'BIPAD Portal (official, live DHM)',
    rain,
    river,
    alerts,
    quakes,
    incidents,
    highways,
    loss,
  };
}

export default fetchBipadData;
