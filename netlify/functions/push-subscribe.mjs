import { getStore } from '@netlify/blobs';
import { checkOrigin, checkSecFetchSite, verifyBearer, jsonResp } from './_auth.mjs';

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
  if (!checkSecFetchSite(req)) return jsonResp(403, { error: 'Forbidden' }, corsOrigin);
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const v = await verifyBearer(req);
  if (!v.ok) return jsonResp(401, { error: 'Unauthorized' }, corsOrigin);

  try {
    const { subscription, preferredHour, timezoneOffset } = await req.json();

    if (!subscription?.endpoint) {
      return jsonResp(400, { error: 'Missing subscription' }, corsOrigin);
    }

    // Use the verified email — never trust the client to claim someone else's email
    const email = v.email;

    const store = getStore('push-subscriptions');
    await store.setJSON(email, {
      email,
      subscription,
      preferredHour: preferredHour ?? 20,
      timezoneOffset: timezoneOffset ?? 0,
      updatedAt: new Date().toISOString(),
    });

    return jsonResp(200, { ok: true }, corsOrigin);
  } catch (e) {
    console.error('push-subscribe error:', e);
    return jsonResp(500, { error: 'Internal error' }, corsOrigin);
  }
}

export const config = { path: '/api/push-subscribe' };
