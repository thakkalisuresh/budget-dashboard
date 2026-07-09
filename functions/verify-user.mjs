/**
 * Cloud Function — server-side email allowlist verification.
 *
 * Emails never live in the client bundle; checked against Secret Manager.
 * POST { accessToken } → { allowed, email, name, picture, role, allowedEmails }.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS, VIEWER_EMAILS } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson } from './lib/http-common.mjs';

export const verifyUser = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS, VIEWER_EMAILS], cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.status(204).end();
      return;
    }

    if (!corsOrigin) { sendJson(res, 403, { allowed: false, error: 'Forbidden' }); return; }

    // sec-fetch-site must be present and same-origin/same-site — closes the
    // spoofed-Origin-from-curl bypass (matches the claude proxy). The SPA's
    // same-origin fetch (behind the Hosting rewrite) always sets this.
    if (!hasValidSecFetchSite(req)) {
      sendJson(res, 403, { allowed: false, error: 'Forbidden' }, corsOrigin);
      return;
    }

    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    let accessToken;
    try {
      accessToken = (req.body || {}).accessToken;
    } catch {
      sendJson(res, 400, { allowed: false, error: 'Invalid request' }, corsOrigin);
      return;
    }
    if (!accessToken) { sendJson(res, 200, { allowed: false }, corsOrigin); return; }

    // Verify token with Google and get profile
    let googleRes;
    try {
      googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      sendJson(res, 200, { allowed: false, error: 'Token verification failed' }, corsOrigin);
      return;
    }
    if (!googleRes.ok) {
      sendJson(res, 200, { allowed: false, error: 'Token verification failed' }, corsOrigin);
      return;
    }

    const profile = await googleRes.json();
    const email = profile.email?.toLowerCase();

    const allowedEmails = new Set(
      (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    );
    const allowed = allowedEmails.has(email);

    // Viewer emails can sign in but get read-only access
    const viewerEmails = new Set(
      (process.env.VIEWER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    );
    const role = allowed ? (viewerEmails.has(email) ? 'viewer' : 'owner') : null;

    sendJson(res, 200, {
      allowed,
      email: allowed ? email : null,
      name: allowed ? profile.given_name : null,
      picture: allowed ? profile.picture : null,
      role,
      allowedEmails: allowed ? [...allowedEmails] : [],
    }, corsOrigin);
  }
);
