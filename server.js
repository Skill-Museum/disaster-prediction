import express from 'express';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAll } from './scripts/fetch-data.js';
import { evaluateAlerts } from './scripts/alerts.js';
import { runAgent } from './scripts/agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const REFRESH_MS = Number(process.env.REFRESH_MS) || (2 * 60 * 1000); // refresh live data every 2 min

let state = {
  fetchedAt: null,
  earthquake: { quakes: [] },
  bipad: null,
  flood: { stations: [] },
  satellite: { status: 'unavailable', sources: [], overlay: null },
  forecast: { rivers: [], rainfall: [], maxAlertLevel: 0 },
  upstream: { items: [], maxUpstreamAlert: 0 },
  rainNowcast: { items: [] },
  liveRain: { items: [], summary: { totalRaining: 0, heavyRain: 0, maxPrecipMmHr: 0, gridPoints: 0 } },
  risk: { national: { score: 0, band: 'MINIMAL', color: 'green' }, scores: [] }
};
let lastFull = null;
let alertLog = [];
let agentResearchCount = 0;

function broadcastToAll(payload) {
  const json = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(json);
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({
    fetchedAt: state.fetchedAt,
    earthquake: {
      totalInNepal: state.earthquake?.quakes?.length || 0,
      source: state.earthquake?.source || 'USGS',
      updatedAt: state.earthquake?.updatedAt || null
    },
    flood: {
      totalStations: state.flood?.totalStations || 0,
      stationsWithReading: state.flood?.stationsWithReading || 0,
      counts: state.flood?.counts || {},
      updatedAt: state.flood?.updatedAt || null,
      source: state.flood?.source || 'DHM'
    },
    bipad: {
      status: state.bipad?.status || 'unavailable',
      source: state.bipad?.source || null,
      rainLive: state.bipad?.rain?.liveStations || 0,
      rainWithRain: state.bipad?.rain?.liveWithRain || 0,
      riverLive: state.bipad?.river?.liveStations || 0,
      riverWarnings: state.bipad?.river?.counts?.warning || 0,
      riverDanger: state.bipad?.river?.counts?.danger || 0,
      alerts: state.bipad?.alerts?.total || 0,
      waterAlerts: state.bipad?.alerts?.waterAlerts || 0,
      incidents: state.bipad?.incidents?.total || 0,
      landslides: state.bipad?.incidents?.landslides || 0,
      activeRoads: state.bipad?.highways?.activeCount || 0,
      closedRoads: state.bipad?.highways?.closedCount || 0,
      totalLoss: state.bipad?.loss?.totals?.deaths || 0,
      updatedAt: state.bipad?.updatedAt || null
    },
    satellite: {
      status: state.satellite?.status || 'unavailable',
      activeSource: state.satellite?.activeSource || null,
      latestTime: state.satellite?.latestTime || null,
      updatedAt: state.satellite?.updatedAt || null,
      source: state.satellite?.source || null
    },
    forecast: {
      maxAlertLevel: state.forecast?.maxAlertLevel || 0,
      rivers: state.forecast?.rivers?.length || 0,
      updatedAt: state.forecast?.updatedAt || null,
      source: state.forecast?.source || 'GloFAS/Open-Meteo'
    },
    upstream: {
      maxAlert: state.upstream?.maxUpstreamAlert || 0,
      points: state.upstream?.items?.length || 0,
      updatedAt: state.upstream?.updatedAt || null,
      source: state.upstream?.source || null
    },
    risk: {
      score: state.risk?.national?.score || 0,
      band: state.risk?.national?.band || 'MINIMAL',
      highRiskCount: state.risk?.highRiskCount || 0,
      updatedAt: state.risk?.updatedAt || null
    }
  });
});

app.get('/api/earthquake', (req, res) => res.json(state.earthquake));
app.get('/api/bipad', (req, res) => res.json(state.bipad));
app.get('/api/flood', (req, res) => res.json(state.flood));
app.get('/api/satellite', (req, res) => res.json(state.satellite));
app.get('/api/forecast', (req, res) => res.json(state.forecast));
app.get('/api/upstream', (req, res) => res.json(state.upstream));
app.get('/api/rain', (req, res) => res.json(state.rainNowcast));
app.get('/api/liverain', (req, res) => res.json(state.liveRain));
app.get('/api/risk', (req, res) => res.json(state.risk));
app.get('/api/alerts', (req, res) => res.json({ alerts: alertLog }));
app.get('/api/agent', (req, res) => res.json({ status: 'ready', researched: agentResearchCount, note: 'agent runs automatically each refresh on suspicious triggers' }));

function broadcast() {
  broadcastToAll({ type: 'update', ...state });
}

