import express from 'express';
import { JsonRpcProvider } from 'ethers';
import { publishEligibleRunner, xStatus } from './x.js';
import { installXOauth } from './x-oauth.js';
import { recordTelemetry, telemetrySnapshot } from './telemetry.js';

const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeGetBlockNumber = JsonRpcProvider.prototype.getBlockNumber;
const nativeFetch = globalThis.fetch.bind(globalThis);
const holderCache = new Map();
const HOLDER_CACHE_MS = 10 * 60 * 1000;
const FALLBACK_LOGO_BASE = 'https://dd.dexscreener.com/ds-data/tokens/robinhood';

JsonRpcProvider.prototype.getBlockNumber = function (...args) {
  return Promise.race([
    nativeGetBlockNumber.apply(this, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error('RPC getBlockNumber timeout')), 5000))
  ]);
};

function parseCompactCount(value) {
  const m = String(value || '').trim().replace(/,/g, '').match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmb])?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const multiplier = ({ k: 1e3, m: 1e6, b: 1e9 })[String(m[2] || '').toLowerCase()] || 1;
  return Math.round(n * multiplier);
}

function parseHolderCount(html) {
  const source = String(html || '');
  const structured = [
    /["']holders(?:_count)?["']\s*:\s*["']?([0-9][0-9.,]*\s*[kmb]?)/i,
    /["']holder_count["']\s*[:=]\s*["']?([0-9][0-9.,]*\s*[kmb]?)/i
  ];
  for (const pattern of structured) {
    const match = source.match(pattern);
    const count = parseCompactCount(match?.[1]);
    if (count != null) return count;
  }
  const visible = source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ');
  const match = visible.match(/\bholders\b\s*([0-9][0-9.,]*\s*[kmb]?)/i);
  return parseCompactCount(match?.[1]);
}

async function holderFallback(address) {
  const key = String(address || '').toLowerCase();
  const cached = holderCache.get(key);
  if (cached && Date.now() - cached.at < HOLDER_CACHE_MS) return cached.count;
  try {
    const response = await nativeFetch(`https://stonkscan.io/token/${address}?tab=holders`, {
      signal: AbortSignal.timeout(5000),
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'Mozilla/5.0 (compatible; RunnerHunter/1.0)'
      }
    });
    if (!response.ok) throw new Error(`StonkScan ${response.status}`);
    const html = await response.text();
    const count = parseHolderCount(html);
    holderCache.set(key, { at: Date.now(), count });
    return count;
  } catch {
    holderCache.set(key, { at: Date.now(), count: null });
    return null;
  }
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function fallbackLogo(address) {
  const value = String(address || '').toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(value) ? `${FALLBACK_LOGO_BASE}/${value}.png` : '';
}

async function blockscoutTokenResponse(input, address) {
  try {
    const response = await nativeFetch(input, {
      signal: AbortSignal.timeout(4500),
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

const wrappedFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const tokenMatch = url.match(/https?:\/\/[^/]+\/api\/v2\/tokens\/(0x[a-fA-F0-9]{40})(?:\/(counters))?$/);
  if (tokenMatch) {
    const address = tokenMatch[1];
    const count = await holderFallback(address);
    if (tokenMatch[2] === 'counters') return jsonResponse({ token_holders_count: count });
    const scout = await blockscoutTokenResponse(input, address);
    return jsonResponse({
      ...(scout || {}),
      holders_count: count ?? scout?.holders_count ?? scout?.holder_count ?? scout?.token_holders_count ?? null,
      holder_count: count ?? scout?.holder_count ?? scout?.holders_count ?? scout?.token_holders_count ?? null,
      token_holders_count: count ?? scout?.token_holders_count ?? scout?.holders_count ?? scout?.holder_count ?? null,
      icon_url: scout?.icon_url || scout?.image_url || scout?.metadata?.logo || scout?.metadata?.image || ''
    });
  }
  if (/https?:\/\/[^/]+\/api\/radar(?:\?.*)?$/.test(url)) {
    const response = await nativeFetch(input, init);
    if (!response.ok) return response;
    try {
      const data = await response.json();
      if (!Array.isArray(data)) return jsonResponse(data);
      const enriched = data.map(item => {
        if (!item || typeof item !== 'object') return item;
        const image = String(item.image || '').trim();
        return image ? item : { ...item, image: fallbackLogo(item.address) };
      });
      return jsonResponse(enriched);
    } catch {
      return response;
    }
  }
  return nativeFetch(input, init);
};

globalThis.fetch = wrappedFetch;

globalThis.setInterval = (fn, delay, ...args) =>
  nativeSetInterval(fn, delay === 30000 ? 10000 : delay, ...args);

const nativeListen = express.application.listen;
express.application.listen = function (...args) {
  installXOauth(this);
  this.get('/api/telemetry', (req, res) => {
    try {
      const token = typeof req.query?.token === 'string' ? req.query.token : '';
      res.json(telemetrySnapshot(token));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  return nativeListen.apply(this, args);
};

async function pollXPublisher() {
  try {
    const port = Number(process.env.PORT || 8080);
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/radar`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return;
    const radar = await response.json();
    for (const item of Array.isArray(radar) ? radar : []) {
      recordTelemetry({
        cycle: item.cycle,
        outcome: 'CANDIDATE',
        token: item.address,
        symbol: item.symbol,
        name: item.name,
        address: item.address,
        score: item.score,
        stage: item.stage,
        previousStage: item.history?.at(-2)?.stage || null,
        stageReason: item.stageReason,
        filterReasons: [],
        risk: item.risk,
        riskLevel: item.riskLevel,
        riskFlags: item.riskFlags,
        marketCap: item.marketCap,
        liquidity: item.liquidity,
        volume1h: item.volume1h,
        pressure: item.pressure,
        buys: item.buys,
        sells: item.sells,
        ageMs: item.ageMs,
        change5m: item.change5m,
        change15m: item.change15m,
        change30m: item.change30m,
        change1h: item.change1h,
        change6h: item.change6h,
        dexCount: item.dexCount,
        poolCount: item.poolCount,
        stageSignals: item.stageSignals,
        transition: item.history?.at(-2)?.stage !== item.stage
      });
      if (process.env.X_ACCESS_TOKEN) {
        const result = await publishEligibleRunner(item);
        if (result.posted) break;
      }
    }
  } catch (error) {
    console.error(`[x-publisher:error] ${error.message}`);
  }
}

nativeSetInterval(pollXPublisher, 15000);
setTimeout(pollXPublisher, 12000);

console.log(`[runtime-patch] holder fallback enabled + Blockscout 403 suppressed + 30s->10s scan interval + telemetry tracking/dashboard + X ${xStatus().configured ? 'configured' : 'disabled'} + OAuth PKCE ready`);
