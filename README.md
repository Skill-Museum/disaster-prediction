# Nepal Early-Warning System

A **live, predictive flood + earthquake early-warning dashboard** for Nepal.

The core idea: *show an incoming disaster **before** it becomes a news headline.*
Floods in Nepal have many drivers — monsoon rain, transboundary surges from
Tibet, glacial-lake / landslide-dam (GLOF) bursts, upstream river flow, snowmelt,
and soil saturation. This system watches **live government data + forecasts** for
**all of them at once**, flags the rivers that need attention, tries to guess
what's coming in the next days — and then **auto-searches the internet** to
confirm suspicious signals with real news.

Built to catch events like the **Aug 2026 Bhote Koshi (Mailung) / Rasuwa GLOF
flood** — a flash surge that ordinary daily river models miss because it travels
in hours, not days.

---

## What it tracks (all live)

| Signal | Source | What it gives you |
|---|---|---|
| **Official river levels** | **BIPAD / DHM** `river-stations` | Live DHM water level (m) vs warning/danger at ~190 real gauges, with trend (rising/falling) |
| **Official rainfall** | **BIPAD / DHM** `rain-stations` | Live mm/hr at ~50 telemetered rain gauges (1/3/6/12/24h totals) |
| **Official alerts** | **BIPAD** `alert` | DHM flood/heavy-rain warnings issued by the government |
| **Disaster incidents** | **BIPAD** `incident` | Landslide / fire / flood incident records |
| **Road closures** | **BIPAD** `highway` | Which highways are blocked / partial, cause (landslide, GLOF, heavy rain) + GPS point |
| **Disaster impact** | **BIPAD** `loss` | Deaths, missing, injured, affected, roads/bridges destroyed, economic loss |
| Earthquakes | USGS FDSN API | Recent M≥3.5 quakes; a shallow quake near a glacial headwater drives a **GLOF/watch** alert |
| River discharge forecasts | Open-Meteo Flood (GloFAS) | **The prediction engine** — discharge forecast days ahead vs a 90-day baseline, per river |
| Rainfall forecast | Open-Meteo Weather | 7-day + 14-day rainfall totals feeding the risk score |
| **Live rain nowcast map** | Open-Meteo precipitation | Warm-colour overlay showing **where it is raining right now** across Nepal |
| Transboundary upstream (Tibet) | Same GloFAS mechanism at upstream points | The **earliest-warning layer** — catches a Tibet-side surge (Bhote Koshi/Poiqu, Arun/Pumqu) before it reaches Nepal, with a **lead-time estimate** |
| Satellite flood extent | NASA GIBS / LANCE `MODIS_Combined_Flood_2-Day` | Where flooding is detected from space, auto-refreshed every 2 min over real satellite imagery |

All free and **keyless** — no API keys to configure.

Every signal is multi-driver aware. Each river gets a `drivers` list explaining
*why* it's elevated (rain / GLOF burst / upstream surge / high river flow / melt).

---

## How the prediction works

1. **Fetch live + forecast data** on every cycle (`scripts/fetch-data.js`):
   - **BIPAD/DHM official data** first — real river gauges, rain gauges, alerts,
     incidents, highway closures, and loss totals (`scripts/bipad.js`).
   - Earthquakes (needed to flag GLOF risk against glacial headwaters).
   - River forecasts + upstream transboundary points (with travel-time lead notes).
   - Satellite flood extent + live rain nowcast grid.
2. **Build a risk score** per river → national band (MINIMAL → EXTREME), weighted
   across forecast severity, upstream surge, rainfall, and live DHM gauge levels.
3. **Fire alerts** only on **new conditions or escalations** (`scripts/alerts.js`
   + `buildBipadAlerts` + `buildIncidentAlerts` in `server.js`): BIPAD water
   alerts, live DHM gauges at WARNING/DANGER, road blockages, landslide
   incidents, transboundary ADVISORY+, river WARNING+, national HIGH/EXTREME,
   and shallow earthquakes near glacial headwater zones (GLOF/cascade watch).
