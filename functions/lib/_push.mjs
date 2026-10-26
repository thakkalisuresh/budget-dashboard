/**
 * Server-side Web Push — send a notification to one email's stored subscription.
 *
 * The same pattern as push-alert.mjs / wallet-webhook.mjs (subscriptions in the
 * `push_subscriptions` Firestore collection, keyed by email; VAPID keys from
 * env), lifted into a shared helper so scheduled jobs can push too. Never
 * throws: a push is a nice-to-have on top of the Telegram digest, not something
 * worth failing a run over. Returns a small result for the logs.
 */
import webpush from 'web-push';
import { getDb } from './firestore.mjs';

export async function sendPushToEmail(email, { title, body, url = '/' }) {
  const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  const vapidEmail   = process.env.VAPID_EMAIL;
  if (!vapidPublic || !vapidPrivate || !vapidEmail) return { sent: false, reason: 'vapid_unconfigured' };
  if (!email || !title) return { sent: false, reason: 'missing_target' };

  try {
    const docRef = getDb().collection('push_subscriptions').doc(email);
    const snap = await docRef.get();
    const entry = snap.exists ? snap.data() : null;
    if (!entry?.subscription?.endpoint) return { sent: false, reason: 'no_subscription' };

    webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPublic, vapidPrivate);
    await webpush.sendNotification(entry.subscription, JSON.stringify({ title, body: body || '', url }));
    return { sent: true };
  } catch (e) {
    // 410 Gone — the subscription is dead; drop it so it stops being tried.
    if (e?.statusCode === 410) {
      await getDb().collection('push_subscriptions').doc(email).delete().catch(() => {});
    }
    console.warn('_push: send failed', e?.message);
    return { sent: false, reason: 'send_failed' };
  }
}
