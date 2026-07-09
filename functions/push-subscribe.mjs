/**
 * Cloud Function — register/update a browser push subscription.
 * Subscriptions are stored in Firestore.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getDb } from './lib/firestore.mjs';

export const pushSubscribe = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS], cors: false },
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

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }

    try {
      const { subscription, preferredHour, timezoneOffset } = req.body || {};

      if (!subscription?.endpoint) {
        sendJson(res, 400, { error: 'Missing subscription' }, corsOrigin);
        return;
      }

      // Use the verified email — never trust the client to claim someone else's email
      const email = v.email;

      await getDb().collection('push_subscriptions').doc(email).set({
        email,
        subscription,
        preferredHour: preferredHour ?? 20,
        timezoneOffset: timezoneOffset ?? 0,
        updatedAt: new Date().toISOString(),
      });

      sendJson(res, 200, { ok: true }, corsOrigin);
    } catch (e) {
      console.error('push-subscribe error:', e);
      sendJson(res, 500, { error: 'Internal error' }, corsOrigin);
    }
  }
);
