/**
 * Shared HTTP helpers for the Cloud Functions ported from Netlify edge
 * functions (verify-user, claude proxy). Express-style (req, res) — Firebase
 * 2nd-gen onRequest, not Deno Web Request/Response.
 */

// Origins allowed to call the API. Behind Hosting rewrites, /api/* is
// same-origin with the site, so the browser sends the site's own origin.
// Both the Netlify origin (parallel run) and the new Firebase origins are
// listed; drop the Netlify entry at final cutover (Part D).
export const ALLOWED_ORIGINS = new Set([
  'https://budget-dashboard-tracker.netlify.app',
  'https://fundient-dashboard.web.app',
  'https://fundient-dashboard.firebaseapp.com',
  'http://localhost:5173', // vite dev
  'http://localhost:5000', // firebase hosting emulator
]);

/** Returns the request origin if it is allowlisted, else null. */
export function corsOriginFor(req) {
  const origin = req.get('origin') || '';
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

/** sec-fetch-site must be present and same-origin/same-site (closes the
 *  spoofed-Origin-from-curl bypass). Browsers set this automatically. */
export function hasValidSecFetchSite(req) {
  const v = req.get('sec-fetch-site');
  return !!v && (v === 'same-origin' || v === 'same-site');
}

/** Send a JSON response with optional CORS origin header. */
export function sendJson(res, status, payload, corsOrigin) {
  if (corsOrigin) res.set('Access-Control-Allow-Origin', corsOrigin);
  res.set('Content-Type', 'application/json');
  res.status(status).send(JSON.stringify(payload));
}

/** SHA-256 hex of a string (used to key token caches without storing raw tokens). */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Bearer-token verification (push-* functions) ─────────────────────────────
// Small in-memory cache so we don't hit Google on every push event.
const BEARER_TOKEN_CACHE_MS = 5 * 60_000;
const BEARER_FAIL_CACHE_MS  = 30_000;
const BEARER_MAX_ENTRIES    = 500;
const BEARER_MAX_FAIL       = 50;
const bearerCache     = new Map();
const bearerFailCache = new Map();

/**
 * Verify a Google access token from the Authorization header.
 * Returns { ok, email } if the token is valid and the email is in ALLOWED_EMAILS.
 */
export async function verifyBearer(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return { ok: false };
  const token = m[1].trim();

  const hash = await sha256Hex(token);
  const now  = Date.now();

  const failHit = bearerFailCache.get(hash);
  if (failHit && failHit.validUntil > now) return failHit;

  const hit = bearerCache.get(hash);
  if (hit && hit.validUntil > now) return hit;

  let googleRes;
  try {
    googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { ok: false };
  }
  if (!googleRes.ok) {
    if (bearerFailCache.size >= BEARER_MAX_FAIL) bearerFailCache.delete(bearerFailCache.keys().next().value);
    const miss = { ok: false, validUntil: now + BEARER_FAIL_CACHE_MS };
    bearerFailCache.set(hash, miss);
    return miss;
  }
  const profile = await googleRes.json().catch(() => null);
  const email   = profile?.email?.toLowerCase();

  const allowed = new Set(
    (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );
  const ok = !!email && allowed.has(email);

  if (bearerCache.size >= BEARER_MAX_ENTRIES) bearerCache.delete(bearerCache.keys().next().value);
  const result = { ok, email, validUntil: now + BEARER_TOKEN_CACHE_MS };
  bearerCache.set(hash, result);
  return result;
}
