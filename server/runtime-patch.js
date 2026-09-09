const nativeFetch = globalThis.fetch.bind(globalThis);
const BS = 'https://robinhoodchain.blockscout.com';
const ROBINSCAN = 'https://robinscan.io';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function finiteHolder(value) {
  const n = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function holderFromText(text) {
  const compact = String(text || '').replace(/\s+/g, ' ');
  const patterns = [
    /\bHolders\s*[:|]?\s*([0-9][0-9,]*(?:\.\d+)?)(?:\s|<|$)/i,
    /\bholders_count\b\s*[:=]\s*["']?([0-9][0-9,]*)/i,
    /\btoken_holders_count\b\s*[:=]\s*["']?([0-9][0-9,]*)/i,
    /\b([0-9][0-9,]*)\s+total\b/i
  ];
  for (const re of patterns) {
    const m = compact.match(re);
    const n = finiteHolder(m?.[1]);
    if (n != null) return n;
  }
  return null;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2C;/gi, ',')
    .replace(/&#44;/g, ',');
}

async function fetchHtml(url) {
  const r = await nativeFetch(url, {
    headers: { accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) return null;
  return await r.text();
}

async function explorerFallback(address) {
  const urls = [
    `${BS}/token/${address}`,
    `${ROBINSCAN}/token/${address}`
  ];
  let zero = null;
  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      if (!html) continue;
      const holders = holderFromText(htmlToText(html));
      if (holders == null) continue;
      if (holders > 0) return { holders, source: url };
      zero = zero ?? { holders: 0, source: url };
    } catch {}
  }
  return zero || { holders: null, source: '' };
}

async function fallbackData(address) {
  const extra = await explorerFallback(address);
  if (extra.holders != null) {
    console.log(`[holders] ${address}=${extra.holders} source=${extra.source}`);
  }
  return extra;
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const m = url.match(/^https:\/\/robinhoodchain\.blockscout\.com\/api\/v2\/tokens\/(0x[a-fA-F0-9]{40})(\/counters)?(?:\?.*)?$/);
  if (!m) return nativeFetch(input, init);

  const address = m[1];
  const counters = Boolean(m[2]);
  const safeInit = { ...init, signal: AbortSignal.timeout(12000) };

  try {
    const r = await nativeFetch(url, safeInit);
    if (r.ok) {
      const data = await r.clone().json();
      const known = counters
        ? finiteHolder(data?.token_holders_count)
        : finiteHolder(data?.holders_count ?? data?.holders ?? data?.holder_count ?? data?.token_holders_count);
      if (known != null && known > 0) return r;
      const extra = await fallbackData(address);
      if (extra.holders != null && extra.holders > 0) {
        const merged = counters
          ? { ...data, token_holders_count: String(extra.holders) }
          : { ...data, holders_count: String(extra.holders) };
        return jsonResponse(merged);
      }
      return r;
    }
  } catch (e) {
    console.warn(`[holders] Blockscout request failed for ${address}: ${e.message}`);
  }

  const extra = await fallbackData(address);
  if (counters && extra.holders != null) return jsonResponse({ token_holders_count: String(extra.holders) });
  if (!counters && extra.holders != null) return jsonResponse({ holders_count: String(extra.holders) });
  return new Response('', { status: 503, headers: { 'content-type': 'application/json' } });
};

console.log('[runtime-patch] Blockscout holder provider enabled: native -> Blockscout page -> Robinscan, positive fallback, logos untouched');
