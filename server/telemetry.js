const MAX_ENTRIES = 2000;
const MAX_TRACK_SAMPLES = 240;
const SAMPLE_DEBOUNCE_MS = 20000;
const entries = [];
const tracks = new Map();
const summary = {
  decisions: 0,
  marketRejected: 0,
  candidates: 0,
  riskRejected: 0,
  stageCounts: { STABLE: 0, EARLY: 0, GROWING: 0, RUNNING: 0, PULLBACK: 0 },
  rejectionReasons: {},
  conditionFailures: { EARLY: {}, GROWING: {}, RUNNING: {}, PULLBACK: {} },
  detected: 0,
  survived15m: 0,
  survived30m: 0,
  survived60m: 0,
  failed: 0,
  weakening: 0
};

const inc = (map, key) => { map[key] = (map[key] || 0) + 1; };
const num = value => Number(value || 0);
const finite = value => Number.isFinite(Number(value));

function compactSignals(signals) {
  if (!signals) return null;
  const compact = {};
  for (const [stage, data] of Object.entries(signals)) {
    if (!data || typeof data !== 'object') continue;
    compact[stage] = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) compact[stage][key] = value.pass !== undefined ? Boolean(value.pass) : value;
      else compact[stage][key] = value;
    }
  }
  return compact;
}

function failureKeys(stageSignals, stage) {
  const data = stageSignals?.[stage];
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).filter(([key, value]) => key !== 'pass' && value === false).map(([key]) => key);
}

function accelerationFor(previous, current) {
  if (!previous) return { score: 50, label: 'BASELINE', volumeDeltaPct: null, mcDeltaPct: null, tradeDeltaPct: null, pressureDelta: null };
  const volumeDeltaPct = previous.volume1h > 0 ? (current.volume1h - previous.volume1h) / previous.volume1h * 100 : null;
  const mcDeltaPct = previous.marketCap > 0 ? (current.marketCap - previous.marketCap) / previous.marketCap * 100 : null;
  const tradeDeltaPct = previous.trades > 0 ? (current.trades - previous.trades) / previous.trades * 100 : null;
  const pressureDelta = current.pressure - previous.pressure;
  const score = Math.max(0, Math.min(100, Math.round(50 +
    (volumeDeltaPct == null ? 0 : Math.max(-50, Math.min(100, volumeDeltaPct)) * 0.45) +
    (mcDeltaPct == null ? 0 : Math.max(-30, Math.min(60, mcDeltaPct)) * 0.25) +
    (tradeDeltaPct == null ? 0 : Math.max(-50, Math.min(100, tradeDeltaPct)) * 0.20) +
    Math.max(-20, Math.min(20, pressureDelta)) * 0.50)));
  return {
    score,
    label: score >= 70 ? 'ACCELERATING' : score <= 35 ? 'WEAKENING' : 'STEADY',
    volumeDeltaPct,
    mcDeltaPct,
    tradeDeltaPct,
    pressureDelta
  };
}

function survivalQuality(sample, baseline) {
  if (!sample || !baseline) return false;
  const baselineMc = num(baseline.marketCap);
  const floorMc = baselineMc >= 300000 ? 300000 : baselineMc >= 250000 ? 250000 : baselineMc >= 100000 ? 100000 : 50000;
  return num(sample.marketCap) >= floorMc &&
    num(sample.liquidity) >= 5000 &&
    num(sample.buys) > 0 && num(sample.sells) > 0 &&
    num(sample.volume1h) >= 100 &&
    num(sample.pressure) >= 52 &&
    num(sample.change5m) > -20 &&
    num(sample.change15m) > -15 &&
    num(sample.change30m) > -15 &&
    num(sample.risk) < 20 &&
    String(sample.riskLevel) === 'CLEAR';
}

function evaluateSurvival(track, now) {
  const baseline = track.samples[0];
  if (!baseline) return;
  for (const [label, windowMs] of [['15m', 15 * 60000], ['30m', 30 * 60000], ['60m', 60 * 60000]]) {
    if (track.reported[label] || now - baseline.ts < windowMs) continue;
    const target = track.samples.filter(x => x.ts >= baseline.ts + windowMs - 90000 && x.ts <= baseline.ts + windowMs + 90000).at(-1) || track.samples.at(-1);
    const ok = survivalQuality(target, baseline);
    track.reported[label] = ok ? 'PASS' : 'FAIL';
    if (ok) summary[label === '15m' ? 'survived15m' : label === '30m' ? 'survived30m' : 'survived60m']++;
    else summary.failed++;
  }
}

function trackSample(input, stageInfo) {
  const address = String(input.address || '').toLowerCase();
  if (!address) return null;
  const now = Date.now();
  let track = tracks.get(address);
  if (!track) {
    track = { address, symbol: input.symbol || '?', firstSeen: now, samples: [], reported: {}, acceleration: null, lastRecorded: 0 };
    tracks.set(address, track);
    summary.detected++;
  }
  if (now - track.lastRecorded < SAMPLE_DEBOUNCE_MS) return track;
  const current = {
    ts: now,
    symbol: input.symbol || track.symbol,
    stage: stageInfo.stage,
    marketCap: num(input.marketCap),
    liquidity: num(input.liquidity),
    volume1h: num(input.volume1h),
    buys: num(input.buys),
    sells: num(input.sells),
    trades: num(input.buys) + num(input.sells),
    pressure: num(input.pressure),
    change5m: num(input.change5m),
    change15m: num(input.change15m),
    change30m: num(input.change30m),
    score: num(input.score),
    risk: num(input.risk),
    riskLevel: input.riskLevel || 'PENDING'
  };
  const previous = track.samples.at(-1);
  track.acceleration = accelerationFor(previous, current);
  track.samples.push(current);
  if (track.samples.length > MAX_TRACK_SAMPLES) track.samples.shift();
  track.lastRecorded = now;
  track.symbol = current.symbol;
  evaluateSurvival(track, now);
  if (track.acceleration.label === 'WEAKENING') summary.weakening++;
  return track;
}

