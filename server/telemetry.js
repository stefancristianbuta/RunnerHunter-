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
  stageCounts: { STABLE: 0, WATCH: 0, EARLY: 0, GROWING: 0, RUNNING: 0, PULLBACK: 0 },
  rejectionReasons: {},
  conditionFailures: { WATCH: {}, EARLY: {}, GROWING: {}, RUNNING: {}, PULLBACK: {} },
  detected: 0,
  survived15m: 0,
  survived30m: 0,
  survived60m: 0,
  failed: 0,
  weakening: 0
};

const inc = (map, key) => { map[key] = (map[key] || 0) + 1; };
const num = value => Number(value || 0);
const pct = (a, b) => b > 0 ? (a - b) / b * 100 : null;
const SIGNAL_STAGES = new Set(['WATCH', 'EARLY', 'GROWING', 'RUNNING', 'PULLBACK']);

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
  return { score, label: score >= 70 ? 'ACCELERATING' : score <= 35 ? 'WEAKENING' : 'STEADY', volumeDeltaPct, mcDeltaPct, tradeDeltaPct, pressureDelta };
}

function survivalQuality(sample, baseline) {
  if (!sample || !baseline) return false;
  const baselineMc = num(baseline.marketCap);
  const floorMc = baselineMc >= 300000 ? 300000 : baselineMc >= 250000 ? 250000 : baselineMc >= 100000 ? 100000 : 50000;
  return num(sample.marketCap) >= floorMc && num(sample.liquidity) >= 5000 && num(sample.buys) > 0 && num(sample.sells) > 0 && num(sample.volume1h) >= 100 && num(sample.pressure) >= 52 && num(sample.change5m) > -20 && num(sample.change15m) > -15 && num(sample.change30m) > -15 && num(sample.risk) < 20 && String(sample.riskLevel) === 'CLEAR';
}

function signalBaselineFor(track) {
  if (track.signalBaselineTs) return track.samples.find(x => x.ts === track.signalBaselineTs) || null;
  return track.samples.find(x => SIGNAL_STAGES.has(x.stage)) || null;
}

function outcomeFor(track, windowMs) {
  const baseline = signalBaselineFor(track);
  if (!baseline) return null;
  const target = track.samples.filter(x => x.ts >= baseline.ts + windowMs - 90000 && x.ts <= baseline.ts + windowMs + 90000).at(-1) || track.samples.at(-1);
  if (!target || target.ts < baseline.ts + windowMs - 90000) return null;
  const baselineMc = num(baseline.marketCap);
  const targetMc = num(target.marketCap);
  const returnPct = pct(targetMc, baselineMc);
  const peakMc = Math.max(...track.samples.filter(x => x.ts <= target.ts).map(x => num(x.marketCap)), baselineMc);
  const drawdownPct = peakMc > 0 ? (targetMc - peakMc) / peakMc * 100 : null;
  const survived = survivalQuality(target, baseline);
  const winner = survived && returnPct != null && returnPct >= 10;
  const strongWinner = survived && returnPct != null && returnPct >= 25;
  return { winner, strongWinner, survived, returnPct, drawdownPct, targetStage: target.stage, score: num(baseline.score), acceleration: baseline.accelerationScore ?? null, stage: baseline.stage, dexCount: num(baseline.dexCount), poolCount: num(baseline.poolCount), ageMinutes: num(baseline.ageMs) / 60000 };
}

function evaluateSurvival(track, now) {
  const baseline = signalBaselineFor(track);
  if (!baseline) return;
  for (const [label, windowMs] of [['15m', 15 * 60000], ['30m', 30 * 60000], ['60m', 60 * 60000]]) {
    if (track.reported[label] || now - baseline.ts < windowMs) continue;
    const target = track.samples.filter(x => x.ts >= baseline.ts + windowMs - 90000 && x.ts <= baseline.ts + windowMs + 90000).at(-1) || track.samples.at(-1);
    if (!target || target.ts < baseline.ts + windowMs - 90000) continue;
    const ok = survivalQuality(target, baseline);
    const outcome = outcomeFor(track, windowMs);
    if (!outcome) continue;
    track.reported[label] = ok ? 'PASS' : 'FAIL';
    track.outcomes[label] = outcome;
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
    track = { address, symbol: input.symbol || '?', firstSeen: now, samples: [], reported: {}, outcomes: {}, signalBaselineTs: null, acceleration: null, lastRecorded: 0 };
    tracks.set(address, track);
    summary.detected++;
  }
  if (now - track.lastRecorded < SAMPLE_DEBOUNCE_MS) return track;
  const current = {
    ts: now, symbol: input.symbol || track.symbol, stage: stageInfo.stage,
    marketCap: num(input.marketCap), liquidity: num(input.liquidity), volume1h: num(input.volume1h),
    buys: num(input.buys), sells: num(input.sells), trades: num(input.buys) + num(input.sells), pressure: num(input.pressure),
    change5m: num(input.change5m), change15m: num(input.change15m), change30m: num(input.change30m), score: num(input.score), risk: num(input.risk), riskLevel: input.riskLevel || 'PENDING',
    ageMs: num(input.ageMs), dexCount: num(input.dexCount), poolCount: num(input.poolCount)
  };
  const previous = track.samples.at(-1);
  track.acceleration = accelerationFor(previous, current);
  current.accelerationScore = track.acceleration.score;
  track.samples.push(current);
  if (track.samples.length > MAX_TRACK_SAMPLES) track.samples.shift();
  if (!track.signalBaselineTs && SIGNAL_STAGES.has(current.stage)) track.signalBaselineTs = current.ts;
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
  for (const stageName of ['WATCH', 'EARLY', 'GROWING', 'RUNNING', 'PULLBACK']) {
    for (const key of failureKeys(stageSignals, stageName)) inc(summary.conditionFailures[stageName], key);
  }
  const stageInfo = { stage, reason: input.stageReason || null };
  const track = trackSample(input, stageInfo);
  const item = {
    ts: Date.now(), cycle: input.cycle, outcome: input.outcome, token: input.token, symbol: input.symbol, name: input.name, address: input.address, score: input.score,
    stage, previousStage: input.previousStage || null, stageReason: input.stageReason || null, filterReasons: reasons,
    risk: input.risk ?? null, riskLevel: input.riskLevel || null, riskFlags: input.riskFlags || [], marketCap: input.marketCap, liquidity: input.liquidity,
    volume1h: input.volume1h, pressure: input.pressure, trades: (input.buys || 0) + (input.sells || 0), ageMs: input.ageMs ?? null,
    momentum: { m5: input.change5m, m15: input.change15m, m30: input.change30m, h1: input.change1h, h6: input.change6h },
    timeframes: { m5Trades: input.stageSignals?.inputs?.m5Trades ?? null, m15Trades: input.stageSignals?.inputs?.m15Trades ?? null, m30Trades: input.stageSignals?.inputs?.m30Trades ?? null, m15Pressure: input.stageSignals?.inputs?.m15Pressure ?? null, m30Pressure: input.stageSignals?.inputs?.m30Pressure ?? null },
    dexCount: input.dexCount ?? null, poolCount: input.poolCount ?? null,
    stageSignals: compactSignals(stageSignals), acceleration: track?.acceleration || null
  };
  entries.push(item);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  return track;
}

