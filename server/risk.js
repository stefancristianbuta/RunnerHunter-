import { queueSecurity, securitySnapshot } from './security.js';
import { recordTelemetry, getTelemetryForToken } from './telemetry.js';

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number(n) || 0));
const EARLY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const n = (x, k) => Number(x?.[k] || 0);

function tfStats(metrics, key) {
  const tx = metrics?.tx?.[key] || {};
  const buys = n(tx, 'buys');
  const sells = n(tx, 'sells');
  const total = buys + sells;
  return { buys, sells, total, pressure: total ? buys / total * 100 : 50, buyers: n(tx, 'buyers'), sellers: n(tx, 'sellers'), change: Number(metrics?.changes?.[key] ?? metrics?.[`change${key}`] ?? 0), volume: Number(metrics?.volume?.[key] ?? metrics?.[`volume${key}`] ?? 0) };
}

export function stageSignals(metrics, previousHistory = []) {
  const h1 = Number(metrics?.change1h || 0), h6 = Number(metrics?.change6h || 0), m5 = Number(metrics?.change5m || 0);
  const volume1h = Number(metrics?.volume1h || 0), pressure = Number(metrics?.pressure || 50);
  const totalTrades = Number(metrics?.buys || 0) + Number(metrics?.sells || 0), ageMs = Number(metrics?.ageMs);
  const m5tf = tfStats(metrics, 'm5'), m15 = tfStats(metrics, 'm15'), m30 = tfStats(metrics, 'm30');
  const m15Active = m15.total >= 3, m30Active = m30.total >= 4;
  const m15Bullish = m15.change >= 0 || (m15Active && m15.pressure >= 55), m30Bullish = m30.change >= 0 || (m30Active && m30.pressure >= 55);
  const m15Strong = m15.change >= 1 || (m15Active && m15.pressure >= 58), m30Strong = m30.change >= 1.5 || (m30Active && m30.pressure >= 58);
  const m15Weak = m15.change <= -1 || (m15Active && m15.pressure <= 45), m30Weak = m30.change <= -1.5 || (m30Active && m30.pressure <= 45);
  const early = { ageValid: Number.isFinite(ageMs) && ageMs <= EARLY_MAX_AGE_MS, momentum: h1 > 2 || m5 > 1 || m15.change > 1, volume: volume1h >= 100, pressure: pressure >= 52, trades: totalTrades >= 3, timeframeActivity: m5tf.total >= 2 || m15Active || m30Active };
  const growing = { momentum: h1 >= 3 || h6 >= 5 || m15.change >= 2, m5NonNegative: m5 >= 0, volume: volume1h >= 100, pressure: pressure >= 55, trades: totalTrades >= 4, timeframeBullish: (m15Active && m15Bullish) || (m30Active && m30Bullish), confirmation: m15.change >= 0.5 || m30.change >= 0.5 || m15.pressure >= 55 || m30.pressure >= 55 };
  const healthyM5Pullback = m5 >= -20 && h1 >= 10 && m15.change >= 3 && m30.change >= 1 && pressure >= 50 && totalTrades >= 20 && ((m15Active && m15Bullish) || (m30Active && m30Bullish));
  growing.m5NonNegative = m5 >= 0 || healthyM5Pullback;
  growing.pressure = pressure >= 55 || healthyM5Pullback;
  growing.pullbackRecovery = healthyM5Pullback;
  growing.pass = Object.values(growing).filter((_, i) => i < 7).every(Boolean);
  const running = { volume: volume1h >= 500, pressure: pressure >= 60, trades: totalTrades >= 6, momentumStructure: ((h1 >= 10 || h6 >= 20) && m15Strong && m30Strong) || (m5 >= 2 && m15Strong && m30Bullish && (h1 >= 3 || m30.change >= 1)) };
  running.pass = Object.values(running).every(Boolean);
  const hadPriorRun = previousHistory.some(x => ['EARLY', 'GROWING', 'RUNNING'].includes(x.stage)) || previousHistory.some(x => Number(x.score) >= 68);
  const pullback = { priorRun: hadPriorRun, sharpH1: h1 < -3, negativeM5: m5 < 0, weakTf: m15Weak || m30Weak, fullTfPullback: m15.change <= -1.5 && m30.change < 0 && m15Active && m30Active, fastPullback: m5 <= -2 && m15Weak && m5tf.total >= 3 };
  const pullbackPass = pullback.priorRun && ((pullback.sharpH1 && pullback.negativeM5 && pullback.weakTf) || pullback.fullTfPullback || pullback.fastPullback);
  return { inputs: { ageMs: Number.isFinite(ageMs) ? ageMs : null, ageHours: Number.isFinite(ageMs) ? Math.round(ageMs / 3600000 * 100) / 100 : null, h1, h6, m5, m15: m15.change, m30: m30.change, volume1h, pressure, totalTrades, m5Trades: m5tf.total, m15Trades: m15.total, m30Trades: m30.total, m15Pressure: Math.round(m15.pressure * 10) / 10, m30Pressure: Math.round(m30.pressure * 10) / 10 }, early: { ...early, pass: Object.values(early).every(Boolean) }, growing, running, pullback: { ...pullback, pass: pullbackPass }, hadPriorRun };
}