export function recordTelemetry(input) {
  const stage = input.stage || 'STABLE';
  const reasons = input.filterReasons || [];
  const riskRejected = input.outcome === 'RISK_REJECT';
  const stageSignals = input.stageSignals || null;

  summary.decisions++;
  if (input.outcome === 'MARKET_REJECT') {
    summary.marketRejected++;
    for (const reason of reasons) inc(summary.rejectionReasons, reason);
  } else {
    summary.candidates++;
    summary.stageCounts[stage] = (summary.stageCounts[stage] || 0) + 1;
    if (riskRejected) summary.riskRejected++;
  }
  for (const stageName of ['EARLY', 'GROWING', 'RUNNING', 'PULLBACK']) {
    for (const key of failureKeys(stageSignals, stageName)) inc(summary.conditionFailures[stageName], key);
  }

  const stageInfo = { stage, reason: input.stageReason || null };
  const track = trackSample(input, stageInfo);
  const item = {
    ts: Date.now(), cycle: input.cycle, outcome: input.outcome, token: input.token,
    symbol: input.symbol, name: input.name, address: input.address, score: input.score,
    stage, previousStage: input.previousStage || null, stageReason: input.stageReason || null,
    filterReasons: reasons, risk: input.risk ?? null, riskLevel: input.riskLevel || null,
    riskFlags: input.riskFlags || [], marketCap: input.marketCap, liquidity: input.liquidity,
    volume1h: input.volume1h, pressure: input.pressure, trades: (input.buys || 0) + (input.sells || 0),
    ageMs: input.ageMs ?? null,
    momentum: { m5: input.change5m, m15: input.change15m, m30: input.change30m, h1: input.change1h, h6: input.change6h },
    timeframes: {
      m5Trades: input.stageSignals?.inputs?.m5Trades ?? null,
      m15Trades: input.stageSignals?.inputs?.m15Trades ?? null,
      m30Trades: input.stageSignals?.inputs?.m30Trades ?? null,
      m15Pressure: input.stageSignals?.inputs?.m15Pressure ?? null,
      m30Pressure: input.stageSignals?.inputs?.m30Pressure ?? null
    },
    stageSignals: compactSignals(stageSignals),
    acceleration: track?.acceleration || null
  };
  entries.push(item);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  if (input.transition || input.outcome === 'RISK_REJECT') {
    console.log(`[telemetry] ${input.symbol || '?'} outcome=${input.outcome} stage=${stage} prev=${input.previousStage || '-'} score=${input.score ?? 0} reason=${input.stageReason || reasons.join(',') || '-'} risk=${input.riskLevel || '-'}`);
  }
  return track;
}

export function getTelemetryForToken(address) {
  const track = tracks.get(String(address || '').toLowerCase());
  if (!track) return null;
  const latest = track.samples.at(-1) || null;
  return {
    firstSeen: track.firstSeen,
    ageMinutes: Math.round((Date.now() - track.firstSeen) / 60000),
    samples: track.samples.length,
    acceleration: track.acceleration,
    survival: { ...track.reported },
    latest
  };
}

export function telemetrySnapshot(token = '') {
  const needle = String(token || '').trim().toLowerCase();
  const filtered = needle ? entries.filter(x => String(x.token || '').toLowerCase() === needle || String(x.address || '').toLowerCase() === needle || String(x.symbol || '').toLowerCase() === needle) : entries;
  const tracked = [...tracks.values()].map(track => ({
    address: track.address,
    symbol: track.symbol,
    firstSeen: track.firstSeen,
    ageMinutes: Math.round((Date.now() - track.firstSeen) / 60000),
    samples: track.samples.length,
    acceleration: track.acceleration,
    survival: { ...track.reported },
    latest: track.samples.at(-1) || null
  })).sort((a, b) => (b.acceleration?.score || 0) - (a.acceleration?.score || 0));
  return {
    at: new Date().toISOString(),
    buffer: filtered.length,
    maxBuffer: MAX_ENTRIES,
    trackedTokens: tracks.size,
    summary: { ...summary, stageCounts: { ...summary.stageCounts }, rejectionReasons: { ...summary.rejectionReasons }, conditionFailures: Object.fromEntries(Object.entries(summary.conditionFailures).map(([k, v]) => [k, { ...v }])) },
    acceleration: {
      accelerating: tracked.filter(x => x.acceleration?.label === 'ACCELERATING').length,
      weakening: tracked.filter(x => x.acceleration?.label === 'WEAKENING').length,
      steady: tracked.filter(x => x.acceleration?.label === 'STEADY').length
    },
    topAccelerating: tracked.filter(x => x.acceleration?.label === 'ACCELERATING').slice(0, 20),
    tracked: tracked.slice(0, 100),
    decisions: filtered.slice(-500).reverse()
  };
}
