import { createHash, randomBytes } from 'node:crypto';

const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const DEFAULT_REDIRECT_URI = 'https://site--runnerhunter--6wdsl68tqw7w.code.run/auth/x/callback';
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function redirectUri() {
  return process.env.X_REDIRECT_URI || DEFAULT_REDIRECT_URI;
}

function cleanup() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [state, value] of pending) {
    if (value.createdAt < cutoff) pending.delete(state);
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function tokenPage(data) {
  const access = htmlEscape(data.access_token || '');
  const refresh = htmlEscape(data.refresh_token || '');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>RunnerHunter X OAuth</title><style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:24px;line-height:1.45}textarea{width:100%;min-height:90px;margin:6px 0 16px;font-family:monospace}code{font-family:monospace}</style></head><body><h2>RunnerHunter X OAuth complete</h2><p>Copy both values into Northflank. Do not post them anywhere.</p><label>Access Token</label><textarea readonly>${access}</textarea><label>Refresh Token</label><textarea readonly>${refresh}</textarea><p>Scopes: <code>${htmlEscape(SCOPES.join(', '))}</code></p></body></html>`;
}

async function exchangeCode(code, verifier) {
  const clientId = process.env.X_CLIENT_ID || '';
  const clientSecret = process.env.X_CLIENT_SECRET || '';
  if (!clientId || !clientSecret) throw new Error('X_CLIENT_ID and X_CLIENT_SECRET must be configured first');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json'
    },
    body: new URLSearchParams({
      code,
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri(),
      code_verifier: verifier
    }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`X OAuth token exchange ${response.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

export function installXOauth(app) {
  if (app.__runnerHunterXOauthInstalled) return;
  app.__runnerHunterXOauthInstalled = true;

  app.get('/auth/x/start', (req, res) => {
    cleanup();
    const clientId = process.env.X_CLIENT_ID || '';
    if (!clientId) return res.status(500).type('text').send('X_CLIENT_ID is not configured in Northflank.');

    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    pending.set(state, { verifier, createdAt: Date.now() });

    const url = new URL(X_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri());
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return res.redirect(url.toString());
  });

  app.get('/auth/x/callback', async (req, res) => {
    cleanup();
    const state = String(req.query.state || '');
    const code = String(req.query.code || '');
    const saved = pending.get(state);
    pending.delete(state);
    if (!saved) return res.status(400).type('text').send('Invalid or expired OAuth state. Start again from /auth/x/start.');
    if (req.query.error) return res.status(400).type('text').send(`X authorization failed: ${req.query.error}`);
    if (!code) return res.status(400).type('text').send('X authorization returned no code.');

    try {
      const data = await exchangeCode(code, saved.verifier);
      if (!data.access_token || !data.refresh_token) throw new Error('X did not return both access and refresh tokens.');
      res.status(200).type('html').send(tokenPage(data));
    } catch (error) {
      console.error(`[x-oauth:error] ${error.message}`);
      res.status(502).type('text').send(`X OAuth exchange failed: ${error.message}`);
    }
  });

  const router = app.router || app._router;
  const stack = router?.stack;
  if (Array.isArray(stack)) {
    const oauthLayers = stack.splice(-2);
    const catchAllIndex = stack.findIndex(layer => layer?.route?.path instanceof RegExp);
    if (catchAllIndex >= 0) stack.splice(catchAllIndex, 0, ...oauthLayers);
    else stack.push(...oauthLayers);
  }
}