// Surface official BIPAD water alerts + live DHM river warnings as dashboard alerts,
// deduplicated by id so they don't re-fire every 2-minute cycle.
const bipadLastAlerted = new Set();
function buildBipadAlerts(bipad) {
  const alerts = [];
  if (!bipad || bipad.status !== 'connected') return alerts;

  // 1) Official BIPAD DHM water alerts (flood / heavy rain warnings)
  for (const a of bipad.alerts?.alerts || []) {
    if (!a.isWater) continue;
    const key = `bipad-alert-${a.id}`;
    if (bipadLastAlerted.has(key)) continue;
    bipadLastAlerted.add(key);
    alerts.push({
      id: key,
      type: 'bipad',
      severity: /flood/i.test(a.title || '') ? 'danger' : 'warning',
      message: `🇳🇵 BIPAD/DHM ALERT: ${a.title}${a.startedOn ? ' (from ' + a.startedOn.replace('T', ' ').slice(0, 16) + ')' : ''}${a.description ? ' — ' + a.description.split('\n').join(' ').slice(0, 140) : ''}`,
      at: new Date().toISOString(),
      source: 'BIPAD',
      referenceType: a.referenceType,
    });
  }

  // 2) Live DHM river gauges at/above WARNING or DANGER level
  for (const s of bipad.river?.stations || []) {
    if (!s.live || s.rank < 2) continue;
    const key = `bipad-river-${s.id}-${s.rank}`;
    if (bipadLastAlerted.has(key)) continue;
    bipadLastAlerted.add(key);
    const levelLabel = s.rank >= 3 ? 'DANGER' : 'WARNING';
    alerts.push({
      id: key,
      type: 'bipad-gauge',
      severity: s.rank >= 3 ? 'danger' : 'warning',
      message: `🇳🇵 DHM RIVER ${levelLabel}: ${s.name} water level ${s.waterLevel} m` +
        (s.warningLevel != null ? ` (warning ${s.warningLevel})` : '') +
        (s.dangerLevel != null ? ` (danger ${s.dangerLevel})` : '') +
        (s.steady ? `, ${s.steady}` : '') + '.',
      at: new Date().toISOString(),
      source: 'BIPAD/DHM',
      stationId: s.id,
    });
  }

  return alerts;
}

// Surface new landslide incidents, road closures, and active road blockages
// as dashboard alerts, deduplicated by id.
const incidentLastAlerted = new Set();
function buildIncidentAlerts(bipad) {
  const alerts = [];
  if (!bipad || bipad.status !== 'connected') return alerts;

  // 1) Landslide / fire / flood incidents (last 30 days only)
  const now = Date.now();
  for (const inc of bipad.incidents?.incidents || []) {
    const ts = inc.incidentOn ? Date.parse(inc.incidentOn) : null;
    if (!ts || now - ts > 30 * 24 * 3600 * 1000) continue;
    if (!inc.isLandslide && !inc.isFire && !inc.isFlood) continue;
    const key = `bipad-inc-${inc.id}`;
    if (incidentLastAlerted.has(key)) continue;
    incidentLastAlerted.add(key);
    const emoji = inc.isLandslide ? '🏔️' : inc.isFire ? '🔥' : '🌊';
    const sev = inc.isLandslide ? 'danger' : inc.isFlood ? 'danger' : 'warning';
    alerts.push({
      id: key,
      type: 'bipad-incident',
      severity: sev,
      message: `${emoji} BIPAD INCIDENT: ${inc.title}${inc.incidentOn ? ' (' + inc.incidentOn.slice(0, 10) + ')' : ''}${inc.district ? ' — District ' + inc.district : ''}${inc.verified ? ' [verified]' : ''}`,
      at: new Date().toISOString(),
      source: 'BIPAD',
      hazard: inc.hazard,
    });
  }

  // 2) Active road closures (blocked by landslide/heavy rain)
  for (const r of bipad.highways?.roads || []) {
    if (r.dateRoadblockEnd) continue; // already resolved
    if (!r.isClosed && !r.isPartial) continue;
    // Re-notify when a road ESCALATES (PARTIAL -> CLOSED) or re-blocks after being
    // cleared, so a live status change always reaches the user, not just new ids.
    const key = `bipad-road-${r.id}-${r.isClosed ? 'CLOSED' : 'PARTIAL'}`;
    if (incidentLastAlerted.has(key)) continue;
    incidentLastAlerted.add(key);
    const statusLabel = r.isClosed ? 'BLOCKED' : 'PARTIAL';
    const emoji = /landslide/i.test(r.closureReason || '') ? '🏔️' : /rain/i.test(r.closureReason || '') ? '🌧️' : '🚧';
    alerts.push({
      id: key,
      type: 'bipad-road',
      severity: r.isClosed ? 'danger' : 'warning',
      message: `${emoji} ROAD ${statusLabel}: ${r.title}${r.closureReason ? ' (' + r.closureReason + ')' : ''}${r.dateRoadblockStart ? ' since ' + r.dateRoadblockStart.slice(0, 10) : ''}${r.district ? ' — District ' + r.district : ''}`,
      at: new Date().toISOString(),
      source: 'BIPAD',
      roadId: r.id,
    });
  }

  return alerts;
}

