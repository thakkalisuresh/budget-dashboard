/**
 * Cloud Function — Google OAuth authorization-code broker for mobile biometric login.
 *
 * The implicit flow used on desktop yields only a 1-hour access token and has no
 * way to refresh silently inside an iOS standalone PWA (the WebView is sandboxed
 * away from Safari's accounts.google.com session). So mobile uses the
 * authorization-code flow: this function exchanges the code for a long-lived
 * refresh token, stores it server-side in Firestore (default-deny — unreachable
 * by clients), and hands the device only an opaque session token. Passing
 * biometric calls `refresh` to mint a fresh access token with no Google screen.
 *
 * POST { action: 'exchange', code }      → { allowed, sessionToken, access_token, expires_in, profile… }
 * POST { action: 'refresh',  sessionToken } → { access_token, expires_in, profile… }  (401 if invalid)
 * POST { action: 'revoke',   sessionToken } → { ok: true }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, VIEWER_EMAILS } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, sha256Hex } from './lib/http-common.mjs';
import { getDb } from './lib/firestore.mjs';

const TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SESSIONS     = 'authSessions';
// Popup-mode authorization codes from GIS are exchanged with the special
// 'postmessage' redirect_uri (no real redirect URI is involved).
const REDIRECT_URI = 'postmessage';

const allowSet = () => new Set(
  (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);
const viewerSet = () => new Set(
  (process.env.VIEWER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
);

async function googleProfile(accessToken) {
  try {
    const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

async function postToken(params) {
  try {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        ...params,
      }),
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

function newSessionToken() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function profilePayload(email, profile, role, allow) {
  return {
    email,
    name: profile?.given_name || 'User',
    picture: profile?.picture || null,
    role,
    allowedEmails: [...allow],
  };
}

export const googleToken = onRequest(
  { region: 'us-central1', secrets: [GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ALLOWED_EMAILS, VIEWER_EMAILS], cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

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

    if (!corsOrigin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    if (!hasValidSecFetchSite(req)) { sendJson(res, 403, { error: 'Forbidden' }, corsOrigin); return; }
    if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

    const body = req.body || {};
    const db = getDb();

    try {
      // ── Exchange authorization code → tokens; persist refresh token ──────────
      if (body.action === 'exchange') {
        if (!body.code) { sendJson(res, 400, { allowed: false, error: 'Missing code' }, corsOrigin); return; }

        const tok = await postToken({
          code: body.code,
          grant_type: 'authorization_code',
          redirect_uri: REDIRECT_URI,
        });
        if (!tok?.access_token) { sendJson(res, 200, { allowed: false, error: 'Exchange failed' }, corsOrigin); return; }

        const profile = await googleProfile(tok.access_token);
        const email = profile?.email?.toLowerCase();
        const allow = allowSet();
        if (!email || !allow.has(email)) { sendJson(res, 200, { allowed: false }, corsOrigin); return; }
        const role = viewerSet().has(email) ? 'viewer' : 'owner';

        // No refresh token means Google didn't grant offline access (usually a
        // returning grant). Still log them in for this 1-hour token, but no
        // session is persisted — the client must re-consent to enable biometric.
        if (!tok.refresh_token) {
          sendJson(res, 200, {
            allowed: true, needsConsent: true,
            access_token: tok.access_token, expires_in: tok.expires_in,
            ...profilePayload(email, profile, role, allow),
          }, corsOrigin);
          return;
        }

        const sessionToken = newSessionToken();
        const hash = await sha256Hex(sessionToken);
        await db.collection(SESSIONS).doc(hash).set({
          email, role,
          refreshToken: tok.refresh_token,
          createdAt: Date.now(),
        });

        sendJson(res, 200, {
          allowed: true, sessionToken,
          access_token: tok.access_token, expires_in: tok.expires_in,
          ...profilePayload(email, profile, role, allow),
        }, corsOrigin);
        return;
      }

      // ── Refresh: opaque session token → fresh access token ───────────────────
      if (body.action === 'refresh') {
        if (!body.sessionToken) { sendJson(res, 401, { error: 'No session' }, corsOrigin); return; }
        const hash = await sha256Hex(body.sessionToken);
        const ref  = db.collection(SESSIONS).doc(hash);
        const snap = await ref.get();
        if (!snap.exists) { sendJson(res, 401, { error: 'Invalid session' }, corsOrigin); return; }

        const { email, role, refreshToken } = snap.data();
        const allow = allowSet();
        if (!allow.has(email)) { await ref.delete(); sendJson(res, 401, { error: 'Revoked' }, corsOrigin); return; }

        const tok = await postToken({ refresh_token: refreshToken, grant_type: 'refresh_token' });
        if (!tok?.access_token) { await ref.delete(); sendJson(res, 401, { error: 'Refresh failed' }, corsOrigin); return; }

        const profile = await googleProfile(tok.access_token);
        sendJson(res, 200, {
          access_token: tok.access_token, expires_in: tok.expires_in,
          ...profilePayload(email, profile, role, allow),
        }, corsOrigin);
        return;
      }

      // ── Revoke: drop the session (sign-out) ──────────────────────────────────
      if (body.action === 'revoke') {
        if (body.sessionToken) {
          const hash = await sha256Hex(body.sessionToken);
          await db.collection(SESSIONS).doc(hash).delete().catch(() => {});
        }
        sendJson(res, 200, { ok: true }, corsOrigin);
        return;
      }

      sendJson(res, 400, { error: 'Unknown action' }, corsOrigin);
    } catch {
      sendJson(res, 500, { error: 'Server error' }, corsOrigin);
    }
  }
);
