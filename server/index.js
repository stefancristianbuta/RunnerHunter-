import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { JsonRpcProvider, Contract, Interface, getAddress } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 10000);
const RPC_URL = process.env.RH_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const BLOCKSCOUT = process.env.BLOCKSCOUT_URL || 'https://robinhoodchain.blockscout.com/api/v2';
const GECKO = 'https://api.geckoterminal.com/api/v2';
const provider = new JsonRpcProvider(RPC_URL, 4663, { staticNetwork: true });

const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'.toLowerCase();
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'.toLowerCase();
const STABLE = new Set(['WETH', 'USDG', 'USDC', 'USDT', 'DAI', 'USDE']);
const erc20 = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)'
]);

const metaCache = new Map();
const scoutCache = new Map();
const history = new Map();
let radar = [];
let geckoCache = { at: 0, pools: [] };
let scanning = false;
const started = Date.now();
let state = {
  status: 'STARTING', lastUpdate: null, scanCycle: 0, discovered: 0,
  analyzed: 0, active: 0, errors: 0, warnings: [], latestBlock: null,
  uptime: 0, source: 'GeckoTerminal + Robinhood RPC + Blockscout'
};

async function tokenMeta(address) {
  const key = address.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key);
  const call = async (method, fallback) => { try { return await new Contract(address, erc20, provider)[method](); } catch { return fallback; } };
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    call('name', 'Unknown'), call('symbol', '?'), call('decimals', 18), call('totalSupply', 0n)
  ]);
  const meta = { address: getAddress(address), name: String(name || 'Unknown'), symbol: String(symbol || '?'), decimals: Number(decimals || 18), totalSupply: String(totalSupply || 0n) };
  metaCache.set(key, meta);
  return meta;
}

async function blockscoutToken(address) {
  const key = address.toLowerCase();
  const cached = scoutCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;
  try {
    const r = await fetch(`${BLOCKSCOUT}/tokens/${address}`, { signal: AbortSignal.timeout(7000), headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`Blockscout ${r.status}`);
    const data = await r.json();
    scoutCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (cached) return cached.data;
    scoutCache.set(key, { at: Date.now(), data: null });
    return null;
  }
}

function scoutInfo(scout) {
  if (!scout) return { holders: null, image: '' };
  const rawHolders = scout.holders ?? scout.holder_count ?? scout.holders_count ?? scout.token_holders_count;
  const holders = rawHolders == null ? null : Number(rawHolders);
  const image = scout.icon_url || scout.image_url || scout.metadata?.logo || scout.metadata?.image || '';
  return { holders: Number.isFinite(holders) && holders >= 0 ? holders : null, image: typeof image === 'string' ? image : '' };
}

async function enrichRadar(results) {
  const targets = results.slice(0, 30);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(5, targets.length) }, async () => {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      const scout = await blockscoutToken(item.address);
      const info = scoutInfo(scout);
      item.holders = info.holders;
      item.image = info.image;
    }
  });
  await Promise.all(workers);
  return results;
}

