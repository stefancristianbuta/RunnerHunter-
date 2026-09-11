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
      source = source.replace("import { applyRisk, classifyStage } from './risk.js';", "import { applyRisk, classifyStage, explainStage } from './risk.js';\nimport { recordTelemetry, telemetrySnapshot, getTelemetryForToken } from './telemetry.js'");

      const aggregateHelper = `
function aggregateTokenPools(pools) {
  const groups = new Map();
  for (const p of pools) {
    if (!p?.token) continue;
    const key = p.token.toLowerCase();
    const current = groups.get(key);
    if (!current) {
      groups.set(key, { ...p, poolCount: 1, dexCount: 1, _dexes: new Set([p.dex]), _pools: [p] });
      continue;
    }
    current.poolCount++;
    current._pools.push(p);
    current._dexes.add(p.dex);
    current.dexCount = current._dexes.size;
    current.liquidity += Number(p.liquidity || 0);
    for (const keyTf of ['m5','m15','m30','h1','h6','h24']) {
      current.volume[keyTf] = Number(current.volume[keyTf] || 0) + Number(p.volume?.[keyTf] || 0);
      for (const field of ['buys','sells','buyers','sellers']) current.tx[keyTf][field] = Number(current.tx[keyTf]?.[field] || 0) + Number(p.tx?.[keyTf]?.[field] || 0);
    }
    const weightA = Math.max(Number(current.liquidity || 0) - Number(p.liquidity || 0), 1);
    const weightB = Math.max(Number(p.liquidity || 0), 1);
    for (const keyTf of ['m5','m15','m30','h1','h6','h24']) current.changes[keyTf] = (Number(current.changes[keyTf] || 0) * weightA + Number(p.changes?.[keyTf] || 0) * weightB) / (weightA + weightB);
    if ((Number(p.liquidity || 0) + Number(p.volume?.h1 || 0)) > (Number(current.liquidity || 0) + Number(current.volume?.h1 || 0))) {
      current.pool = p.pool; current.dex = p.dex; current.name = p.name; current.symbol = p.symbol; current.image = p.image || current.image; current.price = p.price;
    }
    current.marketCap = Math.max(Number(current.marketCap || 0), Number(p.marketCap || 0), Number(p.fdv || 0));
    current.fdv = Math.max(Number(current.fdv || 0), Number(p.fdv || 0));
    current.createdAt = [current.createdAt, p.createdAt].filter(Boolean).sort()[0] || null;
    current.timeframeData = Object.fromEntries(['m5','m15','m30','h1','h6','h24'].map(k => [k, Boolean(current.timeframeData?.[k] || p.timeframeData?.[k])]));
  }
  for (const item of groups.values()) { delete item._dexes; delete item._pools; }
  return [...groups.values()];
}
`;
      source = source.replace('\nasync function scan() {', `${aggregateHelper}\nasync function scan() {`);
      source = source.replace(`  const byToken = new Map();\n  for (const p of pools) {\n    const current = byToken.get(p.token);\n    if (!current || p.volume.h1 + p.liquidity > current.volume.h1 + current.liquidity) byToken.set(p.token, p);\n  }\n  const discovered = [...byToken.values()];`, `  const discovered = aggregateTokenPools(pools);`);
      source = source.replace('  const score = Math.round(momentum * 0.42 + organic * 0.33 + acceleration * 0.25);', "  const dexBonus = Math.min(10, Math.max(0, Number(p.dexCount || 1) - 1) * 5);\n  const score = Math.round(Math.min(100, momentum * 0.42 + organic * 0.33 + acceleration * 0.25 + dexBonus));");
      source = source.replace('    volume1h: p.volume.h1, volume24h: p.volume.h24,', '    volume1h: p.volume.h1, volume24h: p.volume.h24,\n    dexCount: Number(p.dexCount || 1), poolCount: Number(p.poolCount || 1), dexExpansionScore: dexBonus,');
      source = source.replace('    const m = scorePool(p, prev);', '    const m = scorePool(p, prev);\n    m.acceleration = Math.round(45 + m.change5m * 2 + m.change15m * 0.7 + (Number(m.tx?.m5?.buys || 0) + Number(m.tx?.m5?.sells || 0)) * 2 + Number(m.dexExpansionScore || 0));');
      source = source.replace('    const stageInfo = explainStage(m, prev);', '    const stageInfo = explainStage(m, prev);');
      source = source.replace('    const metrics = applyRisk({ ...m, address: getAddress(p.token), history: history.get(key) || [] }, { holders: holderFromCache, ...cachedSecurity });', '    const metrics = applyRisk({ ...m, address: getAddress(p.token), history: history.get(key) || [] }, { holders: holderFromCache, ...cachedSecurity });');
      source = source.replace("app.get('/api/market-debug', (req, res) => res.json({ status: state.status, pools: geckoCache.pools.length, radar: radar.length, timeframeCoverage: state.timeframeCoverage, geckoCooldown: Math.max(0, geckoBlockedUntil - Date.now()), geckoRefreshInFlight, sources: Object.fromEntries(GECKO_ENDPOINTS.map(x => [x.key, { at: geckoSources.get(x.key)?.at || 0, pools: geckoSources.get(x.key)?.pools?.length || 0, age: geckoSources.has(x.key) ? Date.now() - geckoSources.get(x.key).at : null }])), warnings: state.warnings, sample: geckoCache.pools.slice(0, 10) }));", "app.get('/api/market-debug', (req, res) => res.json({ status: state.status, pools: geckoCache.pools.length, radar: radar.length, timeframeCoverage: state.timeframeCoverage, geckoCooldown: Math.max(0, geckoBlockedUntil - Date.now()), geckoRefreshInFlight, sources: Object.fromEntries(GECKO_ENDPOINTS.map(x => [x.key, { at: geckoSources.get(x.key)?.at || 0, pools: geckoSources.get(x.key)?.pools?.length || 0, age: geckoSources.has(x.key) ? Date.now() - geckoSources.get(x.key).at : null }])), warnings: state.warnings, sample: geckoCache.pools.slice(0, 10) }));\napp.get('/api/telemetry', (req, res) => res.json(telemetrySnapshot(req.query.token || '')))");
      source = source.replace("  { key: 'pools-2', path: '/networks/robinhood/pools?page=2&include=base_token,quote_token,dex', minAge: 180000 }\n];", "  { key: 'pools-2', path: '/networks/robinhood/pools?page=2&include=base_token,quote_token,dex', minAge: 180000 },\n  { key: 'pons-1', path: '/networks/robinhood/dexes/pons-v2-dex/pools?page=1&include=base_token,quote_token,dex', minAge: 120000 },\n  { key: 'pons-2', path: '/networks/robinhood/dexes/pons-v2-dex/pools?page=2&include=base_token,quote_token,dex', minAge: 240000 },\n  { key: 'pons-3', path: '/networks/robinhood/dexes/pons-v2-dex/pools?page=3&include=base_token,quote_token,dex', minAge: 360000 },\n  { key: 'uniswap-v3-fast', path: '/networks/robinhood/dexes/uniswap-v3-robinhood/pools?page=1&include=base_token,quote_token,dex', minAge: 120000 },\n  { key: 'uniswap-v4-fast', path: '/networks/robinhood/dexes/uniswap-v4-robinhood/pools?page=1&include=base_token,quote_token,dex', minAge: 120000 },\n  { key: 'ramses-v3-fast', path: '/networks/robinhood/dexes/ramses-v3-robinhood/pools?page=1&include=base_token,quote_token,dex', minAge: 180000 }\n];");
      source = source.replace('geckoNextAllowedAt = Date.now() + 6500;', 'geckoNextAllowedAt = Date.now() + 15000;');
      source = source.replace('geckoBlockedUntil = Date.now() + Math.max(60, retry) * 1000;\n      throw new Error(`GeckoTerminal 429; cooldown ${Math.max(60, retry)}s`);', 'geckoBlockedUntil = Date.now() + Math.max(300, retry) * 1000;\n      throw new Error(`GeckoTerminal 429; cooldown ${Math.max(300, retry)}s`);');
    }
    if (url === SECURITY) {
      source = source.replace(/const SIM_INIT = '0x[0-9a-fA-F]+';/, `const SIM_INIT = ${JSON.stringify(HONEYPOT_BYTECODE)};`);
      const whaleHelper = `\nasync function getSimWhale(token) {\n  const configured = process.env.RH_SIM_WHALE || process.env.SCANHOOD_WHALE;\n  if (configured) return configured;\n  try {\n    const r = await fetch(BLOCKSCOUT + '/tokens/' + token + '/holders?items_count=50', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });\n    if (!r.ok) return null;\n    const data = await r.json();\n    for (const item of data?.items || []) {\n      const holder = item?.address_hash?.hash || item?.address?.hash || item?.address_hash;\n      if (!holder || item?.address_hash?.is_contract || item?.address?.is_contract) continue;\n      try {\n        const balance = await withRpc(p => p.getBalance(holder));\n        if (balance >= 50_000_000_000_000_000n) return holder;\n      } catch {}\n    }\n  } catch {}\n  return null;\n}\n`;
      source = source.replace('async function simulateHoneypot(token) {', whaleHelper + '\nasync function simulateHoneypot(token) {');
      source = source.replace("const tx = { from: SIM_FROM, value: `0x${TEST_ETH.toString(16)}`, data };", "const whale = await getSimWhale(token);\n  if (!whale) { const result = { status: 'UNKNOWN', verdict: 'NO_FUNDED_SIM_ADDRESS', canBuy: null, canSell: null, venue: venue.kind, roundTripLossPct: null, reason: 'No funded holder available for read-only simulation', checkedAt: Date.now() }; simulationCache.set(key, result); return result; }\n  const tx = { from: whale, value: `0x${TEST_ETH.toString(16)}`, data };");
      source = source.replace("withRpc(p => p.send('eth_call', [tx, 'latest', { [SIM_FROM]: { balance: `0x${(TEST_ETH * 2n).toString(16)}` } }]))", "withRpc(p => p.send('eth_call', [tx, 'latest']))");
    }
    return { ...result, source };
  }
});

console.log('[secure-entry] security source hook active: funded-holder honeypot simulation + contract permissions + live runner telemetry + early signal + multi-pool aggregation + dedicated Pons discovery + top DEX direct discovery');
await import('./index.js');
