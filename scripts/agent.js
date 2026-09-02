// scripts/agent.js
//
// Intelligent auto-research agent. When the live monitor detects something
// suspicious (flood escalation, upstream/Tibet surge, GLOF-adjacent quake,
// gauge in danger, extreme risk), the agent automatically searches the web for
// confirmation and returns the freshest headline + snippet + link as a
// notification. It never searches on the same event twice, so the free search
// endpoints are not hammered.
//
// Search backend: DuckDuckGo HTML (keyless, HTTP 200 verified) with a light
// result-title/snippet/URL parser.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCH_TIMEOUT_MS = 15000;

function dedupe(a, b) {
  return [...a].filter((x) => !b.has(x));
}

// Keyword -> search terms for a trigger "kind".
const QUERY_TEMPLATES = {
  flood: (name) => `${name} flood Nepal today`,
  upstream: (name, feeds) => `${name} river surge water level ${feeds || 'Nepal'}`,
  glof: (name, district) => `${name} ${district} glacial lake outburst flood GLOF`,
  gauge: (name) => `${name} river danger water level Nepal`,
  rain: (name, district) => `${name} ${district} heavy rain flooding Nepal`,
  landslide: (place, district) => `${place} ${district} landslide Nepal`,
  road: (title) => `${title} road blocked landslide Nepal`,
};

// ---- Web search (DuckDuckGo HTML) ----
async function webSearch(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), SEARCH_TIMEOUT_MS);
      const res = await fetch(url, {
        signal: c.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (NepalEarlyWarning/1.0; disaster agent)', 'Accept': 'text/html' },
      });
      clearTimeout(t);
      if (res.status !== 200) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const results = parseDuckHtml(html);
      if (results.length) return results;
      if (attempt < 3) await sleep(1400 * attempt);
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1400 * attempt);
    }
  }
  throw lastErr || new Error('search failed');
}