async function refresh() {
  try {
    console.log(`[${new Date().toISOString()}] Fetching live data...`);
    const data = await fetchAll();
    state = {
      fetchedAt: data.fetchedAt,
      earthquake: data.earthquake,
      bipad: data.bipad,
      flood: data.flood,
      satellite: data.satellite,
      forecast: data.forecast,
      upstream: data.upstream,
      rainNowcast: data.rainNowcast,
      liveRain: data.liveRain,
      risk: data.risk
    };
    lastFull = data;

    // Evaluate & push alerts (transboundary upstream, HIGH/EXTREME risk,
    // DANGER/NEAR-DANGER gauges, M>=4.5 quakes)
    const cycle = evaluateAlerts(state);
    const bipadAlerts = buildBipadAlerts(state.bipad);
    const incidentAlerts = buildIncidentAlerts(state.bipad);
    const all = [...cycle.alerts, ...bipadAlerts, ...incidentAlerts];
    if (all.length) {
      alertLog = [...alertLog, ...all];
      alertLog = alertLog.slice(-100);
      broadcastToAll({ type: 'alert', alerts: all });
      console.log(`[${new Date().toISOString()}] ALERTS (${all.length}):`);
      for (const a of all) console.log('  - ' + a.message);
    }

    // Auto-research agent: on any suspicious trigger, search the web for
    // confirmation/news and surface the freshest headline as an alert.
    // Set DISABLE_AGENT=1 to skip web searches (e.g. restricted-egress hosts).
    if (process.env.DISABLE_AGENT !== '1') try {
      const { findings } = await runAgent(state);
      if (findings.length) {
        const agentAlerts = findings.map((f) => ({
          id: `agent-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
          type: 'agent',
          severity: f.headline ? 'warning' : 'info',
          message: f.headline
            ? `🛰️ AGENT FOUND: ${f.topic}. "${f.headline}"${f.snippet ? ' — ' + f.snippet : ''} ${f.sourceUrl ? '(' + f.sourceUrl + ')' : ''}`
            : `🛰️ AGENT: ${f.topic} detected (${f.reason}); no live news snippet retrieved.`,
          at: f.at,
          agent: true,
          topic: f.topic,
          reason: f.reason,
          headline: f.headline,
          snippet: f.snippet,
          sourceUrl: f.sourceUrl,
        }));
        alertLog = [...alertLog, ...agentAlerts];
        alertLog = alertLog.slice(-120);
        agentResearchCount += agentAlerts.length;
        broadcastToAll({ type: 'alert', alerts: agentAlerts });
        console.log(`[${new Date().toISOString()}] AGENT FINDINGS (${agentAlerts.length}):`);
        for (const a of agentAlerts) console.log('  - ' + a.message);
      }
    } catch (e) {
      console.error('Agent run failed:', e.message);
    }

    broadcast();
    const bipadLine = state.bipad?.status === 'connected'
      ? `, BIPAD: ${state.bipad.rain?.liveStations ?? 0} rain / ${state.bipad.river?.liveStations ?? 0} river live | ${state.bipad.incidents?.landslides ?? 0} landslides | ${state.bipad.highways?.activeCount ?? 0} road events`
      : ', BIPAD: unavailable';
    console.log(`[${new Date().toISOString()}] Done. Quakes: ${state.earthquake.quakes.length}, Gauges: ${state.flood.stations.length}, Satellite: ${state.satellite.status}, Risk: ${state.risk.national.band}, Upstream: ${state.upstream.maxUpstreamAlert}${bipadLine}`);
  } catch (e) {
    console.error('Refresh failed:', e.message);
  }
}

wss.on('connection', (ws) => {
  // Send the current state immediately when a client connects
  ws.send(JSON.stringify({ type: 'init', ...state }));
  if (alertLog.length) ws.send(JSON.stringify({ type: 'alert', alerts: alertLog.slice(-20) }));
});

server.listen(PORT, () => {
  console.log(`\nNepal Disaster Monitor (floods + earthquakes) running:`);
  console.log(`  http://localhost:${PORT}\n`);
  refresh();
  setInterval(refresh, REFRESH_MS);
});
