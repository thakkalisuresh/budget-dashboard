/**
 * Netlify Edge Function — Anthropic API proxy
 * Keeps the API key server-side; browser never sees it.
 *
 * Auth: requires Authorization: Bearer <google-access-token>. The token is
 * verified against Google's userinfo endpoint and the email is checked against
 * the ALLOWED_EMAILS env var. Validation results cached 5 min by token hash.
 */

const ALLOWED_ORIGINS = [
  'https://budget-dashboard-tracker.netlify.app',
  'http://localhost:5173',
];

const ALLOWED_MODELS  = new Set(['claude-haiku-4-5']);
const MAX_TOKENS_CAP  = 4096;
const MAX_BODY_BYTES  = 8 * 1024 * 1024;          // 8 MB hard ceiling on request body

// ── Rate limiter — 20 req/IP/60s, with cleanup to prevent memory growth ──────
const RATE_LIMIT = 20;
const WINDOW_MS  = 60_000;
const MAX_IPS    = 500;
const ipMap      = new Map();

let lastCleanup = Date.now();
function cleanupIfNeeded() {
  const now = Date.now();
  if (now - lastCleanup < 300_000) return;
  lastCleanup = now;
  for (const [ip, entry] of ipMap) {
    if (now - entry.windowStart > WINDOW_MS * 2) ipMap.delete(ip);
  }
}

function isRateLimited(ip) {
  cleanupIfNeeded();
  const now   = Date.now();
  const entry = ipMap.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    if (ipMap.size >= MAX_IPS) {
      const firstKey = ipMap.keys().next().value;
      ipMap.delete(firstKey);
    }
    ipMap.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// ── Token validation cache (5 min TTL, hashed key — never stores raw token) ──
const TOKEN_CACHE_MS = 5 * 60_000;
const MAX_TOKENS     = 500;
const tokenCache     = new Map();

async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(accessToken) {
  if (!accessToken) return { allowed: false };

  const hash = await hashToken(accessToken);
  const now  = Date.now();
  const cached = tokenCache.get(hash);
  if (cached && cached.validUntil > now) return cached;

  let googleRes;
  try {
    googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { allowed: false };
  }

  if (!googleRes.ok) {
    const result = { allowed: false, validUntil: now + 30_000 }; // cache failure shorter
    tokenCache.set(hash, result);
    return result;
  }

  const profile = await googleRes.json().catch(() => null);
  const email   = profile?.email?.toLowerCase();

  const allowedEmails = new Set(
    (Deno.env.get('ALLOWED_EMAILS') || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );
  const allowed = !!email && allowedEmails.has(email);

  const result = { allowed, email, validUntil: now + TOKEN_CACHE_MS };

  if (tokenCache.size >= MAX_TOKENS) {
    const firstKey = tokenCache.keys().next().value;
    tokenCache.delete(firstKey);
  }
  tokenCache.set(hash, result);
  return result;
}

function jsonResp(status, payload, corsOrigin) {
  const headers = { 'Content-Type': 'application/json' };
  if (corsOrigin) headers['Access-Control-Allow-Origin'] = corsOrigin;
  return new Response(JSON.stringify(payload), { status, headers });
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async (request) => {
  const origin     = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    if (!corsOrigin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // Origin check
  if (!corsOrigin) return jsonResp(403, { error: { message: 'Forbidden' } });

  // sec-fetch-site MUST be present and same-origin/same-site.
  // Browsers always set this header automatically; curl / scripts do not.
  // Requiring its presence closes the "spoof Origin from curl" bypass.
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (!secFetchSite || (secFetchSite !== 'same-origin' && secFetchSite !== 'same-site')) {
    return jsonResp(403, { error: { message: 'Forbidden' } }, corsOrigin);
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  // Body-size pre-check via content-length header — reject huge bodies before buffering
  const declaredLen = parseInt(request.headers.get('content-length') || '0', 10);
  if (declaredLen && declaredLen > MAX_BODY_BYTES) {
    return jsonResp(413, { error: { message: 'Request too large' } }, corsOrigin);
  }

  // Rate limit
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
          || request.headers.get('x-real-ip')
          || 'unknown';
  if (isRateLimited(ip)) {
    return jsonResp(429, { error: { message: 'Too many requests. Please wait a moment and try again.' } }, corsOrigin);
  }

  // Auth — require Google access token. Verify against userinfo + ALLOWED_EMAILS.
  const authHeader = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  const accessToken = m ? m[1].trim() : null;
  if (!accessToken) {
    return jsonResp(401, { error: { message: 'Unauthorized' } }, corsOrigin);
  }
  const tokenInfo = await verifyToken(accessToken);
  if (!tokenInfo?.allowed) {
    return jsonResp(401, { error: { message: 'Unauthorized' } }, corsOrigin);
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return jsonResp(500, { error: { message: 'Service unavailable' } }, corsOrigin);
  }

  // Read + validate body
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return jsonResp(413, { error: { message: 'Request too large' } }, corsOrigin);
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { return jsonResp(400, { error: { message: 'Invalid JSON' } }, corsOrigin); }

  if (!ALLOWED_MODELS.has(parsed.model)) {
    return jsonResp(400, { error: { message: 'Model not allowed' } }, corsOrigin);
  }
  if (typeof parsed.max_tokens !== 'number' || parsed.max_tokens < 1) {
    return jsonResp(400, { error: { message: 'Invalid max_tokens' } }, corsOrigin);
  }
  parsed.max_tokens = Math.min(parsed.max_tokens, MAX_TOKENS_CAP);

  if (!Array.isArray(parsed.messages)) {
    return jsonResp(400, { error: { message: 'Invalid messages' } }, corsOrigin);
  }

  const sanitizedBody = JSON.stringify(parsed);

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: sanitizedBody,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
};

export const config = { path: '/api/claude' };
