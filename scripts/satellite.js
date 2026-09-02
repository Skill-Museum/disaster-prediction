// scripts/satellite.js
//
// LIVE, keyless satellite flood-extent layer for the Nepal dashboard.
//
// Two complementary sources, both browser-renderable with NO API key:
//   1. NASA LANCE near-real-time flood (MODIS `MCDWD` / VIIRS `VCDWD`), served
//      by NASA GIBS as keyless EPSG:4326 WMTS tiles. This is the layer that an
//      overpass actually catches — the only thing that can "see" a GLOF/cloud
//      flood plume on the Bhotekoshi within ~1-2 days.
//   2. Copernicus GFM (Sentinel-1 SAR) flood extent via keyless WMS. SAR sees
//      through cloud but has a ~6-day revisit, so it often misses a flash event.
//
// The server resolves the latest NRT date + builds a browser-ready overlay
// config; the browser fetches tiles directly from NASA/Copernicus (no proxy,
// no key, no CORS issue on GIBS tiles).

const NEPAL_BBOX = '80.0,26.0,89.0,30.5';

const GIBS = {
  provider: 'NASA LANCE (EOSDIS) — keyless GIBS tiles',
  base: 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best',
  tileMatrixSet: '250m',
  // Order matters: 2-day composites are more reliable than 1-day (cloud shadow prone).
  layers: {
    modis2: { id: 'MODIS_Combined_Flood_2-Day', name: 'NASA MODIS flood 2-day' },
    viirs2: { id: 'VIIRS_Combined_Flood_2-Day', name: 'NASA VIIRS flood 2-day' },
    modis1: { id: 'MODIS_Combined_Flood_1-Day', name: 'NASA MODIS flood 1-day' },
    viirs1: { id: 'VIIRS_Combined_Flood_1-Day', name: 'NASA VIIRS flood 1-day' },
  },
};