4. **Auto-research agent** (`scripts/agent.js`): when live data flags a
   suspicious trigger (an ALERT river, a GLOF quake, a transboundary surge, a
   landslide, a road blockage), the agent **searches the web (DuckDuckGo)**,
   pulls the freshest real headline, and pushes it as a "🛰️ AGENT FOUND" alert
   with a source link — so the model's prediction is cross-checked against real
   reporting.
5. **Push to the browser live** over WebSocket (2-min refresh), and expose
   everything over REST for polling.

---

## Run it

```bash
npm install
npm start
# open http://localhost:3000   (or http://localhost:3001 if PORT=3001)
```

Refreshes every 2 minutes (`REFRESH_MS` in `server.js`, env-overridable). The
dashboard updates live over WebSocket and falls back to REST: `/api/status`,
`/api/bipad`, `/api/forecast`, `/api/upstream`, `/api/rain`, `/api/risk`,
`/api/earthquake`, `/api/satellite`, `/api/alerts`, `/api/agent`.

Environment variables (all optional):
- `PORT` — listen port (default `3000`; hosts usually inject this). e.g.
  `$env:PORT="3001"; npm start` (PowerShell) or `PORT=3001 npm start` (bash).
- `DISABLE_AGENT=1` — skip the web-search agent (for restricted-egress hosts).
- `REFRESH_MS=120000` — live-data refresh interval in ms (default 2 min).

---

## Deploy / Host anywhere

Because it's **one Node process, no build, no database, no API keys**, it runs on
any host that can run Node and make outbound HTTPS requests to the live data
APIs (BIPAD, Open-Meteo, USGS, NASA GIBS).

> The app is a **persistent server** (WebSocket + a 2-minute refresh loop), so
> choose a host that keeps the process running — a VPS or a small Node platform;
> not a serverless/idle-spinning function.

### Option A — Linux VPS (recommended, full control)
```bash
# on the box
git clone <your-repo> nepal-monitor && cd nepal-monitor
npm install --omit=dev

# run under PM2 (ecosystem file included) so it auto-restarts
npm i -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # keep it running across reboots

# optional: reverse-proxy with nginx to 80/443 + a domain
```
All logs go to `./logs/` (created by PM2; the `logs/` dir is git-ignored).

### Option B — Node PaaS (Render / Railway / Fly.io)
- Set the start command to **`node server.js`** (and `npm install` build step).
- Set the env var **`PORT`** to the platform's injected port (Render injects it
  automatically; the app reads `process.env.PORT`).
- Wi‑Fi/sleep caveats: Render's **free** tier spins the service down between
  requests, which pauses the live WebSocket feed — a small always-on (paid)
  instance is recommended so the 2-min feed stays live.
- Hosts on restricted networks: set `DISABLE_AGENT=1` to disable web searches.

### Option C — Any machine / tunnel
`npm start` on any always-on machine behind Cloudflare Tunnel or ngrok — the
WebSocket URL is derived from `location.host`, so it works tunneled as-is.

### Notes for any host
- **Port**: `PORT` (default 3000). Expose it (or proxy 80/443 → it).
- **Outbound access**: the box must reach `bipadportal.gov.np` (HTTP), the
  Open-Meteo / USGS / NASA endpoints (HTTPS), and — unless `DISABLE_AGENT=1` —
  DuckDuckGo for the auto-research agent.
- **Resources**: it's lightweight (single process). The heaviest work is the
  2-min parallel fetch across all sources. 256–512 MB RAM is plenty.
- Optional `ecosystem.config.cjs`, `.env.example` and `.gitignore` are included.

---

## Folder structure (backend / frontend)

