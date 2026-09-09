import { registerHooks } from 'node:module';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';

const TARGET = new URL('./index.js', import.meta.url).href;
const SECURITY = new URL('./security.js', import.meta.url).href;
const HONEYPOT_BYTECODE = readFileSync(new URL('./honeypot-bytecode.txt', import.meta.url), 'utf8').trim();

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== TARGET && url !== SECURITY) return result;
    const sourceText = typeof result.source === 'string' ? result.source : Buffer.from(result.source || '').toString('utf8');
    let source = sourceText;
    if (url === TARGET) {
      if (!source.includes("from './security.js'")) {
        source = source.replace("import { applyRisk } from './risk.js';", "import { applyRisk } from './risk.js';\nimport { inspectSecurity } from './security.js';");
      }
      source = source.replace(
        'return { marketCap: p.marketCap || p.fdv || 0,',
        'return { address: getAddress(p.token), marketCap: p.marketCap || p.fdv || 0,'
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

console.log('[secure-entry] security source hook active: funded-holder honeypot simulation + contract permissions');
await import('./index.js');
