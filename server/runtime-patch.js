const nativeFetch = globalThis.fetch.bind(globalThis);
const BS = 'https://robinhoodchain.blockscout.com';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function holderFromHtml(html) {
  const patterns = [
    /Holders\s*<[^>]*>\s*([0-9][0-9,]*)/i,
    /Holders\s+([0-9][0-9,]*)/i,
    /"holders_count"\s*:\s*"?([0-9]+)"?/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = Number(String(m[1]).replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function imageFromHtml(html) {
  const patterns = [
    /property=["']og:image["'][^>]+content=["']([^"']+)/i,
    /content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /"icon_url"\s*:\s*"([^"]+)/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return '';
}

async function blockscoutHtml(address) {
  try {
    const r = await nativeFetch(`${BS}/token/${address}`, {
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(12000)
    });
    if (!r.ok) return { holders: null, image: '' };
    const html = await r.text();
    return { holders: holderFromHtml(html), image: imageFromHtml(html) };
  } catch {
    return { holders: null, image: '' };
  }
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
      const known = counters ? Number(data?.token_holders_count) : Number(data?.holders_count ?? data?.holders ?? data?.holder_count ?? data?.token_holders_count);
      if (Number.isFinite(known)) return r;
      const extra = await blockscoutHtml(address);
      if (extra.holders != null || extra.image) {
        const merged = counters
          ? { ...data, ...(extra.holders != null ? { token_holders_count: String(extra.holders) } : {}) }
          : { ...data, ...(extra.holders != null ? { holders_count: String(extra.holders) } : {}), ...(extra.image ? { icon_url: extra.image } : {}) };
        return jsonResponse(merged);
      }
      return r;
    }
  } catch {}

  const extra = await blockscoutHtml(address);
  if (counters && extra.holders != null) return jsonResponse({ token_holders_count: String(extra.holders) });
  if (!counters && (extra.holders != null || extra.image)) {
    return jsonResponse({ holders_count: String(extra.holders ?? ''), icon_url: extra.image || '' });
  }
  return new Response('', { status: 503, headers: { 'content-type': 'application/json' } });
};

console.log('[runtime-patch] Blockscout enrichment fallback enabled');