```
nepal-monitor/
├── server.js                    ← BACKEND. Express + WebSocket server, 2-min
│                                  refresh loop, REST API, alert assembly,
│                                  BIPAD incident/road alert builder.
├── package.json                 ← deps (express, ws); npm start / fetch-data
├── ecosystem.config.cjs         ← PM2 process config (deployment)
├── .env.example                 ← optional env vars (PORT / DISABLE_AGENT / REFRESH_MS)
├── .gitignore                   ← ignores node_modules, logs, .env, zips
├── scripts/                     ← BACKEND data layers (ES modules)
│   ├── bipad.js                 ← Official BIPAD/DHM: rain, river, alerts,
│   │                               earthquakes, incidents, highways, loss
│   ├── fetch-data.js            ← Orchestrates every live fetch + risk model
│   ├── agent.js                 ← Auto-research agent (DuckDuckGo web search)
│   ├── alerts.js                ← Alert generation / de-dup / escalation
│   └── satellite.js             ← NASA GIBS flood tiles + gauge nowcast
└── public/                      ← FRONTEND (static, served by Express)
    ├── index.html               ← The whole dashboard: map, charts, panels,
    │                               i18n (EN/नेपाली), renderers
    └── borders.js               ← window.BORDERS (Nepal / India / China paths)
```

- **Frontend** = `public/` (one-page app). Served statically by `server.js`.
- **Backend** = `server.js` + `scripts/`. Runs the refresh loop and the WebSocket/REST API.
- No build step, no bundler. `public/index.html` loads Leaflet (map) from CDN and
  `borders.js` locally.

---

## The dashboard (frontend)

- **Live satellite map** — EPSG:3857, Esri World Imagery + NASA flood-extent
  overlay (auto-refresh 2 min), with:
  - **DHM river gauges** at their real GPS coords — coloured by margin-to-warning
    (red=danger, orange=warning, pulsing when close), with live metres in the tooltip.
  - **DHM rain gauges** (blue dots where it's raining now).
  - **Road closures** (red ring = blocked, orange = partial, pulsing).
  - **Landslide locations** (brown dots) from BIPAD highway events.
  - **BIPAD alerts**, upstream surge points, river risk markers, earthquake markers.
- **Official BIPAD panel** — tabs for River levels (margin-to-warning bars),
  Rainfall (DHM bars, warm intensity), Official alerts, **Incidents/landslides**,
  **Road closures**, and **Impact** (loss totals).
- **Stat strip, river forecast tabs (live canvas chart), risk list, upstream
  (with lead time), gauges, recent quakes, alert log.**
- **English ↔ नेपाली** toggle; toast pop-ups for new alerts.

---

## The BIPAD integration (official government live data)

Feeds in `scripts/bipad.js`, all from the public BIPAD Portal REST API
(`https://bipadportal.gov.np/api/v1/`, no key):

- `rain-stations` → live DHM rainfall (filtered to a 72h freshness window).
- `river-stations` → live DHM water level vs warning/danger. Only *escalation*
  status strings are treated as warnings (e.g. "ABOVE WARNING LEVEL"), so
  "BELOW WARNING LEVEL" never false-fires.
- `alert` → official DHM flood/heavy-rain warnings.
- `earthquake` → BIPAD seismic cross-check.
- `incident` → disaster incidents (landslide/fire/flood).
- `highway` → road closures; `closureReason` Landslide/GLOF produces the
  **landslide layer** with GPS points.
- `loss` → aggregated impact totals.

Readings older than the freshness window are dropped so stale rows never look
live. The whole block is served at `/api/bipad`.

---

## Honest limitations

- **GloFAS is a daily-mean model** — it smooths GLOF flash surges (headwater
  values are small). The meaningful signal is the **ratio vs baseline** (severity
  band), which is what the system scores.
- **BIPAD incident records are sparse** — the incident feed is mostly fire
  records; the strongest live "where is it happening" signal for landslides /
  road blockages comes from the **highway** endpoint, which is why the dashboard
  surfaces landslide events from road closures.
- **Agent search** depends on DuckDuckGo's free HTML page; it's best-effort and
  can occasionally return no snippet (the alert still fires with the reason).

## Data notes

The live layers come from official open sources (BIPAD/DHM river, rainfall,
alerts, incidents, highway closures, loss) plus open forecast/remote-sensing
feeds (USGS earthquakes, NASA flood extent, Open-Meteo/GloFAS river & rain).
GloFAS ensemble forecasts carry real uncertainty — treat WARNING/ALERT bands as
"worth watching closely," not certainty. Forecast bands are derived from the
ratio to that river's own recent baseline, so they indicate elevation relative
to normal, not an absolute flood magnitude.
