import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL || 'mailto:nair.sabarish97@gmail.com';
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase())
);

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return new Response(JSON.stringify({ ok: false, reason: 'VAPID not configured' }), { status: 200 });
  }

  let email, title, body;
  try {
    ({ email, title, body } = await req.json());
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
  }

  if (!email || !title) {
    return new Response(JSON.stringify({ error: 'Missing email or title' }), { status: 400 });
  }

  if (ALLOWED_EMAILS.size > 0 && !ALLOWED_EMAILS.has(email.toLowerCase())) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 403 });
  }

  const store = getStore('push-subscriptions');
  const entry = await store.get(email.toLowerCase(), { type: 'json' });
  if (!entry?.subscription?.endpoint) {
    return new Response(JSON.stringify({ ok: false, reason: 'No subscription found' }), { status: 200 });
  }

  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

  try {
    await webpush.sendNotification(
      entry.subscription,
      JSON.stringify({ title, body: body || '', url: '/' })
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  } catch (e) {
    if (e.statusCode === 410) await store.delete(email.toLowerCase()).catch(() => {});
    return new Response(JSON.stringify({ ok: false, reason: e.message }), { status: 200 });
  }
}

export const config = { path: '/api/push-alert' };
