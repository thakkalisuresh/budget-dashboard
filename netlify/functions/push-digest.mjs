import webpush from 'web-push';
import { getStore } from '@netlify/blobs';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = process.env.VAPID_EMAIL; // required — set as a Netlify env var

// Runs every hour — sends push to users whose configured local time matches now
export default async function handler() {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !VAPID_EMAIL) {
    console.warn('push-digest: VAPID not fully configured');
    return new Response('VAPID not configured', { status: 200 });
  }

  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

  const store  = getStore('push-subscriptions');
  const { blobs } = await store.list();

  const currentUTCHour = new Date().getUTCHours();
  let sent = 0, skipped = 0, failed = 0;

  for (const blob of blobs) {
    try {
      const entry = await store.get(blob.key, { type: 'json' });
      if (!entry?.subscription?.endpoint) { skipped++; continue; }

      // Convert user's preferred local hour to UTC equivalent
      const localHourUTC = ((entry.preferredHour ?? 20) - (entry.timezoneOffset ?? 0) + 24) % 24;

      if (currentUTCHour !== Math.round(localHourUTC)) { skipped++; continue; }

      await webpush.sendNotification(
        entry.subscription,
        JSON.stringify({
          title: 'Budget Tracker',
          body:  "Your daily budget digest is ready. Tap to review.",
          url:   '/',
        })
      );
      sent++;
    } catch (e) {
      console.error('push-digest: failed for', blob.key, e.statusCode ?? e.message);
      // 410 Gone = subscription expired — clean it up
      if (e.statusCode === 410) {
        await store.delete(blob.key).catch(() => {});
      }
      failed++;
    }
  }

  console.log(`push-digest: sent=${sent} skipped=${skipped} failed=${failed}`);
  return new Response(JSON.stringify({ sent, skipped, failed }), { status: 200 });
}

export const config = {
  schedule: '0 * * * *',  // every hour on the hour
};
