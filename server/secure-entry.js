import { registerHooks } from 'node:module';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

const TARGET = new URL('./index.js', import.meta.url).href;
const SECURITY = new URL('./security.js', import.meta.url).href;
const HONEYPOT_BYTECODE = readFileSync(new URL('./honeypot-bytecode.txt', import.meta.url), 'utf8').trim();
const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || 'https://robinhoodchain.blockscout.com/api/v2';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== TARGET && url !== SECURITY) return result;
    const sourceText = typeof result.source === 'string' ? result.source : Buffer.from(result.source || '').toString('utf8');
    let source = sourceText;

    if (url === TARGET) {
      source = source.replace(
        "import { applyRisk, classifyStage } from './risk.js';",
        "import { applyRisk, classifyStage, explainStage } from './risk.js';\nimport { recordTelemetry, telemetrySnapshot, getTelemetryForToken } from './telemetry.js'"
      );

      source = source.replace(
        '    const m = scorePool(p, prev);\n    if (!passesFilter(m)) continue;',
        `    const m = scorePool(p, prev);
    const stageInfo = explainStage(m, prev);
    const previousStage = prev[prev.length - 1]?.stage || null;
    const filterReasons = [];
    if (m.marketCap < 10000) filterReasons.push('MARKET_CAP_LT_10000');
    if (m.liquidity < 2500) filterReasons.push('LIQUIDITY_LT_2500');
    if (m.marketCap > 0 && m.marketCap < Math.max(2500, m.liquidity * 0.35)) filterReasons.push('MC_LT_35PCT_LIQUIDITY');
    if (m.buys + m.sells < 2) filterReasons.push('TRADES_LT_2');
    if (m.volume1h < 25) filterReasons.push('VOLUME1H_LT_25');
    if (filterReasons.length) {
      recordTelemetry({ cycle: state.scanCycle + 1, outcome: 'MARKET_REJECT', token: p.token, address: getAddress(p.token), symbol: p.symbol, name: p.name, score: m.score, stage: stageInfo.stage, previousStage, stageReason: stageInfo.reason, stageSignals: stageInfo.signals, filterReasons, marketCap: m.marketCap, liquidity: m.liquidity, volume1h: m.volume1h, pressure: m.pressure, buys: m.buys, sells: m.sells, ageMs: m.ageMs, change5m: m.change5m, change15m: m.change15m, change30m: m.change30m, change1h: m.change1h, change6h: m.change6h });
      continue;
    }`
      );

      source = source.replace(
        '    const metrics = applyRisk({ ...m, history: history.get(key) || [] }, { holders: holderFromCache, ...cachedSecurity });',
        `    const metrics = applyRisk({ ...m, address: getAddress(p.token), history: history.get(key) || [] }, { holders: holderFromCache, ...cachedSecurity });
    recordTelemetry({ cycle: state.scanCycle + 1, outcome: metrics.riskLevel === 'FLAGGED' ? 'RISK_REJECT' : 'CANDIDATE', token: p.token, address: getAddress(p.token), symbol: p.symbol, name: p.name, score: metrics.score, stage: metrics.stage, previousStage, stageReason: metrics.stageReason, stageSignals: metrics.stageSignals, risk: metrics.risk, riskLevel: metrics.riskLevel, riskFlags: metrics.riskFlags, marketCap: metrics.marketCap, liquidity: metrics.liquidity, volume1h: metrics.volume1h, pressure: metrics.pressure, buys: metrics.buys, sells: metrics.sells, ageMs: metrics.ageMs, change5m: metrics.change5m, change15m: metrics.change15m, change30m: metrics.change30m, change1h: metrics.change1h, change6h: metrics.change6h, transition: previousStage !== metrics.stage });
    metrics.telemetry = getTelemetryForToken(getAddress(p.token));`
      );

      source = source.replace(
        "app.get('/api/market-debug', (req, res) => res.json({ status: state.status, pools: geckoCache.pools.length, radar: radar.length, timeframeCoverage: state.timeframeCoverage, geckoCooldown: Math.max(0, geckoBlockedUntil - Date.now()), geckoRefreshInFlight, sources: Object.fromEntries(GECKO_ENDPOINTS.map(x => [x.key, { at: geckoSources.get(x.key)?.at || 0, pools: geckoSources.get(x.key)?.pools?.length || 0, age: geckoSources.has(x.key) ? Date.now() - geckoSources.get(x.key).at : null }])), warnings: state.warnings, sample: geckoCache.pools.slice(0, 10) }));",
        "app.get('/api/market-debug', (req, res) => res.json({ status: state.status, pools: geckoCache.pools.length, radar: radar.length, timeframeCoverage: state.timeframeCoverage, geckoCooldown: Math.max(0, geckoBlockedUntil - Date.now()), geckoRefreshInFlight, sources: Object.fromEntries(GECKO_ENDPOINTS.map(x => [x.key, { at: geckoSources.get(x.key)?.at || 0, pools: geckoSources.get(x.key)?.pools?.length || 0, age: geckoSources.has(x.key) ? Date.now() - geckoSources.get(x.key).at : null }])), warnings: state.warnings, sample: geckoCache.pools.slice(0, 10) }));\napp.get('/api/telemetry', (req, res) => res.json(telemetrySnapshot(req.query.token || '')));"
      );

      source = source.replace(
        "  { key: 'pools-2', path: '/networks/robinhood/pools?page=2&include=base_token,quote_token,dex', minAge: 180000 }\n];",
        "  { key: 'pools-2', path: '/networks/robinhood/pools?page=2&include=base_token,quote_token,dex', minAge: 180000 },\n  { key: 'pons-1', path: '/networks/robinhood/pons-v2-dex/pools?page=1&include=base_token,quote_token,dex', minAge: 120000 },\n  { key: 'pons-2', path: '/networks/robinhood/pons-v2-dex/pools?page=2&include=base_token,quote_token,dex', minAge: 240000 },\n  { key: 'pons-3', path: '/networks/robinhood/pons-v2-dex/pools?page=3&include=base_token,quote_token,dex', minAge: 360000 }\n];"
      );

      source = source.replace(
        'geckoNextAllowedAt = Date.now() + 6500;',
        'geckoNextAllowedAt = Date.now() + 10000;'
      );

      source = source.replace(
        'geckoBlockedUntil = Date.now() + Math.max(60, retry) * 1000;\n      throw new Error(`GeckoTerminal 429; cooldown ${Math.max(60, retry)}s`);',
        'geckoBlockedUntil = Date.now() + Math.max(120, retry) * 1000;\n      throw new Error(`GeckoTerminal 429; cooldown ${Math.max(120, retry)}s`);'
      );
    }

    if (url === SECURITY) {
      source = source.replace(/const SIM_INIT = '0x[0-9a-fA-F]+';/, `const SIM_INIT = ${JSON.stringify(HONEYPOT_BYTECODE)};`);
      const whaleHelper = `
async function getSimWhale(token) {
  const configured = process.env.RH_SIM_WHALE || process.env.SCANHOOD_WHALE;
  if (configured) return configured;
  try {
    const r = await fetch(\`${BLOCKSCOUT}/tokens/\${token}/holders?items_count=50\`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const data = await r.json();
    for (const item of data?.items || []) {
      const holder = item?.address_hash?.hash || item?.address?.hash || item?.address_hash;
      if (!holder || item?.address_hash?.is_contract || item?.address?.is_contract) continue;
      try {
        const balance = await withRpc(p => p.getBalance(holder));
        if (balance >= 50_000_000_000_000_000n) return holder;
      } catch {}
    }
  } catch {}
  return null;
}
`;
      source = source.replace('async function simulateHoneypot(token) {', whaleHelper + '\nasync function simulateHoneypot(token) {');
      source = source.replace(
        "const tx = { from: SIM_FROM, value: `0x${TEST_ETH.toString(16)}`, data };",
        "const whale = await getSimWhale(token);\n  if (!whale) { const result = { status: 'UNKNOWN', verdict: 'NO_FUNDED_SIM_ADDRESS', canBuy: null, canSell: null, venue: venue.kind, roundTripLossPct: null, reason: 'No funded holder available for read-only simulation', checkedAt: Date.now() }; simulationCache.set(key, result); return result; }\n  const tx = { from: whale, value: `0x${TEST_ETH.toString(16)}`, data };"
      );
      source = source.replace(
        "withRpc(p => p.send('eth_call', [tx, 'latest', { [SIM_FROM]: { balance: `0x${(TEST_ETH * 2n).toString(16)}` } }]))",
        "withRpc(p => p.send('eth_call', [tx, 'latest']))"
      );
    }
    return { ...result, source };
  }
});

console.log('[secure-entry] security source hook active: funded-holder honeypot simulation + contract permissions + live runner telemetry + dedicated Pons discovery');
await import('./index.js');