let geckoNextAllowedAt = 0;
let geckoBlockedUntil = 0;
let geckoQueue = Promise.resolve();

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function gecko(pathname) {
  const run = async () => {
    const now = Date.now();
    if (now < geckoBlockedUntil) throw new Error('GeckoTerminal rate-limit cooldown');
    const delay = Math.max(0, geckoNextAllowedAt - Date.now());
    if (delay) await wait(delay);
    geckoNextAllowedAt = Date.now() + 6500;
    const r = await fetch(`${GECKO}${pathname}`, {
      headers: { accept: 'application/json;version=20230203' },
      signal: AbortSignal.timeout(8000)
    });
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
  const tx = a.transactions || {};
  const pc = a.price_change_percentage || {};
  const vol = a.volume_usd || {};
  return {
    pool: String(a.address || '').toLowerCase(), dex: rel.dex?.data?.id || 'unknown',
    token: token.address.toLowerCase(), name: token.name || 'Unknown', symbol: token.symbol || '?',
    price: Number(a.base_token_price_usd || a.token_price_usd || 0),
    marketCap: Number(a.market_cap_usd || 0), fdv: Number(a.fdv_usd || 0),
    liquidity: Number(a.reserve_in_usd || 0),
    changes: { m5: Number(pc.m5 || 0), h1: Number(pc.h1 || 0), h6: Number(pc.h6 || 0), h24: Number(pc.h24 || 0) },
    tx: { m5: tx.m5 || {}, h1: tx.h1 || {}, h6: tx.h6 || {}, h24: tx.h24 || {} },
    volume: { m5: Number(vol.m5 || 0), h1: Number(vol.h1 || 0), h6: Number(vol.h6 || 0), h24: Number(vol.h24 || 0) },
    createdAt: a.pool_created_at || null
  };
}

async function loadMarketPools(force = false) {
  if (!force && Date.now() - geckoCache.at < 45000 && geckoCache.pools.length) return geckoCache.pools;
  if (Date.now() < geckoBlockedUntil && geckoCache.pools.length) return geckoCache.pools;
  const all = [], warnings = [];
  const endpoints = [
    '/networks/robinhood/new_pools?include=base_token,quote_token,dex',
    '/networks/robinhood/trending_pools?include=base_token,quote_token,dex',
    '/networks/robinhood/pools?include=base_token,quote_token,dex'
  ];
  for (const endpoint of endpoints) {
    try {
      const payload = await gecko(endpoint);
      const included = includedTokenMap(payload);
      for (const item of payload?.data || []) {
        const p = normalizePool(item, included);
        if (p) all.push(p);
      }
    } catch (e) {
      warnings.push(e.message);
      if (String(e.message).includes('cooldown')) break;
    }
  }
  const dedup = new Map();
  for (const p of all) {
    const key = `${p.token}:${p.pool}`;
    const old = dedup.get(key);
    if (!old || p.volume.h1 + p.liquidity > old.volume.h1 + old.liquidity) dedup.set(key, p);
  }
  const freshPools = [...dedup.values()];
  if (freshPools.length > 0) geckoCache = { at: Date.now(), pools: freshPools };
  else if (geckoCache.pools.length > 0) warnings.push('GeckoTerminal unavailable; retaining last valid snapshot');
  else geckoCache = { at: Date.now(), pools: [] };
  if (warnings.length) state.warnings = [...state.warnings, ...warnings].slice(-10);
  return geckoCache.pools;
}

const n = (x, k) => Number(x?.[k] || 0);

function scorePool(p) {
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
  let stage = score >= 82 ? 'RUNNING' : score >= 68 ? 'GROWING' : score >= 52 ? 'EARLY' : 'PULLBACK';
  if (p.changes.h1 < -8 && p.changes.m5 < 0) stage = 'PULLBACK';
  return { marketCap: p.marketCap || p.fdv || 0, price: p.price, liquidity: p.liquidity, buys, sells, buyers, sellers, buyValue: p.volume.h1 * pressure / 100, sellValue: p.volume.h1 * (100 - pressure) / 100, pressure: Math.round(pressure), organic, momentum: Math.round(momentum), score, stage, volume1h: p.volume.h1, volume24h: p.volume.h24, change5m: p.changes.m5, change1h: p.changes.h1, change6h: p.changes.h6, change24h: p.changes.h24, age: p.createdAt };
}

function passesFilter(m) {
  if (m.liquidity < 2500) return false;
  if (m.marketCap > 0 && m.marketCap < Math.max(2500, m.liquidity * 0.35)) return false;
  if (m.buys + m.sells < 2) return false;
  if (m.volume1h < 25) return false;
  return true;
}

async function scan() {
  const pools = await loadMarketPools();
  const byToken = new Map();
  for (const p of pools) {
    const current = byToken.get(p.token);
    if (!current || p.volume.h1 + p.liquidity > current.volume.h1 + current.liquidity) byToken.set(p.token, p);
  }
  const discovered = [...byToken.values()];
  const results = [];
  for (const p of discovered.slice(0, 120)) {
    const m = scorePool(p);
    if (!passesFilter(m)) continue;
    const key = p.token.toLowerCase();
    const prev = history.get(key) || [];
    const nextHistory = [...prev, { ts: Date.now(), score: m.score }].slice(-24);
    history.set(key, nextHistory);
    results.push({ address: getAddress(p.token), name: p.name, symbol: p.symbol, ...m, pool: p.pool, dex: p.dex, history: nextHistory });
  }
  results.sort((a, b) => b.score - a.score);
  await enrichRadar(results);
  let latestBlock = null;
  try { latestBlock = await provider.getBlockNumber(); } catch (e) { state.warnings = [...state.warnings, `RPC: ${e.message}`].slice(-10); }
  state = { ...state, status: 'LIVE', lastUpdate: new Date().toISOString(), scanCycle: state.scanCycle + 1, discovered: discovered.length, analyzed: results.length, active: results.filter(x => x.score >= 52).length, latestBlock, uptime: Math.floor((Date.now() - started) / 1000), errors: 0 };
  radar = results;
  console.log(`[scan] cycle=${state.scanCycle} pools=${pools.length} discovered=${discovered.length} candidates=${results.length} top=${results[0]?.symbol || 'none'}`);
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
app.get('/api/market-debug', (req, res) => res.json({ status: state.status, pools: geckoCache.pools.length, radar: radar.length, geckoCooldown: Math.max(0, geckoBlockedUntil - Date.now()), warnings: state.warnings, sample: geckoCache.pools.slice(0, 10) }));
app.get('/api/token/:address', async (req, res) => {
  try {
    const address = getAddress(req.params.address);
    const meta = await tokenMeta(address);
    const scout = await blockscoutToken(address);
    const info = scoutInfo(scout);
    const cachedRadar = radar.find(x => x.address.toLowerCase() === address.toLowerCase());
    if (cachedRadar && cachedRadar.pool) return res.json({ ...meta, ...cachedRadar, holders: info.holders ?? cachedRadar.holders ?? null, image: info.image || cachedRadar.image || '' });
    let pools = null;
    try { pools = await gecko(`/networks/robinhood/tokens/${address}/pools?include=base_token,quote_token,dex`); } catch { pools = null; }
    const normalized = pools ? (pools?.data || []).map(x => normalizePool(x, includedTokenMap(pools))).filter(Boolean).slice(0, 10) : [];
    if (!normalized.length) return res.json({ ...meta, marketCap: Number(scout?.market_cap || scout?.circulating_market_cap || 0), holders: info.holders, image: info.image, score: 0, organic: 0, momentum: 0, stage: 'EARLY', history: history.get(address.toLowerCase()) || [] });
    const best = normalized.sort((a, b) => b.volume.h1 + b.liquidity - (a.volume.h1 + a.liquidity))[0];
    const metrics = scorePool(best);
    const key = address.toLowerCase();
    history.set(key, [...(history.get(key) || []), { ts: Date.now(), score: metrics.score }].slice(-24));
    res.json({ ...meta, ...metrics, holders: info.holders, image: info.image, pool: best.pool, dex: best.dex, history: history.get(key) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/rpc', (req, res) => res.json({ chainId: 4663, rpc: process.env.RH_RPC_URL ? 'configured' : 'public fallback', publicFallback: !process.env.RH_RPC_URL, blockscout: BLOCKSCOUT, marketData: 'GeckoTerminal' }));
app.use(express.static(path.join(ROOT, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(ROOT, 'dist', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RunnerHunter listening on 0.0.0.0:${PORT}`);
  safeScan();
  setInterval(safeScan, 30000);
});
