import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Interface, getAddress } from 'ethers';
import { applyRisk } from './risk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 10000);
const RPC_URLS = [...new Set([
  ...(process.env.RH_RPC_URLS || '').split(',').map(x => x.trim()).filter(Boolean),
  process.env.RH_RPC_URL,
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com'
].filter(Boolean))];
const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || 'https://robinhoodchain.blockscout.com/api/v2';
const GECKO = 'https://api.geckoterminal.com/api/v2';
const providers = RPC_URLS.map(url => new JsonRpcProvider(url, 4663, { staticNetwork: true }));

const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase();
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'.toLowerCase();
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const STABLE = new Set(['WETH', 'USDG', 'USDC', 'USDT', 'DAI', 'USDE']);
const EARLY_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const erc20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
]);
const multicall3 = new Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)'
]);

const metaCache = new Map();
const scoutCache = new Map();
const contractCache = new Map();
const history = new Map();
let radar = [];
let geckoCache = { at: 0, pools: [] };
const geckoSources = new Map();
let geckoRefreshInFlight = false;
let scanning = false;
let enriching = false;
const started = Date.now();
let state = {
  status: 'STARTING', lastUpdate: null, scanCycle: 0, discovered: 0,
  analyzed: 0, active: 0, errors: 0, flagged: 0, warnings: [], latestBlock: null,
  uptime: 0, source: 'GeckoTerminal + multi-RPC + Blockscout'
};

async function withRpc(task) {
  let lastError;
  for (let i = 0; i < providers.length; i++) {
    try { return await task(providers[i], RPC_URLS[i]); }
    catch (e) {
      lastError = e;
      if (i < providers.length - 1) state.warnings = [...state.warnings, `RPC failover ${i + 1}->${i + 2}: ${e.message}`].slice(-10);
    }
  }
  throw lastError || new Error('No RPC providers configured');
}

async function multicall(calls) {
  const data = multicall3.encodeFunctionData('aggregate3', [calls]);
  const raw = await withRpc((p) => p.call({ to: MULTICALL3, data }));
  return multicall3.decodeFunctionResult('aggregate3', raw)[0];
}

async function tokenMeta(address) {
  const key = address.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  let name = 'Unknown', symbol = '?', decimals = 18, totalSupply = 0n;
  try {
    const methods = ['name', 'symbol', 'decimals', 'totalSupply'];
    const calls = methods.map(method => ({ target: address, allowFailure: true, callData: erc20.encodeFunctionData(method) }));
    const results = await multicall(calls);
    const decode = (index, method, fallback) => {
      try {
        const result = results[index];
        if (!result?.success) return fallback;
        return erc20.decodeFunctionResult(method, result.returnData)[0] ?? fallback;
      } catch { return fallback; }
    };
    name = decode(0, 'name', 'Unknown');
    symbol = decode(1, 'symbol', '?');
    decimals = decode(2, 'decimals', 18);
    totalSupply = decode(3, 'totalSupply', 0n);
  } catch {
    const call = async method => { try { return await withRpc(p => p.call({ to: address, data: erc20.encodeFunctionData(method) })); } catch { return null; } };
    const decodeFallback = async (method, fallback) => { const raw = await call(method); if (raw == null) return fallback; try { return erc20.decodeFunctionResult(method, raw)[0]; } catch { return fallback; } };
    [name, symbol, decimals, totalSupply] = await Promise.all([
      decodeFallback('name', 'Unknown'), decodeFallback('symbol', '?'), decodeFallback('decimals', 18), decodeFallback('totalSupply', 0n)
    ]);
  }
  const meta = { address: getAddress(address), name: String(name || 'Unknown'), symbol: String(symbol || '?'), decimals: Number(decimals || 18), totalSupply: String(totalSupply || 0n) };
  metaCache.set(key, meta);
  return meta;
}

async function latestBlockNumber() {
  try { return await withRpc(p => p.getBlockNumber()); }
  catch (e) { state.warnings = [...state.warnings, `RPC: ${e.message}`].slice(-10); return null; }
}

