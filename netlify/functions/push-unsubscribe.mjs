import { getStore } from '@netlify/blobs';

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const { email } = await req.json();
    if (!email) return new Response(JSON.stringify({ error: 'Missing email' }), { status: 400 });

    const store = getStore('push-subscriptions');
    await store.delete(email.toLowerCase());

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('push-unsubscribe error:', e);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
}

export const config = { path: '/api/push-unsubscribe' };
