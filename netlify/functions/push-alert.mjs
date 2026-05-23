import webpush from 'web-push';
import { getStore } from '@netlify/blobs';
import { checkOrigin, verifyBearer, jsonResp } from './_auth.mjs';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:nair.sabarish97@gmail.com';

// Per-email + per-IP rate limit — anti-spam (1 push / 5s per email)
const RECENT = new Map();
const MIN_INTERVAL_MS = 5_000;
function tooSoon(key) {
  const now = Date.now();
  for (const [k, t] of RECENT) if (now - t > 60_000) RECENT.delete(k);
  const last = RECENT.get(key);
  RECENT.set(key, now);
  return last && now - last < MIN_INTERVAL_MS;
}

export default async function handler(req) {
  const corsOrigin = checkOrigin(req);

  if (req.method === 'OPTIONS') {
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

  if (!corsOrigin) return jsonResp(403, { error: 'Forbidden' });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return jsonResp(200, { ok: false, reason: 'VAPID not configured' }, corsOrigin);
  }

  const v = await verifyBearer(req);
  if (!v.ok) return jsonResp(401, { error: 'Unauthorized' }, corsOrigin);

  let title, body;
  try {
    ({ title, body } = await req.json());
  } catch {
    return jsonResp(400, { error: 'Invalid request' }, corsOrigin);
  }

  if (!title) return jsonResp(400, { error: 'Missing title' }, corsOrigin);
  if (typeof title !== 'string' || title.length > 200) {
    return jsonResp(400, { error: 'Invalid title' }, corsOrigin);
  }
  if (body && (typeof body !== 'string' || body.length > 1000)) {
    return jsonResp(400, { error: 'Invalid body' }, corsOrigin);
  }

  // Use the verified email — never trust client to push to someone else
  const email = v.email;

  if (tooSoon(email)) return jsonResp(429, { ok: false, reason: 'Slow down' }, corsOrigin);

  const store = getStore('push-subscriptions');
  const entry = await store.get(email, { type: 'json' });
  if (!entry?.subscription?.endpoint) {
    return jsonResp(200, { ok: false, reason: 'No subscription found' }, corsOrigin);
  }

  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

  try {
    await webpush.sendNotification(
      entry.subscription,
      JSON.stringify({ title, body: body || '', url: '/' })
    );
    return jsonResp(200, { ok: true }, corsOrigin);
  } catch (e) {
    if (e.statusCode === 410) await store.delete(email).catch(() => {});
    return jsonResp(200, { ok: false, reason: 'Push delivery failed' }, corsOrigin);
  }
}

export const config = { path: '/api/push-alert' };
