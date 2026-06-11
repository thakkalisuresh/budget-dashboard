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