async function blockscoutToken(address) {
  const key = address.toLowerCase();
  const cached = scoutCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;
  try {
    const r = await fetch(`${BLOCKSCOUT}/tokens/${address}`, { signal: AbortSignal.timeout(4500), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`Blockscout ${r.status}`);
    const data = await r.json();
    scoutCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    state.warnings = [...state.warnings, `Blockscout ${address}: ${e.message}`].slice(-10);
    if (cached) return cached.data;
    scoutCache.set(key, { at: Date.now(), data: null });
    return null;
  }
}

async function blockscoutCounters(address) {
  try {
    const r = await fetch(`${BLOCKSCOUT}/tokens/${address}/counters`, { signal: AbortSignal.timeout(4500), headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function blockscoutContract(address) {
  const key = address.toLowerCase();
  const cached = contractCache.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  try {
    const r = await fetch(`${BLOCKSCOUT}/smart-contracts/${address}`, { signal: AbortSignal.timeout(4500), headers: { accept: 'application/json' } });
    if (r.status === 404) {
      const data = { verified: false, contractExists: true, proxy: false, name: null };
      contractCache.set(key, { at: Date.now(), data });
      return data;
    }
    if (!r.ok) throw new Error(`Blockscout contract ${r.status}`);
    const raw = await r.json();
    const data = { verified: raw?.is_verified === true, contractExists: true, proxy: Boolean(raw?.minimal_proxy_address_hash || raw?.implementation_address_hash), name: raw?.name || null };
    contractCache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    const data = { verified: null, contractExists: null, proxy: null, name: null };
    contractCache.set(key, { at: Date.now(), data });
    return data;
  }
}

function scoutInfo(scout) {
  if (!scout) return { holders: null, image: '' };
  const rawHolders = scout.holders_count ?? scout.holders ?? scout.holder_count ?? scout.token_holders_count;
  const holders = rawHolders == null ? null : Number(rawHolders);
  const image = scout.icon_url || scout.image_url || scout.metadata?.logo || scout.metadata?.image || '';
  return { holders: Number.isFinite(holders) && holders >= 0 ? holders : null, image: typeof image === 'string' ? image : '' };
}

async function enrichRadar(results) {
  if (enriching) return;
  enriching = true;
  try {
    const targets = results.slice(0, 30);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length) {
        const item = results[cursor++];
        const [scout, contract] = await Promise.all([blockscoutToken(item.address), blockscoutContract(item.address)]);
        const info = scoutInfo(scout);
        let holders = info.holders;
        if (holders == null) {
          const counters = await blockscoutCounters(item.address);
          const n = Number(counters?.token_holders_count);
          if (Number.isFinite(n)) holders = n;
        }
        const current = radar.find(x => x.address.toLowerCase() === item.address.toLowerCase()) || item;
        current.holders = holders;
        current.verified = contract?.verified ?? null;
        current.contractExists = contract?.contractExists ?? null;
        current.proxy = contract?.proxy ?? null;
        const secured = applyRisk(current, { holders, ...contract });
        current.risk = secured.risk;
        current.riskLevel = secured.riskLevel;
        current.riskFlags = secured.riskFlags;
        current.marketLiquidityRatio = secured.marketLiquidityRatio;
        if (secured.stage !== current.stage) current.stage = secured.stage;
        current.image = info.image || current.image || '';
      }
    });
    await Promise.all(workers);
  } finally { enriching = false; }
}

let geckoNextAllowedAt = 0;
let geckoBlockedUntil = 0;
let geckoQueue = Promise.resolve();
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function gecko(pathname) {
  const run = async () => {
    if (Date.now() < geckoBlockedUntil) throw new Error('GeckoTerminal rate-limit cooldown');
    const delay = Math.max(0, geckoNextAllowedAt - Date.now());
    if (delay) await wait(delay);
    geckoNextAllowedAt = Date.now() + 6500;
    const r = await fetch(`${GECKO}${pathname}`, { headers: { accept: 'application/json;version=20230203' }, signal: AbortSignal.timeout(8000) });
    if (r.status === 429) {
      const retry = Number(r.headers.get('retry-after') || 60);
      geckoBlockedUntil = Date.now() + Math.max(60, retry) * 1000;
      throw new Error(`GeckoTerminal 429; cooldown ${Math.max(60, retry)}s`);
    }
    if (!r.ok) throw new Error(`GeckoTerminal ${r.status}`);
    return r.json();
  };
  const result = geckoQueue.then(run, run);
  geckoQueue = result.catch(() => undefined);
  return result;
}

function addressFromResourceId(id) {
  if (!id) return null;
  const s = String(id).split('_').pop();
  return /^0x[a-f0-9]{40}$/i.test(s) ? s.toLowerCase() : null;
}

function includedTokenMap(payload) {
  const map = new Map();
  for (const item of payload?.included || []) {
    if (item?.type !== 'token') continue;
    const address = String(item.attributes?.address || addressFromResourceId(item.id) || '').toLowerCase();
    if (address) map.set(String(item.id), { address, ...item.attributes });
  }
  return map;
}

function normalizePool(item, included) {
  const a = item?.attributes || {};
  const rel = item?.relationships || {};
  const base = included.get(rel.base_token?.data?.id) || { address: addressFromResourceId(rel.base_token?.data?.id), symbol: '?', name: 'Unknown' };
  const quote = included.get(rel.quote_token?.data?.id) || { address: addressFromResourceId(rel.quote_token?.data?.id), symbol: '?', name: 'Unknown' };
  const baseStable = STABLE.has(String(base.symbol || '').toUpperCase()) || base.address === WETH || base.address === USDG;
  const token = baseStable ? quote : base;
  if (!token?.address || token.address === WETH || token.address === USDG) return null;
  const tx = a.transactions || {}, pc = a.price_change_percentage || {}, vol = a.volume_usd || {};
  return {
    pool: String(a.address || '').toLowerCase(), dex: rel.dex?.data?.id || 'unknown',
    token: token.address.toLowerCase(), name: token.name || 'Unknown', symbol: token.symbol || '?',
    image: token.image_url || '', price: Number(a.base_token_price_usd || a.token_price_usd || 0),
    marketCap: Number(a.market_cap_usd || 0), fdv: Number(a.fdv_usd || 0), liquidity: Number(a.reserve_in_usd || 0),
    changes: { m5: Number(pc.m5 || 0), h1: Number(pc.h1 || 0), h6: Number(pc.h6 || 0), h24: Number(pc.h24 || 0) },
    tx: { m5: tx.m5 || {}, h1: tx.h1 || {}, h6: tx.h6 || {}, h24: tx.h24 || {} },
    volume: { m5: Number(vol.m5 || 0), h1: Number(vol.h1 || 0), h6: Number(vol.h6 || 0), h24: Number(vol.h24 || 0) },
    createdAt: a.pool_created_at || null
  };
}

const GECKO_ENDPOINTS = [
  { key: 'new-1', path: '/networks/robinhood/new_pools?page=1&include=base_token,quote_token,dex', minAge: 20000 },
  { key: 'new-2', path: '/networks/robinhood/new_pools?page=2&include=base_token,quote_token,dex', minAge: 45000 },
  { key: 'trending-1', path: '/networks/robinhood/trending_pools?page=1&include=base_token,quote_token,dex', minAge: 60000 },
  { key: 'trending-2', path: '/networks/robinhood/trending_pools?page=2&include=base_token,quote_token,dex', minAge: 120000 },
  { key: 'pools-1', path: '/networks/robinhood/pools?page=1&include=base_token,quote_token,dex', minAge: 90000 },
  { key: 'pools-2', path: '/networks/robinhood/pools?page=2&include=base_token,quote_token,dex', minAge: 180000 }
];

function mergePools(existing, incoming) {
  const map = new Map(existing.map(p => [`${p.token}:${p.pool}`, p]));
  for (const p of incoming) {
    const key = `${p.token}:${p.pool}`;
    const old = map.get(key);
    if (!old || p.volume.h1 + p.liquidity >= old.volume.h1 + old.liquidity) map.set(key, p);
  }
  return [...map.values()];
}

async function refreshGeckoEndpoint(source) {
  const payload = await gecko(source.path);
  const included = includedTokenMap(payload);
  const incoming = [];
  for (const item of payload?.data || []) {
    const p = normalizePool(item, included);
    if (p) incoming.push(p);
  }
  geckoSources.set(source.key, { at: Date.now(), pools: incoming });
  return incoming;
}

function rebuildGeckoCache() {
  let merged = [];
  for (const source of GECKO_ENDPOINTS) {
    const cached = geckoSources.get(source.key);
    if (cached?.pools?.length) merged = mergePools(merged, cached.pools);
  }
  if (merged.length) geckoCache = { at: Date.now(), pools: merged };
  return geckoCache.pools;
}

function pickGeckoSource(force = false) {
  const now = Date.now();
  const due = GECKO_ENDPOINTS.filter(source => {
    const cached = geckoSources.get(source.key);
    return force || !cached || now - cached.at >= source.minAge;
  });
  if (!due.length) return null;
  return due.sort((a, b) => {
    const ca = geckoSources.get(a.key), cb = geckoSources.get(b.key);
    const aa = ca ? now - ca.at - a.minAge : Number.MAX_SAFE_INTEGER;
    const ab = cb ? now - cb.at - b.minAge : Number.MAX_SAFE_INTEGER;
    return ab - aa;
  })[0];
}

async function refreshGeckoIncremental(force = false) {
  if (geckoRefreshInFlight || Date.now() < geckoBlockedUntil) return;
  const source = pickGeckoSource(force);
  if (!source) return;
  geckoRefreshInFlight = true;
  try { await refreshGeckoEndpoint(source); rebuildGeckoCache(); }
  catch (e) { state.warnings = [...state.warnings, e.message].slice(-10); }
  finally { geckoRefreshInFlight = false; }
}

async function loadMarketPools(force = false) {
  if (!geckoCache.pools.length) {
    await refreshGeckoIncremental(true);
    return geckoCache.pools;
  }
  void refreshGeckoIncremental(force);
  return geckoCache.pools;
}

const n = (x, k) => Number(x?.[k] || 0);
function poolAgeMs(createdAt) {
  if (!createdAt) return null;
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return null;
  const age = Date.now() - ts;
  return age >= 0 ? age : 0;
}

function scorePool(p, previousHistory = []) {
  const h1 = p.tx.h1, h24 = p.tx.h24, m5 = p.tx.m5;
  const buys = n(h1, 'buys'), sells = n(h1, 'sells'), buyers = n(h1, 'buyers'), sellers = n(h1, 'sellers');
  const total = buys + sells;
  const pressure = total ? buys / total * 100 : 50;
  const participation = Math.min(100, Math.log10(Math.max(buyers + sellers, 1)) * 22);
  const liquidityScore = Math.min(100, Math.log10(Math.max(p.liquidity, 1)) * 14);
  const volumeLiquidity = Math.min(100, p.volume.h1 / Math.max(p.liquidity, 1) * 250);
  const momentum = Math.max(0, Math.min(100, 35 + p.changes.m5 * 1.5 + p.changes.h1 * 0.55 + p.changes.h6 * 0.12 + volumeLiquidity * 0.22 + participation * 0.18));
  const balance = 100 - Math.min(100, Math.abs(buys - sells) / Math.max(total, 1) * 100);
  const organic = Math.round(Math.min(100, buyers / Math.max(buys, 1) * 100) * 0.18 + Math.min(100, sellers / Math.max(sells, 1) * 100) * 0.12 + participation * 0.22 + liquidityScore * 0.20 + balance * 0.18 + Math.min(100, Math.log10(Math.max(n(h24, 'buys') + n(h24, 'sells'), 1)) * 15) * 0.10);
  const acceleration = Math.max(0, Math.min(100, 45 + p.changes.m5 * 2.2 + (n(m5, 'buys') + n(m5, 'sells')) * 2));
  const score = Math.round(momentum * 0.42 + organic * 0.33 + acceleration * 0.25);

  const ageMs = poolAgeMs(p.createdAt);
  const ageHours = ageMs == null ? null : ageMs / (60 * 60 * 1000);
  const hasEarlyMomentum = (p.changes.h1 > 2 || p.changes.m5 > 1) && p.volume.h1 >= 100 && pressure >= 55 && total >= 3;
  const hasGrowingMomentum = (p.changes.h1 >= 3 || p.changes.h6 >= 5) && p.changes.m5 >= 0 && p.volume.h1 >= 100 && pressure >= 55;
  const hasRunningMomentum = (p.changes.h1 >= 10 || p.changes.h6 >= 20 || p.changes.m5 >= 2) && p.volume.h1 >= 500 && pressure >= 60;
  const hadPriorRun = previousHistory.some(x => ['EARLY', 'GROWING', 'RUNNING'].includes(x.stage)) || previousHistory.some(x => Number(x.score) >= 68);
  const isPullback = hadPriorRun && p.changes.h1 < -3 && p.changes.m5 < 0;

  let stage = 'STABLE';
  if (ageMs != null && ageMs <= EARLY_MAX_AGE_MS && score >= 52 && hasEarlyMomentum) stage = 'EARLY';
  else if (hasRunningMomentum && score >= 82) stage = 'RUNNING';
  else if (hasGrowingMomentum && score >= 68) stage = 'GROWING';
  else if (isPullback) stage = 'PULLBACK';

  return { marketCap: p.marketCap || p.fdv || 0, price: p.price, liquidity: p.liquidity, buys, sells, buyers, sellers, buyValue: p.volume.h1 * pressure / 100, sellValue: p.volume.h1 * (100 - pressure) / 100, pressure: Math.round(pressure), organic, momentum: Math.round(momentum), score, stage, volume1h: p.volume.h1, volume24h: p.volume.h24, change5m: p.changes.m5, change1h: p.changes.h1, change6h: p.changes.h6, change24h: p.changes.h24, age: p.createdAt, ageMs, ageHours: ageHours == null ? null : Math.round(ageHours * 100) / 100 };
}

function passesFilter(m) {
  if (m.marketCap < 10000) return false;
  if (m.liquidity < 2500) return false;
  if (m.marketCap > 0 && m.marketCap < Math.max(2500, m.liquidity * 0.35)) return false;
  if (m.buys + m.sells < 2) return false;
  if (m.volume1h < 25) return false;
  return true;
}

async function scan() {
  const latestBlockPromise = latestBlockNumber();
  const pools = await loadMarketPools();
  const byToken = new Map();
  for (const p of pools) {
    const current = byToken.get(p.token);
    if (!current || p.volume.h1 + p.liquidity > current.volume.h1 + current.liquidity) byToken.set(p.token, p);
  }
  const discovered = [...byToken.values()];
  const results = [];
  for (const p of discovered.slice(0, 120)) {
    const key = p.token.toLowerCase();
    const prev = history.get(key) || [];
    const m = scorePool(p, prev);
    if (!passesFilter(m)) continue;
    const last = prev[prev.length - 1];
    if (!last || Date.now() - last.ts >= 30000 || last.score !== m.score || last.stage !== m.stage) {
      history.set(key, [...prev, { ts: Date.now(), score: m.score, stage: m.stage }].slice(-24));
    }
    const cachedSecurity = contractCache.get(key)?.data || {};
    const cachedScout = scoutCache.get(key)?.data;
    const holderFromCache = scoutInfo(cachedScout).holders;
    const metrics = applyRisk(m, { holders: holderFromCache, ...cachedSecurity });
    results.push({ address: getAddress(p.token), name: p.name, symbol: p.symbol, image: p.image || '', ...metrics, verified: cachedSecurity.verified ?? null, contractExists: cachedSecurity.contractExists ?? null, proxy: cachedSecurity.proxy ?? null, holders: holderFromCache, pool: p.pool, dex: p.dex, history: history.get(key) || [] });
  }
  results.sort((a, b) => b.score - a.score);
  const latestBlock = await latestBlockPromise;
  state = { ...state, status: 'LIVE', lastUpdate: new Date().toISOString(), scanCycle: state.scanCycle + 1, discovered: discovered.length, analyzed: results.length, active: results.filter(x => x.stage !== 'STABLE' && x.riskLevel !== 'FLAGGED').length, flagged: results.filter(x => x.riskLevel === 'FLAGGED').length, latestBlock, uptime: Math.floor((Date.now() - started) / 1000), errors: 0 };
  radar = results;
  void enrichRadar(results);
  console.log(`[scan] cycle=${state.scanCycle} pools=${pools.length} discovered=${discovered.length} candidates=${results.length} flagged=${state.flagged} top=${results[0]?.symbol || 'none'}`);
}

async function safeScan() {
  if (scanning) return;
  scanning = true;
  try { await scan(); }
  catch (e) {
    state = { ...state, status: 'DEGRADED', errors: state.errors + 1, warnings: [...state.warnings, e.message].slice(-10), uptime: Math.floor((Date.now() - started) / 1000) };
    console.error(`[scan:error] ${e.message}`);
  }
  finally { scanning = false; }
}

const app = express();
app.use(express.json());
app.get('/health', (req, res) => res.json({ ok: true, chainId: 4663, status: state.status, latestBlock: state.latestBlock, uptime: state.uptime }));
app.get('/api/status', (req, res) => res.json(state));
app.get('/api/radar', (req, res) => res.json(radar));
app.get('/api/market-debug', (req, res) => res.json({ status: state.status, pools: geckoCache.pools.length, radar: radar.length, geckoCooldown: Math.max(0, geckoBlockedUntil - Date.now()), geckoRefreshInFlight, sources: Object.fromEntries(GECKO_ENDPOINTS.map(x => [x.key, { at: geckoSources.get(x.key)?.at || 0, pools: geckoSources.get(x.key)?.pools?.length || 0, age: geckoSources.has(x.key) ? Date.now() - geckoSources.get(x.key).at : null }])), warnings: state.warnings, sample: geckoCache.pools.slice(0, 10) }));
app.get('/api/token/:address', async (req, res) => {
  try {
    const address = getAddress(req.params.address);
    const meta = await tokenMeta(address);
    const [scout, contract] = await Promise.all([blockscoutToken(address), blockscoutContract(address)]);
    const info = scoutInfo(scout);
    let holders = info.holders;
    if (holders == null) {
      const counters = await blockscoutCounters(address);
      const n = Number(counters?.token_holders_count);
      if (Number.isFinite(n)) holders = n;
    }
    const cachedRadar = radar.find(x => x.address.toLowerCase() === address.toLowerCase());
    if (cachedRadar && cachedRadar.pool) return res.json({ ...meta, ...cachedRadar, holders: holders ?? cachedRadar.holders ?? null, verified: contract?.verified ?? cachedRadar.verified ?? null, contractExists: contract?.contractExists ?? cachedRadar.contractExists ?? null, proxy: contract?.proxy ?? cachedRadar.proxy ?? null, image: info.image || cachedRadar.image || '' });
    let pools = null;
    try { pools = await gecko(`/networks/robinhood/tokens/${address}/pools?include=base_token,quote_token,dex`); } catch { pools = null; }
    const normalized = pools ? (pools?.data || []).map(x => normalizePool(x, includedTokenMap(pools))).filter(Boolean).slice(0, 10) : [];
    if (!normalized.length) return res.json({ ...meta, marketCap: Number(scout?.market_cap || scout?.circulating_market_cap || 0), holders, verified: contract?.verified ?? null, contractExists: contract?.contractExists ?? null, proxy: contract?.proxy ?? null, image: info.image, score: 0, organic: 0, momentum: 0, stage: 'STABLE', risk: 100, riskLevel: 'REVIEW', riskFlags: ['No active market pool found'], history: history.get(address.toLowerCase()) || [] });
    const best = normalized.sort((a, b) => b.volume.h1 + b.liquidity - (a.volume.h1 + a.liquidity))[0];
    const key = address.toLowerCase();
    const metrics = applyRisk(scorePool(best, history.get(key) || []), { holders, ...contract });
    history.set(key, [...(history.get(key) || []), { ts: Date.now(), score: metrics.score, stage: metrics.stage }].slice(-24));
    res.json({ ...meta, ...metrics, holders, verified: contract?.verified ?? null, contractExists: contract?.contractExists ?? null, proxy: contract?.proxy ?? null, image: info.image || best.image || '', pool: best.pool, dex: best.dex, history: history.get(key) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/rpc', (req, res) => res.json({ chainId: 4663, rpcCount: RPC_URLS.length, rpcs: RPC_URLS.map((url, i) => ({ index: i + 1, url, role: i === 0 ? 'primary' : 'fallback' })), multicall3: MULTICALL3, blockscout: BLOCKSCOUT, marketData: 'GeckoTerminal' }));
app.use(express.static(path.join(ROOT, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RunnerHunter listening on 0.0.0.0:${PORT}`);
  safeScan();
  setInterval(safeScan, 30000);
});