function parseDuckHtml(html) {
  const out = [];
  // DuckDuckGo HTML results. Each <a class="result__a" href="//duckduckgo.com/l/?uddg=REALURL&rut=...">Title</a>
  // is a redirect wrapper; the real destination is the url-encoded `uddg=` param.
  const anchors = [...html.matchAll(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippets = [...html.matchAll(/<a[^>]+class="result__snippet"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const snippetMap = new Map(snippets.map((s) => [s[1], s[2]]));
  for (const a of anchors) {
    let raw = a[1];
    let url = raw;
    // Resolve duckduckgo l/ redirect wrapper to the real target
    const uddg = /[?&]uddg=([^&]+)/.exec(raw);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(url)) continue;
    if (/duckduckgo\.com\/(?!l\/)/.test(url)) continue; // allow only the l/ redirector path
    const title = strip(a[2]);
    if (!title) continue;
    const snip = strip(snippetMap.get(raw) || '');
    out.push({ title, url, snippet: snip, time: null });
    if (out.length >= 5) break;
  }
  // Fallback: if the wrapper parsing found nothing, scan for raw external links near result titles.
  if (!out.length) {
    const m = /<a[^>]+class="result__a"[^>]*href="((?!\/\/duckduckgo\.com\/l\/)[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    for (const a of [...html.matchAll(m)]) {
      let url = a[1];
      if (url.startsWith('//')) url = 'https:' + url;
      if (!/^https?:\/\//.test(url) || /duckduckgo/.test(url)) continue;
      const title = strip(a[2]);
      if (!title) continue;
      out.push({ title, url, snippet: '', time: null });
      if (out.length >= 5) break;
    }
  }
  return out;
}

function strip(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// ---- Trigger → topics ----
function buildTopic(kind, item) {
  if (kind === 'upstream') return { q: QUERY_TEMPLATES.upstream(item.name, item.feeds), label: item.name };
  if (kind === 'glof') return { q: QUERY_TEMPLATES.glof(item.name || 'Nepal', item.district || 'Himalayan'), label: item.name || 'headwater' };
  if (kind === 'gauge') return { q: QUERY_TEMPLATES.gauge(item.name), label: item.name };
  if (kind === 'rain') return { q: QUERY_TEMPLATES.rain(item.name, item.district), label: item.name };
  if (kind === 'landslide') return { q: QUERY_TEMPLATES.landslide(item.name, item.district), label: item.name };
  if (kind === 'road') return { q: QUERY_TEMPLATES.road(item.title), label: item.title };
  return { q: QUERY_TEMPLATES.flood(item.name || 'Nepal'), label: item.name || 'Nepal' };
}

// ---- The agent: detect + research ----
export async function runAgent(state, { fire = true } = {}) {
  const suspicious = detectSuspicious(state);
  const findings = [];
  if (!fire) return { suspicious, findings };

  for (const s of suspicious) {
    const topic = buildTopic(s.kind, s.item);
    try {
      const results = await webSearch(topic.q);
      const top = results[0];
      findings.push({
        agentFind: true,
        at: new Date().toISOString(),
        kind: s.kind,
        topic: s.topic,
        query: topic.q,
        label: topic.label,
        reason: s.reason,
        headline: top?.title || null,
        snippet: top?.snippet || null,
        sourceUrl: top?.url || null,
        status: 'agent',
      });
    } catch (e) {
      findings.push({ agentFind: true, at: new Date().toISOString(), kind: s.kind, topic: s.topic, reason: s.reason, headline: null, error: e.message, status: 'agent-error' });
    }
  }
  return { suspicious, findings };
}

// Dedup memory of topic keys already researched this session.
const researched = new Set();

function detectSuspicious(state) {
  const out = [];
  const esc = new Set();

  if (!state) return out;

  // 1) Upstream / transboundary Tiber surge (the earliest signal)
  for (const u of state.upstream?.items || []) {
    if (u.band === 'ALERT' && u.currentDischargeM3s != null && u.currentDischargeM3s > u.baselineM3s * 1.2) {
      const key = `up-${u.id}`;
      if (!researched.has(key)) { researched.add(key); out.push({ kind: 'upstream', topic: `Transboundary ${u.name} at ALERT`, item: u, reason: `${u.name} upstream ALERT — surge travelling toward Nepal in ~${u.leadTimeHours?.[0]}-${u.leadTimeHours?.[1]}h` }); }
    }
  }

  // 2) GLOF / quake-adjacent flood risk
  if (state.earthquake?.quakes) {
    for (const q of state.earthquake.quakes) {
      if (q.mag >= 5.5) {
        const key = `glof-${q.id}`;
        if (!researched.has(key)) { researched.add(key); out.push({ kind: 'glof', topic: `M${q.mag} quake near Himalayan headwaters`, item: { name: q.place, district: 'Himalaya' }, reason: `M${q.mag} quake may destabilize glacial lakes / trigger GLOF` }); }
      }
    }
  }

  // 3) Nepal rivers at ALERT (flood forecast)
  for (const r of state.forecast?.rivers || []) {
    if (r.band === 'ALERT') {
      const key = `riv-${r.id}`;
      if (!researched.has(key)) { researched.add(key); out.push({ kind: 'flood', topic: `${r.name} river at flood ALERT`, item: r, reason: `${r.name} (${r.district}) forecast at flood ALERT` }); }
    }
  }

  // 4) Gauges in danger (or live warning from official BIPAD/DHM feed)
  for (const g of state.flood?.stations || []) {
    if (g.level === 'danger' || g.level === 'warning') {
      const key = `gg-${g.id}-${g.level}`;
      if (!researched.has(key)) {
        researched.add(key);
        out.push({
          kind: 'gauge',
          topic: `${g.name} at ${g.level.toUpperCase()} (DHM)`,
          item: { name: g.name, district: g.basin || 'Nepal', source: g.source },
          reason: `${g.name} live water level ${g.level.toUpperCase()} (${g.value != null ? g.value.toFixed(2) + ' m' : '? '}) — official DHM gauge`,
        });
      }
    }
  }

  // 4b) Official BIPAD water alerts (flood / heavy rain warnings issued by DHM)
  for (const a of state.bipad?.alerts?.alerts || []) {
    if (!a.isWater) continue;
    const key = `ba-${a.id}`;
    if (!researched.has(key)) {
      researched.add(key);
      out.push({ kind: 'flood', topic: `Official BIPAD alert: ${a.title}`, item: { name: a.title || 'Nepal', district: 'Nepal' }, reason: `Official BIPAD/DHM ${a.referenceType || 'water'} alert issued` });
    }
  }

  // 4c) Live DHM rain — heavy precipitation right now at an official station
  for (const s of state.bipad?.rain?.stations || []) {
    if (s.live && (s.hourlyMm || 0) >= 10) {
      const key = `br-${s.id}`;
      if (!researched.has(key)) {
        researched.add(key);
        out.push({ kind: 'rain', topic: `Heavy rain at ${s.name}`, item: { name: s.name, district: s.basin || 'Nepal' }, reason: `Live DHM rain ${s.hourlyMm} mm/hr at ${s.name}` });
      }
    }
  }

  // 5) Extreme national risk
  if (state.risk?.national?.band === 'EXTREME') {
    const key = 'risk-EXTREME';
    if (!researched.has(key)) { researched.add(key); out.push({ kind: 'flood', topic: 'National flood risk EXTREME', item: { name: 'Nepal' }, reason: 'National risk score at EXTREME' }); }
  }

  // 6) Landslide incidents (official BIPAD) — last 30 days
  const nowI = Date.now();
  for (const inc of state.bipad?.incidents?.incidents || []) {
    if (!inc.isLandslide) continue;
    const ts = inc.incidentOn ? Date.parse(inc.incidentOn) : null;
    if (!ts || nowI - ts > 30 * 24 * 3600 * 1000) continue;
    const key = `bi-${inc.id}`;
    if (!researched.has(key)) {
      researched.add(key);
      out.push({ kind: 'landslide', topic: `Landslide: ${inc.title}`, item: { name: inc.title || 'Nepal', district: inc.district || 'Nepal' }, reason: `Official BIPAD landslide incident (${inc.incidentOn ? inc.incidentOn.slice(0, 10) : 'recent'})` });
    }
  }

  // 7) Active road closures (landslide / heavy rain)
  for (const r of state.bipad?.highways?.roads || []) {
    if (r.dateRoadblockEnd) continue;
    if (!r.isClosed && !r.isPartial) continue;
    const key = `bih-${r.id}`;
    if (!researched.has(key)) {
      researched.add(key);
      out.push({ kind: 'road', topic: `Road ${r.isClosed ? 'blocked' : 'partial'}: ${r.title}`, item: { title: r.title, district: r.district || 'Nepal' }, reason: `BIPAD road ${r.isClosed ? 'closure' : 'partial'} (${r.closureReason || r.status}) since ${r.dateRoadblockStart ? r.dateRoadblockStart.slice(0, 10) : 'recent'}` });
    }
  }

  // Cap the number of searches per cycle so we never spam the endpoint.
  return out.slice(0, 3);
}

export { webSearch, dedupe };
