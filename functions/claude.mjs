/**
 * Cloud Function — Anthropic API proxy.
 *
 * Keeps the API key server-side; the browser never sees it. Auth requires
 * Authorization: Bearer <google-access-token>, verified against Google's
 * userinfo endpoint and checked against ALLOWED_EMAILS (5-min cache by token
 * hash). Streaming responses are piped through unchanged.
 *
 * Rate limiting is in-memory per instance (matches the original edge design).
 * maxInstances is capped so the per-instance limits stay meaningful — the real
 * auth gate is the Google token + allowlist, this is DoS mitigation.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { Readable } from 'node:stream';
import { ALLOWED_EMAILS, ANTHROPIC_API_KEY } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, sha256Hex } from './lib/http-common.mjs';

const ALLOWED_MODELS = new Set(['claude-haiku-4-5']);
const MAX_TOKENS_CAP = 4096;
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB hard ceiling on request body

// ── Rate limiter — dual layer: per-IP burst + per-email sustained ────────────
const IP_RATE_LIMIT    = 20;
const EMAIL_RATE_LIMIT = 10;
const WINDOW_MS        = 60_000;
const MAX_IPS          = 500;
const ipMap            = new Map();
const emailMap         = new Map();

let lastCleanup = Date.now();
function cleanupIfNeeded() {
  const now = Date.now();
  if (now - lastCleanup < 300_000) return;
  lastCleanup = now;
  for (const [key, entry] of ipMap) {
    if (now - entry.windowStart > WINDOW_MS * 2) ipMap.delete(key);
  }
  for (const [key, entry] of emailMap) {
    if (now - entry.windowStart > WINDOW_MS * 2) emailMap.delete(key);
  }
}

function isRateLimited(key, map, limit) {
  cleanupIfNeeded();
  const now   = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    if (map.size >= MAX_IPS) {
      const firstKey = map.keys().next().value;
      map.delete(firstKey);
    }
    map.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
}

// ── Token validation cache (5 min TTL, hashed key — never stores raw token) ──
const TOKEN_CACHE_MS = 5 * 60_000;
const MAX_TOKENS     = 500;
const tokenCache     = new Map();

async function verifyToken(accessToken) {
  if (!accessToken) return { allowed: false };

  const hash = await sha256Hex(accessToken);
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
    (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
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

export const claude = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS, ANTHROPIC_API_KEY], maxInstances: 5, cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.status(204).end();
      return;
    }

    if (!corsOrigin) { sendJson(res, 403, { error: { message: 'Forbidden' } }); return; }

    // sec-fetch-site must be present and same-origin/same-site.
    if (!hasValidSecFetchSite(req)) {
      sendJson(res, 403, { error: { message: 'Forbidden' } }, corsOrigin);
      return;
    }

    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    // Body-size pre-check via content-length header
    const declaredLen = parseInt(req.get('content-length') || '0', 10);
    if (declaredLen && declaredLen > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: { message: 'Request too large' } }, corsOrigin);
      return;
    }

    // Rate limit (per IP)
    const ip = (req.get('x-forwarded-for') || '').split(',')[0].trim()
            || req.get('x-real-ip')
            || 'unknown';
    if (isRateLimited(ip, ipMap, IP_RATE_LIMIT)) {
      sendJson(res, 429, { error: { message: 'Too many requests. Please wait a moment and try again.' } }, corsOrigin);
      return;
    }

    // Auth — require Google access token. Verify against userinfo + ALLOWED_EMAILS.
    const authHeader = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(authHeader);
    const accessToken = m ? m[1].trim() : null;
    if (!accessToken) { sendJson(res, 401, { error: { message: 'Unauthorized' } }, corsOrigin); return; }

    const tokenInfo = await verifyToken(accessToken);
    if (!tokenInfo?.allowed) { sendJson(res, 401, { error: { message: 'Unauthorized' } }, corsOrigin); return; }

    if (tokenInfo.email && isRateLimited(tokenInfo.email, emailMap, EMAIL_RATE_LIMIT)) {
      sendJson(res, 429, { error: { message: 'Too many requests. Please wait a moment and try again.' } }, corsOrigin);
      return;
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { sendJson(res, 500, { error: { message: 'Service unavailable' } }, corsOrigin); return; }

    // Read + validate body from the raw bytes (mirrors the edge function exactly).
    const text = (req.rawBody ? req.rawBody.toString('utf8') : '');
    if (text.length > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: { message: 'Request too large' } }, corsOrigin);
      return;
    }

    let parsed;
    try { parsed = JSON.parse(text); }
    catch { sendJson(res, 400, { error: { message: 'Invalid JSON' } }, corsOrigin); return; }

    if (!ALLOWED_MODELS.has(parsed.model)) {
      sendJson(res, 400, { error: { message: 'Model not allowed' } }, corsOrigin);
      return;
    }
    if (typeof parsed.max_tokens !== 'number' || parsed.max_tokens < 1) {
      sendJson(res, 400, { error: { message: 'Invalid max_tokens' } }, corsOrigin);
      return;
    }
    parsed.max_tokens = Math.min(parsed.max_tokens, MAX_TOKENS_CAP);

    if (!Array.isArray(parsed.messages)) {
      sendJson(res, 400, { error: { message: 'Invalid messages' } }, corsOrigin);
      return;
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

    // Pipe the (possibly streaming) upstream response through unchanged.
    res.status(upstream.status);
    res.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    res.set('Access-Control-Allow-Origin', corsOrigin);

    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  }
);
