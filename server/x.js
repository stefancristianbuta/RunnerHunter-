const X_POST_URL = 'https://api.x.com/2/tweets';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const MIN_SCORE = Number(process.env.X_MIN_SCORE || 80);
const TOKEN_COOLDOWN_MS = Number(process.env.X_TOKEN_COOLDOWN_MS || 2 * 60 * 60 * 1000);
const GLOBAL_COOLDOWN_MS = Number(process.env.X_GLOBAL_COOLDOWN_MS || 10 * 60 * 1000);
const MAX_POSTS_PER_DAY = Number(process.env.X_MAX_POSTS_PER_DAY || 12);

let lastPostAt = 0;
let postTimes = [];
const tokenPosts = new Map();
let accessToken = process.env.X_ACCESS_TOKEN || '';
let refreshToken = process.env.X_REFRESH_TOKEN || '';
let refreshInFlight = null;

function configured() {
  return Boolean(accessToken);
}

function compactMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '$0';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
  return `$${Math.round(n)}`;
}

function cleanSymbol(symbol) {
  const value = String(symbol || '?').trim().replace(/\s+/g, ' ');
  return value.startsWith('$') ? value : `$${value}`;
}

function eligible(item) {
  if (!item || !configured()) return false;
  if (Number(item.score || 0) < MIN_SCORE) return false;
  if (!['EARLY', 'GROWING', 'RUNNING'].includes(item.stage)) return false;
  if (item.riskLevel !== 'CLEAR') return false;

  const input = item.stageSignals?.inputs || {};
  const m15 = Number(input.m15 || 0);
  const m30 = Number(input.m30 || 0);
  const m15Trades = Number(input.m15Trades || 0);
  const m30Trades = Number(input.m30Trades || 0);
  const m15Pressure = Number(input.m15Pressure || 0);
  const m30Pressure = Number(input.m30Pressure || 0);

  const confirmed15 = m15Trades >= 2 && (m15 >= -1 || m15Pressure >= 52);
  const confirmed30 = m30Trades >= 2 && (m30 >= -1 || m30Pressure >= 52);
  if (!confirmed15 || !confirmed30) return false;

  const now = Date.now();
  const previous = tokenPosts.get(String(item.address || '').toLowerCase()) || 0;
  if (now - previous < TOKEN_COOLDOWN_MS) return false;
  if (now - lastPostAt < GLOBAL_COOLDOWN_MS) return false;

  postTimes = postTimes.filter(ts => now - ts < 24 * 60 * 60 * 1000);
  if (postTimes.length >= MAX_POSTS_PER_DAY) return false;
  return true;
}

function formatPost(item) {
  return [
    `🚀 RunnerHunter detected ${cleanSymbol(item.symbol)} on Robinhood Chain`,
    '',
    `Score: ${Math.round(Number(item.score || 0))}/100`,
    `Stage: ${item.stage}`,
    `Momentum: ${Number(item.change1h || 0).toFixed(1)}%`,
    `Liquidity: ${compactMoney(item.liquidity)}`,
    `Volume 1H: ${compactMoney(item.volume1h)}`,
    'Detection only.',
    '',
    `CA: ${item.address}`
  ].join('\n');
}

async function refreshAccessToken() {
  if (!refreshToken || !process.env.X_CLIENT_ID || !process.env.X_CLIENT_SECRET) {
    throw new Error('X OAuth refresh is not configured');
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const clientId = process.env.X_CLIENT_ID;
    const basic = Buffer.from(`${clientId}:${process.env.X_CLIENT_SECRET}`).toString('base64');
    const response = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`X OAuth refresh ${response.status}: ${body.slice(0, 300)}`);
    const data = JSON.parse(body);
    if (!data.access_token) throw new Error('X OAuth refresh returned no access token');
    accessToken = data.access_token;
    if (data.refresh_token) refreshToken = data.refresh_token;
    console.log('[x] OAuth access token refreshed');
    return accessToken;
  })().finally(() => { refreshInFlight = null; });

  return refreshInFlight;
}

async function postToX(text, retry = true) {
  const response = await fetch(X_POST_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000)
  });

  if ((response.status === 401 || response.status === 403) && retry && refreshToken) {
    const body = await response.text();
    if (response.status === 403 && !/Unsupported Authentication|Application-Only/i.test(body)) {
      throw new Error(`X API ${response.status}: ${body.slice(0, 300)}`);
    }
    await refreshAccessToken();
    return postToX(text, false);
  }

  const body = await response.text();
  if (!response.ok) throw new Error(`X API ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

export async function publishEligibleRunner(item) {
  if (!eligible(item)) return { posted: false, reason: 'not-eligible' };

  const text = formatPost(item);
  if (text.length > 280) return { posted: false, reason: 'post-too-long' };

  try {
    const result = await postToX(text);
    const now = Date.now();
    const key = String(item.address).toLowerCase();
    tokenPosts.set(key, now);
    lastPostAt = now;
    postTimes.push(now);
    console.log(`[x] posted ${item.symbol} score=${item.score} stage=${item.stage} id=${result?.data?.id || 'unknown'}`);
    return { posted: true, id: result?.data?.id || null };
  } catch (error) {
    console.error(`[x:error] ${error.message}`);
    return { posted: false, reason: 'api-error' };
  }
}

export function xStatus() {
  const now = Date.now();
  postTimes = postTimes.filter(ts => now - ts < 24 * 60 * 60 * 1000);
  return {
    configured: configured(),
    refreshConfigured: Boolean(refreshToken && process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET),
    minScore: MIN_SCORE,
    tokenCooldownHours: Math.round(TOKEN_COOLDOWN_MS / 3600000),
    globalCooldownMinutes: Math.round(GLOBAL_COOLDOWN_MS / 60000),
    postsLast24h: postTimes.length,
    maxPostsPerDay: MAX_POSTS_PER_DAY,
    lastPostAt: lastPostAt ? new Date(lastPostAt).toISOString() : null
  };
}
