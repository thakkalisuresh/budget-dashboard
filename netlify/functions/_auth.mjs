/**
 * Shared auth helpers for netlify/functions/push-*.mjs.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */

const ALLOWED_ORIGINS = new Set([
  'https://budget-dashboard-tracker.netlify.app',
  'http://localhost:5173',
  'http://localhost:8888',
]);

// Small in-memory cache so we don't hit Google on every push event.
const TOKEN_CACHE_MS = 5 * 60_000;
const MAX_ENTRIES    = 500;
const cache = new Map();

async function sha256Hex(s) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function checkOrigin(req) {
  const origin = req.headers.get('origin') || '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

export function corsHeaders(corsOrigin) {
  const h = { 'Content-Type': 'application/json' };
  if (corsOrigin) h['Access-Control-Allow-Origin'] = corsOrigin;
  return h;
}

export function jsonResp(status, payload, corsOrigin) {
  return new Response(JSON.stringify(payload), { status, headers: corsHeaders(corsOrigin) });
}

/**
 * Verify a Google access token from the Authorization header.
 * Returns { ok, email } if the token is valid and the email is in ALLOWED_EMAILS.
 */
export async function verifyBearer(req) {
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return { ok: false };
  const token = m[1].trim();

  const hash = await sha256Hex(token);
  const now  = Date.now();
  const hit  = cache.get(hash);
  if (hit && hit.validUntil > now) return hit;

  let res;
  try {
    res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false };
  }
  if (!res.ok) {
    const miss = { ok: false, validUntil: now + 30_000 };
    cache.set(hash, miss);
    return miss;
  }
  const profile = await res.json().catch(() => null);
  const email   = profile?.email?.toLowerCase();

  const allowed = new Set(
    (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );
  const ok = !!email && allowed.has(email);

  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  const result = { ok, email, validUntil: now + TOKEN_CACHE_MS };
  cache.set(hash, result);
  return result;
}