export function explainStage(metrics, previousHistory = []) {
  const s = stageSignals(metrics, previousHistory);
  if (s.running.pass) return { stage: 'RUNNING', reason: 'High volume, buy pressure, trade activity and momentum structure', signals: s };
  if (s.pullback.pass) return { stage: 'PULLBACK', reason: 'Prior active run plus pullback pattern', signals: s };
  if (s.growing.pass) return { stage: 'GROWING', reason: s.growing.pullbackRecovery ? 'Higher-timeframe momentum confirmed despite a healthy M5 pullback' : 'Momentum, volume, pressure and timeframe confirmation passed', signals: s };
  if (s.early.pass) return { stage: 'EARLY', reason: 'Fresh enough with initial momentum, volume, pressure, trades and timeframe activity', signals: s };
  return { stage: 'STABLE', reason: 'No active stage threshold fully passed', signals: s };
}

export function classifyStage(metrics, previousHistory = []) { return explainStage(metrics, previousHistory).stage; }

export function assessRisk(metrics, security = {}) {
  const marketCap = Number(metrics?.marketCap || 0), liquidity = Number(metrics?.liquidity || 0), holders = Number(security?.holders);
  const buys = Number(metrics?.buys || 0), sells = Number(metrics?.sells || 0), totalTrades = buys + sells, pressure = Number(metrics?.pressure || 50);
  const h1 = Number(metrics?.change1h || 0), m5 = Number(metrics?.change5m || 0), ratio = liquidity > 0 ? marketCap / liquidity : 0, address = metrics?.address;
  let risk = 0; const flags = []; const add = (points, flag) => { risk += points; flags.push(flag); };
  if (liquidity < 5000) add(28, 'Very thin liquidity'); else if (liquidity < 10000) add(16, 'Thin liquidity');
  if (ratio >= 25) add(30, `MC / liquidity ${ratio.toFixed(1)}x`); else if (ratio >= 18) add(22, `MC / liquidity ${ratio.toFixed(1)}x`); else if (ratio >= 12) add(12, `MC / liquidity ${ratio.toFixed(1)}x`);
  if (marketCap >= 250000 && Number.isFinite(holders) && holders > 0 && holders < 100) add(24, `Low holder count ${holders}`); else if (marketCap >= 250000 && Number.isFinite(holders) && holders < 250) add(12, `Low holder count ${holders}`);
  if (h1 >= 70 && totalTrades < 15) add(28, 'Extreme price move on few trades'); else if (h1 >= 50 && totalTrades < 20) add(22, 'Sharp price move on low trade count'); else if (h1 >= 35 && totalTrades < 15) add(16, 'Fast price acceleration with low activity');
  if (m5 >= 20 && totalTrades < 20) add(10, 'Short-term acceleration');
  if (buys >= 8 && sells <= 3) add(16, 'Insufficient sell-side confirmation'); else if (buys >= 5 && sells === 0) add(22, 'No observed sells');
  if (pressure >= 85 && totalTrades < 25) add(10, 'Buy pressure concentrated in few trades');
  if (security?.contractExists === false) add(40, 'Contract bytecode not confirmed');
  if (security?.verified === false) add(10, 'Unverified contract');
  if (security?.proxy === true) add(6, 'Upgradeable/proxy contract');
  const onChain = securitySnapshot(address);
  if (address && Number(metrics?.score || 0) >= 70) queueSecurity(address);
  if (onChain?.securityLevel === 'FLAGGED') { risk = Math.max(risk, 70); for (const flag of onChain.securityFlags || []) flags.push(flag); }
  else if (onChain?.securityLevel === 'REVIEW') { risk = Math.max(risk, 35); for (const flag of onChain.securityFlags || []) flags.push(flag); }
  risk = Math.round(clamp(risk));
  const level = risk >= 55 ? 'FLAGGED' : risk >= 30 ? 'REVIEW' : 'CLEAR';
  return { risk, riskLevel: level, riskFlags: [...new Set(flags)].slice(0, 8), marketLiquidityRatio: ratio, security: onChain || { securityLevel: 'PENDING', securityScore: null, securityFlags: [], contract: null, permissions: null, honeypot: null } };
}

export function applyRisk(metrics, security = {}) {
  const result = assessRisk(metrics, security);
  const previousHistory = Array.isArray(metrics?.history) ? metrics.history : [];
  const stageInfo = explainStage(metrics, previousHistory);
  const output = { ...metrics, ...result, stage: stageInfo.stage, stageReason: stageInfo.reason, stageSignals: stageInfo.signals };
  try {
    const address = output.address;
    const outcome = output.riskLevel === 'FLAGGED' ? 'RISK_REJECT' : 'CANDIDATE';
    recordTelemetry({ ...output, token: address, outcome, transition: previousHistory.at(-1)?.stage !== output.stage });
    output.telemetry = getTelemetryForToken(address);
  } catch (error) {
    console.error(`[telemetry:error] ${error.message}`);
  }
  return output;
}
