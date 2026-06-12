/**
 * Cloud Function — send an instant Web Push alert to the caller's own subscription.
 * Ported from netlify/functions/push-alert.mjs (Deno → Node/Express,
 * @netlify/blobs → Firestore). VAPID keys + web-push unchanged.
 */
import { onRequest } from 'firebase-functions/v2/https';
import webpush from 'web-push';
import { ALLOWED_EMAILS, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getDb } from './lib/firestore.mjs';

// Per-email rate limit — anti-spam (1 push / 5s per email)
const RECENT = new Map();
const MIN_INTERVAL_MS = 5_000;
function tooSoon(key) {
  const now = Date.now();
  for (const [k, t] of RECENT) if (now - t > 60_000) RECENT.delete(k);
  const last = RECENT.get(key);
  RECENT.set(key, now);
  return last && now - last < MIN_INTERVAL_MS;
}

export const pushAlert = onRequest(
  {
    region: 'us-central1',
    secrets: [ALLOWED_EMAILS, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL],
    cors: false,
  },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

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

    if (!corsOrigin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    if (!hasValidSecFetchSite(req)) { sendJson(res, 403, { error: 'Forbidden' }, corsOrigin); return; }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidEmail   = process.env.VAPID_EMAIL;
    if (!vapidPublic || !vapidPrivate || !vapidEmail) {
      sendJson(res, 200, { ok: false, reason: 'VAPID not configured' }, corsOrigin);
      return;
    }

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }

    const { title, body } = req.body || {};

    if (!title) { sendJson(res, 400, { error: 'Missing title' }, corsOrigin); return; }
    if (typeof title !== 'string' || title.length > 200) {
      sendJson(res, 400, { error: 'Invalid title' }, corsOrigin);
      return;
    }
    if (body && (typeof body !== 'string' || body.length > 1000)) {
      sendJson(res, 400, { error: 'Invalid body' }, corsOrigin);
      return;
    }

    // Use the verified email — never trust client to push to someone else
    const email = v.email;

    if (tooSoon(email)) { sendJson(res, 429, { ok: false, reason: 'Slow down' }, corsOrigin); return; }

    const docRef = getDb().collection('push_subscriptions').doc(email);
    const snap = await docRef.get();
    const entry = snap.exists ? snap.data() : null;
    if (!entry?.subscription?.endpoint) {
      sendJson(res, 200, { ok: false, reason: 'No subscription found' }, corsOrigin);
      return;
    }

    webpush.setVapidDetails(vapidEmail, vapidPublic, vapidPrivate);

    try {
      await webpush.sendNotification(
        entry.subscription,
        JSON.stringify({ title, body: body || '', url: '/' })
      );
      sendJson(res, 200, { ok: true }, corsOrigin);
    } catch (e) {
      if (e.statusCode === 410) await docRef.delete().catch(() => {});
      sendJson(res, 200, { ok: false, reason: 'Push delivery failed' }, corsOrigin);
    }
  }
);