const SOURCES = {
  gfm: {
    id: 'gfm',
    name: 'Copernicus GFM — Sentinel-1 SAR',
    kind: 'wms',
    wmsUrl: 'https://ows.globalfloods.eu/glofas-ows/ows.py',
    capabilities: 'https://ows.globalfloods.eu/glofas-ows/ows.py?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetCapabilities',
    layers: {
      floodExtent: 'gfm_observed_flood_extent_group_layer',
      waterExtent: 'gfm_observed_water_extent_group_layer',
      referenceWater: 'gfm_reference_water_mask_group_layer',
      uncertainty: 'gfm_uncertainty_values_group_layer',
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url, { timeout = 25000, maxBytes = 3 * 1024 * 1024, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    Promise.resolve(import('node:' + (url.startsWith('https:') ? 'https' : 'http'))).then((mod) => {
      const u = new URL(url);
      const req = mod.request(
        u,
        {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (nepal-early-warning)',
            'Referer': 'https://global-flood.emergency.copernicus.eu/',
            'Accept': '*/*',
          },
        },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            return resolve(httpGet(next, { timeout, maxBytes, redirects: redirects + 1 }));
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      const t = setTimeout(() => req.destroy(new Error('timeout')), timeout);
      req.on('close', () => clearTimeout(t));
      req.end();
    }).catch(reject);
  });
}

function parseLatestTime(capabilitiesXml) {
  const re = /<Dimension\s+name="time"(?:\s+[^>]*)?>([^<]*)</g;
  let m, latest = null;
  const seen = new Set();
  while ((m = re.exec(capabilitiesXml)) !== null) {
    const val = m[1].trim();
    if (!val || seen.has(val)) continue;
    seen.add(val);
    const parts = val.split('/');
    if (parts.length < 2) continue;
    const end = parts[1];
    if (!end || end.startsWith('PT') || end.length < 10 || /^2100/.test(end)) continue;
    const endYear = Number(end.slice(0, 4));
    if (!Number.isFinite(endYear) || endYear > 2099) continue;
    if (!latest || Number(end.slice(0, 4)) > Number(latest.slice(0, 4))) latest = end;
  }
  return latest;
}

function isLikelyTransparentPng(buf) {
  if (buf.length < 50) return true;
  const u8 = new Uint8Array(buf);
  let nonzero = 0;
  const step = Math.max(1, Math.floor(u8.length / 2000));
  for (let i = 0; i < u8.length; i += step) if (u8[i] !== 0) nonzero++;
  return nonzero === 0;
}

async function checkSource(source) {
  const result = { id: source.id, name: source.name, provider: 'Copernicus Global Flood Monitoring (Sentinel-1 SAR)', kind: source.kind, ok: false, latestTime: null, probe: null, error: null, wmsUrl: source.wmsUrl, layers: source.layers };
  try {
    const caps = await httpGet(source.capabilities);
    if (caps.status !== 200) throw new Error('GetCapabilities HTTP ' + caps.status);
    result.latestTime = parseLatestTime(caps.body.toString('utf8'));
    const layer = source.layers.floodExtent;
    const url = `${source.wmsUrl}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(layer)}&STYLES=&CRS=EPSG:4326&BBOX=${NEPAL_BBOX}&WIDTH=360&HEIGHT=200&FORMAT=image/png&TRANSPARENT=true`;
    const probe = await httpGet(url, { timeout: 40000 }).then((res) => {
      const b = res.body.toString('latin1');
      const isPng = res.body.length >= 8 && b.charCodeAt(0) === 137 && b[1] === 'P' && b[2] === 'N' && b[3] === 'G';
      if (!isPng) return { ok: false, http: res.status, note: 'non-PNG' };
      const empty = isLikelyTransparentPng(res.body) || res.body.length < 200;
      return { ok: true, http: res.status, empty, bytes: res.body.length };
    }).catch((e) => ({ ok: false, error: e.message }));
    result.probe = probe;
    result.ok = !!(source.wmsUrl && source.layers);
    if (!probe.ok) result.note = probe.error || probe.note || 'probe unavailable';
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// GIBS EPSG:4326 "250m" tile-matrix grid widths by level (observed from GIBS GetCapabilities).
const GIBS_GRID_WIDTH = { 0: 2, 1: 3, 2: 5, 3: 10, 4: 20, 5: 40, 6: 80, 7: 160, 8: 320, 9: 640, 10: 1280, 11: 2560, 12: 5120 };

function gibsTile(lat, lon, level) {
  const w = GIBS_GRID_WIDTH[level] || (10 * Math.pow(2, level - 3));
  const h = Math.floor(w / 2);
  const x = Math.floor(((lon + 180) / 360) * w);
  const y = Math.floor(((90 - lat) / 180) * h);
  return { x, y };
}

async function checkGibs() {
  const result = {
    id: 'gibs', name: GIBS.layers.modis2.name, provider: GIBS.provider,
    ok: false, layer: GIBS.layers.modis2.id, latestTime: null,
    tmsTemplate: null, tileUrl: null, probe: null, error: null,
  };
  try {
    const domainUrl = `${GIBS.base}/wmts.cgi?Service=WMTS&Request=DescribeDomains&Version=1.0.0&layer=${encodeURIComponent(GIBS.layers.modis2.id)}&tilematrixset=${GIBS.tileMatrixSet}`;
    const dom = await httpGet(domainUrl, { timeout: 40000 });
    if (dom.status !== 200) throw new Error('DescribeDomains HTTP ' + dom.status);
    const dm = /<Domain>([^<]+)<\/Domain>/.exec(dom.body.toString('utf8'));
    if (!dm) throw new Error('no time domain');
    const ranges = dm[1].split(',').filter(Boolean);
    const latest = ranges[ranges.length - 1].split('/')[1];
    if (!latest || !/^\d{4}-\d{2}-\d{2}$/.test(latest)) throw new Error('unparseable latest: ' + latest);
    result.latestTime = latest;

    const tms = `${GIBS.base}/${GIBS.layers.modis2.id}/default/{time}/${GIBS.tileMatrixSet}/{z}/{y}/{x}.png`;
    const { x, y } = gibsTile(28.2, 84.1, 8);
    const tileUrl = tms.replace('{time}', latest).replace('{z}', '8').replace('{y}', String(y)).replace('{x}', String(x));
    result.tmsTemplate = tms.replace('{time}', latest);
    result.tileUrl = tileUrl;

    const probeTile = async () => {
      const res = await httpGet(tileUrl, { timeout: 45000 });
      const b = res.body.toString('latin1');
      const isPng = res.body.length >= 8 && b.charCodeAt(0) === 137 && b[1] === 'P' && b[2] === 'N' && b[3] === 'G';
      if (!isPng) return { ok: false, http: res.status, note: 'non-PNG' };
      const empty = isLikelyTransparentPng(res.body) || res.body.length < 200;
      return { ok: true, http: res.status, empty, bytes: res.body.length };
    };
    const delays = [0, 800, 2000, 4000];
    let probe = null;
    for (const d of delays) {
      if (d) await sleep(d);
      try { probe = await probeTile(); } catch (e) { probe = { ok: false, error: e.message }; continue; }
      if (probe.ok) break;
    }
    result.probe = probe && probe.ok ? probe : (probe || { ok: false, note: 'probe failed' });
    result.ok = !!result.latestTime;
    if (!probe || !probe.ok) result.note = probe?.error || probe?.note || 'GIBS tile probe unavailable';
  } catch (e) {
    result.error = e.message;
  }
  return result;
}

// Live gauge nowcast: uses GloFAS daily discharge vs its own 90-day baseline to
// build an honest "rising / high / surge" nowcast at the monitored points. This is
// a coarse surrogate — real DHM gauge millimetre readings would be far better but
// no verified free JSON API is available, so we never fabricate a gauge number.
export async function fetchGaugeNowcast(stateForecastRivers, stateUpstream) {
  const stations = [];
  const bandRank = { WATCH: 0, ADVISORY: 1, WARNING: 2, ALERT: 3 };
  let maxLevel = 0;

  const push = (id, name, district, baseline, current, feed) => {
    const ratio = baseline && current ? current / baseline : 0;
    let level = 'normal';
    if (ratio >= 1.3) level = 'danger';
    else if (ratio >= 1.15) level = 'warning';
    else if (ratio >= 1.03) level = 'rising';
    maxLevel = Math.max(maxLevel, { normal: 0, rising: 1, warning: 2, danger: 3 }[level]);
    stations.push({
      id, name, district, value: current != null ? Math.round(current) : null, unit: 'm3/s',
      level, baselineM3s: baseline ? Math.round(baseline) : null,
      source: 'GloFAS reanalysis (gauge surrogate — no live DHM API)',
      feeds: feed,
    });
  };

  for (const r of stateForecastRivers || []) {
    if (r.currentDischargeM3s != null && r.baselineM3s != null) {
      push(r.id, r.name + ' (forecast proxy)', r.district, r.baselineM3s, r.currentDischargeM3s, 'Nepal-side river');
    }
  }
  for (const u of stateUpstream || []) {
    if (u.currentDischargeM3s != null && u.baselineM3s != null) {
      push(u.id, u.name + ' upstream', 'Tibet-CHN', u.baselineM3s, u.currentDischargeM3s, u.feeds);
    }
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
    source: 'GloFAS reanalysis (per-river nowcast, honest gauge surrogate)',
    status: 'nowcast',
  };
}

export async function fetchSatellite(gaugeCtx = { forecastRivers: [], upstreamItems: [] }) {
  const _gibs = await Promise.allSettled([checkGibs()]);
  const gibs = _gibs[0].status === 'fulfilled' ? _gibs[0].value : { id: 'gibs', error: _gibs[0].reason?.message };

  const checks = await Promise.allSettled(Object.values(SOURCES).map((s) => checkSource(s)));
  const sources = checks.map((c) => (c.status === 'fulfilled' ? c.value : { ok: false, error: c.reason?.message }));
  const primary = sources.find((s) => s.ok);

  // Browser overlay config — WS: WMS for GFM, tiles for GIBS.
  let overlay = null;
  if (primary) {
    overlay = {
      kind: 'wms',
      sourceId: primary.id,
      wmsUrl: primary.wmsUrl,
      layers: primary.layers,
      latestTime: primary.latestTime,
      openLayers: ['floodExtent'],
    };
  }
  if (gibs.ok) {
    overlay = {
      kind: 'gibs-tiles',
      sourceId: 'gibs',
      layer: gibs.layer,
      latestTime: gibs.latestTime,
      tmsTemplate: gibs.tmsTemplate,
      gridWidth: GIBS_GRID_WIDTH,
      provider: GIBS.provider,
    };
  }

  const probe = primary?.probe || gibs?.probe;
  let status = 'unavailable';
  let statusText = 'Satellite service unavailable';
  if (gibs.ok) {
    status = 'connected';
    statusText = 'NASA LANCE flood overlay live — latest ' + gibs.latestTime + '. Shows cloud-cleared flood plumes; a ' +
      'clear overpass of the Bhotekoshi/Sapta Koshi after heavy rain is your flash-flood confirmation.';
  } else if (primary) {
    status = 'connected';
    statusText = 'Copernicus GFM (Sentinel-1 SAR) overlay available; ~6-day revisit may miss a flash event.';
  }

  const result = {
    updatedAt: new Date().toISOString(),
    source: 'NASA LANCE (MODIS/VIIRS via GIBS) + Copernicus GFM (Sentinel-1 SAR)',
    status,
    statusText,
    activeSource: overlay ? overlay.sourceId : null,
    latestTime: overlay ? overlay.latestTime : null,
    probe,
    overlay,
    gibs,
    sources,
  };
  return result;
}
