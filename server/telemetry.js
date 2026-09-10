const MAX_ENTRIES = 2000;
const entries = [];
const summary = {
  decisions: 0,
  marketRejected: 0,
  candidates: 0,
  riskRejected: 0,
  stageCounts: { STABLE: 0, EARLY: 0, GROWING: 0, RUNNING: 0, PULLBACK: 0 },
  rejectionReasons: {},
  conditionFailures: { EARLY: {}, GROWING: {}, RUNNING: {}, PULLBACK: {} }
};

function inc(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function filterReasons(m) {
  const reasons = [];
  if (m.marketCap < 10000) reasons.push('MARKET_CAP_LT_10000');
  if (m.liquidity < 2500) reasons.push('LIQUIDITY_LT_2500');
  if (m.marketCap > 0 && m.marketCap < Math.max(2500, m.liquidity * 0.35)) reasons.push('MC_LT_35PCT_LIQUIDITY');
  if (m.buys + m.sells < 2) reasons.push('TRADES_LT_2');
  if (m.volume1h < 25) reasons.push('VOLUME1H_LT_25');
  return reasons;
}

function compactSignals(signals) {
  if (!signals) return null;
  const compact = {};
  for (const [stage, data] of Object.entries(signals)) {
    if (!data || typeof data !== 'object') continue;
    compact[stage] = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) {
        compact[stage][key] = value.pass !== undefined ? Boolean(value.pass) : value;
      } else {
        compact[stage][key] = value;
      }
    }
  }
  return compact;
}

function failureKeys(stageSignals, stage) {
  const data = stageSignals?.[stage];
  if (!data || typeof data !== 'object') return [];
  return Object.entries(data).filter(([key, value]) => key !== 'pass' && value === false).map(([key]) => key);
}

export function recordTelemetry(input) {
  const now = Date.now();
  const reasons = input.filterReasons || [];
  const stage = input.stage || 'STABLE';
  const riskRejected = input.outcome === 'RISK_REJECT';
  const stageSignals = input.stageSignals || null;

  summary.decisions += 1;
  if (input.outcome === 'MARKET_REJECT') {
    summary.marketRejected += 1;
    for (const reason of reasons) inc(summary.rejectionReasons, reason);
  } else {
    summary.candidates += 1;
    summary.stageCounts[stage] = (summary.stageCounts[stage] || 0) + 1;
    if (riskRejected) summary.riskRejected += 1;
  }
  for (const stageName of ['EARLY', 'GROWING', 'RUNNING', 'PULLBACK']) {
    for (const key of failureKeys(stageSignals, stageName)) inc(summary.conditionFailures[stageName], key);
  }

  const item = {
    ts: now,
    cycle: input.cycle,
    outcome: input.outcome,
    token: input.token,
    symbol: input.symbol,
    name: input.name,
    address: input.address,
    score: input.score,
    stage,
    previousStage: input.previousStage || null,
    stageReason: input.stageReason || null,
    filterReasons: reasons,
    risk: input.risk ?? null,
    riskLevel: input.riskLevel || null,
    riskFlags: input.riskFlags || [],
    marketCap: input.marketCap,
    liquidity: input.liquidity,
    volume1h: input.volume1h,
    pressure: input.pressure,
    trades: (input.buys || 0) + (input.sells || 0),
    ageMs: input.ageMs ?? null,
    momentum: {
      m5: input.change5m,
      m15: input.change15m,
      m30: input.change30m,
      h1: input.change1h,
      h6: input.change6h
    },
    timeframes: {
      m5Trades: input.stageSignals?.inputs?.m5Trades ?? null,
      m15Trades: input.stageSignals?.inputs?.m15Trades ?? null,
      m30Trades: input.stageSignals?.inputs?.m30Trades ?? null,
      m15Pressure: input.stageSignals?.inputs?.m15Pressure ?? null,
      m30Pressure: input.stageSignals?.inputs?.m30Pressure ?? null
    },
    stageSignals: compactSignals(stageSignals)
  };
  entries.push(item);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  if (input.transition || input.outcome === 'RISK_REJECT') {
    console.log(`[telemetry] ${input.symbol || '?'} outcome=${input.outcome} stage=${stage} prev=${input.previousStage || '-'} score=${input.score ?? 0} reason=${input.stageReason || reasons.join(',') || '-'} risk=${input.riskLevel || '-'}`);
  }
}

export function telemetrySnapshot(token = '') {
  const needle = String(token || '').trim().toLowerCase();
  const filtered = needle
    ? entries.filter(x => String(x.token || '').toLowerCase() === needle || String(x.address || '').toLowerCase() === needle || String(x.symbol || '').toLowerCase() === needle)
    : entries;
  return {
    at: new Date().toISOString(),
    buffer: filtered.length,
    maxBuffer: MAX_ENTRIES,
    summary: {
      ...summary,
      stageCounts: { ...summary.stageCounts },
      rejectionReasons: { ...summary.rejectionReasons },
      conditionFailures: Object.fromEntries(Object.entries(summary.conditionFailures).map(([k, v]) => [k, { ...v }]))
    },
    decisions: filtered.slice(-500).reverse()
  };
}
