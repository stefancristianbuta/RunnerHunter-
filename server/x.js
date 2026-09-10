const X_POST_URL = 'https://api.x.com/2/tweets';
const MIN_SCORE = Number(process.env.X_MIN_SCORE || 90);
const TOKEN_COOLDOWN_MS = Number(process.env.X_TOKEN_COOLDOWN_MS || 12 * 60 * 60 * 1000);
const GLOBAL_COOLDOWN_MS = Number(process.env.X_GLOBAL_COOLDOWN_MS || 30 * 60 * 1000);
const MAX_POSTS_PER_DAY = Number(process.env.X_MAX_POSTS_PER_DAY || 6);

let lastPostAt = 0;
let postTimes = [];
const tokenPosts = new Map();
let accessToken = process.env.X_ACCESS_TOKEN || '';

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
  if (!['EARLY', 'GROWING'].includes(item.stage)) return false;
  if (item.riskLevel !== 'CLEAR') return false;

  const s = item.stageSignals;
  const input = s?.inputs || {};
  const m15 = Number(input.m15 || 0);
  const m30 = Number(input.m30 || 0);
  const m15Trades = Number(input.m15Trades || 0);
  const m30Trades = Number(input.m30Trades || 0);
  const m15Pressure = Number(input.m15Pressure || 0);
  const m30Pressure = Number(input.m30Pressure || 0);

  const confirmed15 = m15Trades >= 3 && (m15 >= 0 || m15Pressure >= 55);
  const confirmed30 = m30Trades >= 4 && (m30 >= 0 || m30Pressure >= 55);
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
    '',
    `CA: ${item.address}`
  ].join('\n');
}

async function postToX(text) {
  const response = await fetch(X_POST_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(8000)
  });

  if (response.status === 401) {
    throw new Error('X API 401: X_ACCESS_TOKEN is invalid or expired');
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
    minScore: MIN_SCORE,
    tokenCooldownHours: Math.round(TOKEN_COOLDOWN_MS / 3600000),
    globalCooldownMinutes: Math.round(GLOBAL_COOLDOWN_MS / 60000),
    postsLast24h: postTimes.length,
    maxPostsPerDay: MAX_POSTS_PER_DAY,
    lastPostAt: lastPostAt ? new Date(lastPostAt).toISOString() : null
  };
}
