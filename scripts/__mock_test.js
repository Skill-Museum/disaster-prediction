// Offline smoke test — mocks global.fetch with realistic USGS / Open-Meteo
// response shapes and runs fetchAll() + evaluateAlerts() end-to-end.
// Run: node scripts/__mock_test.js
// (This file is NOT used by the server — it's just for local verification.)

function daysArray(n, startOffset) {
  const out = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base.getTime() + (startOffset + i) * 86400000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

globalThis.fetch = async (url) => {
  if (url.includes('earthquake.usgs.gov')) {
    return {
      ok: true,
      json: async () => ({
        features: [
          {
            id: 'us1000abcd',
            properties: { mag: 5.2, place: '55 km NW of Kodari, Nepal', time: Date.now() - 3600_000, url: 'https://example.com' },
            geometry: { coordinates: [85.9, 28.1, 10] },
          },
        ],
      }),
    };
  }
  if (url.includes('flood-api.open-meteo.com')) {
    // simulate a river with a rising forecast (surge scenario like Bhote Koshi)
    const pastDays = 90, futureDays = 7;
    const past = Array.from({ length: pastDays }, () => 150 + Math.random() * 40);
    const future = [180, 220, 260, 310, 340, 300, 270]; // rising then easing — ALERT-worthy
    return {
      ok: true,
      json: async () => ({
        daily: {
          time: [...daysArray(pastDays, -pastDays), ...daysArray(futureDays, 0)],
          river_discharge: [...past, ...future],
        },
      }),
    };
  }
  if (url.includes('api.open-meteo.com')) {
    return {
      ok: true,
      json: async () => ({
        daily: { precipitation_sum: [20, 18, 25, 30, 22, 15, 10] },
      }),
    };
  }
  throw new Error('Unmocked URL: ' + url);
};

const { fetchAll } = await import('./fetch-data.js');
const { evaluateAlerts } = await import('./alerts.js');

const state = await fetchAll();
console.log('--- fetchAll() result summary ---');
console.log('earthquakes:', state.earthquake.quakes.length);
console.log('national risk:', state.risk.national);
console.log('top river scores:', state.risk.scores.slice(0, 3));
console.log('upstream bands:', state.upstream.items.map(i => `${i.name}: ${i.band}`));
console.log('forecast bands:', state.forecast.rivers.map(r => `${r.name}: ${r.band}`));

console.log('\n--- evaluateAlerts() cycle 1 ---');
const cycle1 = evaluateAlerts(state);
for (const a of cycle1.alerts) console.log(' *', a.severity.toUpperCase(), '-', a.message);

console.log('\n--- evaluateAlerts() cycle 2 (same state, should NOT repeat) ---');
const cycle2 = evaluateAlerts(state);
console.log('alerts fired on repeat cycle:', cycle2.alerts.length, '(expect 0)');

if (cycle1.alerts.length > 0 && cycle2.alerts.length === 0) {
  console.log('\n✅ Smoke test passed: alerts fire on escalation and de-duplicate on repeat.');
} else {
  console.log('\n❌ Smoke test FAILED — check dedup logic.');
  process.exit(1);
}
