import { queueSecurity, securitySnapshot } from './security.js';

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number(n) || 0));
const EARLY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const n = (x, k) => Number(x?.[k] || 0);

function tfStats(metrics, key) {
  const tx = metrics?.tx?.[key] || {};
  const buys = n(tx, 'buys');
  const sells = n(tx, 'sells');
  const total = buys + sells;
  return {
    buys,
    sells,
    total,
    pressure: total ? buys / total * 100 : 50,
    buyers: n(tx, 'buyers'),
    sellers: n(tx, 'sellers'),
    change: Number(metrics?.changes?.[key] ?? metrics?.[`change${key}`] ?? 0),
    volume: Number(metrics?.volume?.[key] ?? metrics?.[`volume${key}`] ?? 0)
  };
}

export function classifyStage(metrics, previousHistory = []) {
  const h1 = Number(metrics?.change1h || 0);
  const h6 = Number(metrics?.change6h || 0);
  const m5 = Number(metrics?.change5m || 0);
  const volume1h = Number(metrics?.volume1h || 0);
  const pressure = Number(metrics?.pressure || 50);
  const totalTrades = Number(metrics?.buys || 0) + Number(metrics?.sells || 0);
  const ageMs = Number(metrics?.ageMs);

  const m5tf = tfStats(metrics, 'm5');
  const m15 = tfStats(metrics, 'm15');
  const m30 = tfStats(metrics, 'm30');

  const m15Active = m15.total >= 3;
  const m30Active = m30.total >= 4;
  const m15Bullish = m15.change >= 0 || (m15Active && m15.pressure >= 55);
  const m30Bullish = m30.change >= 0 || (m30Active && m30.pressure >= 55);
  const m15Strong = m15.change >= 1 || (m15Active && m15.pressure >= 58);
  const m30Strong = m30.change >= 1.5 || (m30Active && m30.pressure >= 58);
  const m15Weak = m15.change <= -1 || (m15Active && m15.pressure <= 45);
  const m30Weak = m30.change <= -1.5 || (m30Active && m30.pressure <= 45);

  const early = Number.isFinite(ageMs) && ageMs <= EARLY_MAX_AGE_MS &&
    (h1 > 2 || m5 > 1 || m15.change > 1) &&
    volume1h >= 100 && pressure >= 52 && totalTrades >= 3 &&
    (m5tf.total >= 2 || m15Active || m30Active);

  const growing =
    (h1 >= 3 || h6 >= 5 || m15.change >= 2) &&
    m5 >= 0 && volume1h >= 100 && pressure >= 55 &&
    totalTrades >= 4 &&
    ((m15Active && m15Bullish) || (m30Active && m30Bullish)) &&
    (m15.change >= 0.5 || m30.change >= 0.5 || m15.pressure >= 55 || m30.pressure >= 55);

  const running = volume1h >= 500 && pressure >= 60 && totalTrades >= 6 &&
    ((h1 >= 10 || h6 >= 20) && m15Strong && m30Strong ||
      (m5 >= 2 && m15Strong && m30Bullish && (h1 >= 3 || m30.change >= 1)));

  const hadPriorRun = previousHistory.some(x => ['EARLY', 'GROWING', 'RUNNING'].includes(x.stage)) ||
    previousHistory.some(x => Number(x.score) >= 68);

  const pullback = hadPriorRun && (
    (h1 < -3 && m5 < 0 && (m15Weak || m30Weak)) ||
    (m15.change <= -1.5 && m30.change < 0 && m15Active && m30Active) ||
    (m5 <= -2 && m15Weak && m5tf.total >= 3)
  );

  if (pullback) return 'PULLBACK';
  if (running) return 'RUNNING';
  if (growing) return 'GROWING';
  if (early) return 'EARLY';
  return 'STABLE';
}

export function assessRisk(metrics, security = {}) {
  const marketCap = Number(metrics?.marketCap || 0);
  const liquidity = Number(metrics?.liquidity || 0);
  const holders = Number(security?.holders);
  const buys = Number(metrics?.buys || 0);
  const sells = Number(metrics?.sells || 0);
  const totalTrades = buys + sells;
  const pressure = Number(metrics?.pressure || 50);
  const h1 = Number(metrics?.change1h || 0);
  const m5 = Number(metrics?.change5m || 0);
  const ratio = liquidity > 0 ? marketCap / liquidity : 0;
  const address = metrics?.address;

  let risk = 0;
  const flags = [];
  const add = (points, flag) => { risk += points; flags.push(flag); };

  if (liquidity < 5000) add(28, 'Very thin liquidity');
  else if (liquidity < 10000) add(16, 'Thin liquidity');
  if (ratio >= 25) add(30, `MC / liquidity ${ratio.toFixed(1)}x`);
  else if (ratio >= 18) add(22, `MC / liquidity ${ratio.toFixed(1)}x`);
  else if (ratio >= 12) add(12, `MC / liquidity ${ratio.toFixed(1)}x`);

  if (marketCap >= 250000 && Number.isFinite(holders) && holders > 0 && holders < 100) add(24, `Low holder count ${holders}`);
  else if (marketCap >= 250000 && Number.isFinite(holders) && holders < 250) add(12, `Low holder count ${holders}`);

  if (h1 >= 70 && totalTrades < 15) add(28, 'Extreme price move on few trades');
  else if (h1 >= 50 && totalTrades < 20) add(22, 'Sharp price move on low trade count');
  else if (h1 >= 35 && totalTrades < 15) add(16, 'Fast price acceleration with low activity');
  if (m5 >= 20 && totalTrades < 20) add(10, 'Short-term acceleration');

  if (buys >= 8 && sells <= 3) add(16, 'Insufficient sell-side confirmation');
  else if (buys >= 5 && sells === 0) add(22, 'No observed sells');
  if (pressure >= 85 && totalTrades < 25) add(10, 'Buy pressure concentrated in few trades');

  if (security?.contractExists === false) add(40, 'Contract bytecode not confirmed');
  if (security?.verified === false) add(10, 'Unverified contract');
  if (security?.proxy === true) add(6, 'Upgradeable/proxy contract');

  const onChain = securitySnapshot(address);
  if (address && Number(metrics?.score || 0) >= 52) queueSecurity(address);
  if (onChain?.securityLevel === 'FLAGGED') {
    risk = Math.max(risk, 70);
    for (const flag of onChain.securityFlags || []) flags.push(flag);
  } else if (onChain?.securityLevel === 'REVIEW') {
    risk = Math.max(risk, 35);
    for (const flag of onChain.securityFlags || []) flags.push(flag);
  }

  risk = Math.round(clamp(risk));
  const level = risk >= 55 ? 'FLAGGED' : risk >= 30 ? 'REVIEW' : 'CLEAR';
  return {
    risk,
    riskLevel: level,
    riskFlags: [...new Set(flags)].slice(0, 8),
    marketLiquidityRatio: ratio,
    security: onChain || { securityLevel: 'PENDING', securityScore: null, securityFlags: [], contract: null, permissions: null, honeypot: null }
  };
}

export function applyRisk(metrics, security = {}) {
  const result = assessRisk(metrics, security);
  const previousHistory = Array.isArray(metrics?.history) ? metrics.history : [];
  const stage = classifyStage(metrics, previousHistory);
  return { ...metrics, ...result, stage };
}
