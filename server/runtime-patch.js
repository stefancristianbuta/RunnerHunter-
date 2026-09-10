import express from 'express';
import { JsonRpcProvider } from 'ethers';
import { publishEligibleRunner, xStatus } from './x.js';
import { installXOauth } from './x-oauth.js';

const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeGetBlockNumber = JsonRpcProvider.prototype.getBlockNumber;
const nativeFetch = globalThis.fetch.bind(globalThis);
const holderCache = new Map();
const HOLDER_CACHE_MS = 10 * 60 * 1000;

// Keep the non-critical latest-block telemetry from blocking a scan when an RPC is unhealthy.
JsonRpcProvider.prototype.getBlockNumber = function (...args) {
  return Promise.race([
    nativeGetBlockNumber.apply(this, args),
    new Promise((_, reject) => setTimeout(() => reject(new Error('RPC getBlockNumber timeout')), 3000))
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

// The Robinhood Blockscout API is currently returning HTTP 403 from the runtime.
// Intercept token enrichment and provide holder_count from a public Robinhood explorer
// instead, so holder data remains available and 403s never enter scanner warnings.
const wrappedFetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const tokenMatch = url.match(/https?:\/\/[^/]+\/api\/v2\/tokens\/(0x[a-fA-F0-9]{40})(?:\/(counters))?$/);
  if (tokenMatch) {
    const address = tokenMatch[1];
    const count = await holderFallback(address);
    if (tokenMatch[2] === 'counters') return jsonResponse({ token_holders_count: count });
    return jsonResponse({ holders_count: count, holder_count: count, token_holders_count: count, icon_url: '' });
  }
  return nativeFetch(input, init);
};

globalThis.fetch = wrappedFetch;

// The market scanner was designed around a 30s loop. Run it at 10s so fresh momentum
// is not stale while leaving unrelated timers untouched.
globalThis.setInterval = (fn, delay, ...args) =>
  nativeSetInterval(fn, delay === 30000 ? 10000 : delay, ...args);

// Install the OAuth routes immediately before Express starts listening. The installer
// moves them ahead of the SPA catch-all so /auth/x/* is never swallowed by index.html.
const nativeListen = express.application.listen;
express.application.listen = function (...args) {
  installXOauth(this);
  return nativeListen.apply(this, args);
};

// X publishing is deliberately isolated from the radar engine. It polls the public
// radar endpoint and only posts when server-side X gates in x.js all pass.
async function pollXPublisher() {
  if (!process.env.X_ACCESS_TOKEN) return;
  try {
    const port = Number(process.env.PORT || 8080);
    const response = await nativeFetch(`http://127.0.0.1:${port}/api/radar`, {
      signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return;
    const radar = await response.json();
    for (const item of Array.isArray(radar) ? radar : []) {
      const result = await publishEligibleRunner(item);
      if (result.posted) break;
    }
  } catch (error) {
    console.error(`[x-publisher:error] ${error.message}`);
  }
}

nativeSetInterval(pollXPublisher, 15000);
setTimeout(pollXPublisher, 12000);

console.log(`[runtime-patch] holder fallback enabled + Blockscout 403 suppressed + 30s->10s scan interval + X ${xStatus().configured ? 'configured' : 'disabled'} + OAuth PKCE ready`);