function bucketScore(score) {
  const n = Number(score || 0);
  if (n < 50) return '<50';
  if (n < 60) return '50-59';
  if (n < 70) return '60-69';
  if (n < 80) return '70-79';
  if (n < 90) return '80-89';
  return '90-100';
}

function aggregateOutcomes(windowLabel) {
  const rows = [];
  for (const track of tracks.values()) {
    const outcome = track.outcomes?.[windowLabel];
    const baseline = signalBaselineFor(track);
    if (!outcome || !baseline) continue;
    rows.push({ ...outcome, stage: baseline.stage, scoreBucket: bucketScore(baseline.score), dexCount: num(baseline.dexCount), poolCount: num(baseline.poolCount), ageMinutes: num(baseline.ageMs) / 60000 });
  }
  const group = (keyFn) => {
    const map = new Map();
    for (const row of rows) {
      const key = keyFn(row);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return Object.fromEntries([...map.entries()].map(([key, list]) => [key, {
      samples: list.length,
      winRatePct: Math.round(list.filter(x => x.winner).length / list.length * 1000) / 10,
      strongWinRatePct: Math.round(list.filter(x => x.strongWinner).length / list.length * 1000) / 10,
      survivalRatePct: Math.round(list.filter(x => x.survived).length / list.length * 1000) / 10,
      avgReturnPct: Math.round(list.reduce((s, x) => s + num(x.returnPct), 0) / list.length * 10) / 10,
      avgDrawdownPct: Math.round(list.reduce((s, x) => s + num(x.drawdownPct), 0) / list.length * 10) / 10
    }]));
  };
  return { samples: rows.length, byStage: group(x => x.stage), byScore: group(x => x.scoreBucket), byDexCount: group(x => String(x.dexCount)) };
}

export function getTelemetryForToken(address) {
  const track = tracks.get(String(address || '').toLowerCase());
  if (!track) return null;
  const latest = track.samples.at(-1) || null;
  const baseline = signalBaselineFor(track);
  return { firstSeen: track.firstSeen, ageMinutes: Math.round((Date.now() - track.firstSeen) / 60000), samples: track.samples.length, signalBaseline: baseline, acceleration: track.acceleration, survival: { ...track.reported }, outcomes: { ...track.outcomes }, latest };
}

export function telemetrySnapshot(token = '') {
  const needle = String(token || '').trim().toLowerCase();
  const filtered = needle ? entries.filter(x => String(x.token || '').toLowerCase() === needle || String(x.address || '').toLowerCase() === needle || String(x.symbol || '').toLowerCase() === needle) : entries;
  const tracked = [...tracks.values()].map(track => ({ address: track.address, symbol: track.symbol, firstSeen: track.firstSeen, ageMinutes: Math.round((Date.now() - track.firstSeen) / 60000), samples: track.samples.length, signalBaseline: signalBaselineFor(track), acceleration: track.acceleration, survival: { ...track.reported }, outcomes: { ...track.outcomes }, latest: track.samples.at(-1) || null })).sort((a, b) => (b.acceleration?.score || 0) - (a.acceleration?.score || 0));
  return {
    at: new Date().toISOString(), buffer: filtered.length, maxBuffer: MAX_ENTRIES, trackedTokens: tracks.size,
    summary: { ...summary, stageCounts: { ...summary.stageCounts }, rejectionReasons: { ...summary.rejectionReasons }, conditionFailures: Object.fromEntries(Object.entries(summary.conditionFailures).map(([k, v]) => [k, { ...v }])) },
    acceleration: { accelerating: tracked.filter(x => x.acceleration?.label === 'ACCELERATING').length, weakening: tracked.filter(x => x.acceleration?.label === 'WEAKENING').length, steady: tracked.filter(x => x.acceleration?.label === 'STEADY').length },
    outcomes: { '15m': aggregateOutcomes('15m'), '30m': aggregateOutcomes('30m'), '60m': aggregateOutcomes('60m') },
    topAccelerating: tracked.filter(x => x.acceleration?.label === 'ACCELERATING').slice(0, 20), tracked: tracked.slice(0, 100), decisions: filtered.slice(-500).reverse()
  };
}
