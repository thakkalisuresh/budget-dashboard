import { getStore } from '@netlify/blobs';

const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase())
);

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { subscription, email, preferredHour, timezoneOffset } = await req.json();

    if (!email || !subscription?.endpoint) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
    }

    // Only allow emails on the allowlist
    if (ALLOWED_EMAILS.size > 0 && !ALLOWED_EMAILS.has(email.toLowerCase())) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 });
    }

    const store = getStore('push-subscriptions');
    await store.setJSON(email.toLowerCase(), {
      email: email.toLowerCase(),
      subscription,
      preferredHour: preferredHour ?? 20,       // default 8pm
      timezoneOffset: timezoneOffset ?? 0,       // hours offset from UTC (positive = east)
      updatedAt: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('push-subscribe error:', e);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
}

export const config = { path: '/api/push-subscribe' };
