import { queueSecurity, securitySnapshot } from './security.js';

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Number(n) || 0));

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
  if (address) queueSecurity(address);
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
  const stage = result.riskLevel === 'FLAGGED' ? 'FLAGGED' : metrics.stage;
  return { ...metrics, ...result, stage };
}
