/**
 * Cloud Function — scheduled backend error digest.
 *
 * Reads what reportError recorded, groups it into distinct failures, and sends
 * ONE Telegram message. Silence means nothing broke: no errors, no message.
 * A daily "all clear" would train you to ignore it.
 *
 * Also prunes the log, so the collection stays bounded without a separate job.
 *
 * Deployment note: this is a scheduled function, so deploying it needs BOTH
 * the cloudscheduler.googleapis.com API enabled on the project AND
 * roles/cloudscheduler.admin on the deploying principal (github-ci-deploy).
 * Without the role the function itself deploys fine but its Cloud Scheduler
 * job is never created — it goes ACTIVE and simply never fires, which looks
 * identical to "working" until you notice the digest never arrives.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getDb } from './lib/firestore.mjs';
import { sendMessage, resolveTelegramChatId } from './lib/_telegram.mjs';
import { ERROR_COLLECTION, RETENTION_DAYS, groupErrors, buildDigest } from './lib/_error-log.mjs';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP, ALLOWED_EMAILS } from './lib/secrets.mjs';

/** Cap the read: a runaway loop could log thousands and we only need the shape. */
const MAX_DOCS = 500;

/**
 * Core run, exported separately from the schedule wrapper so it can be tested
 * without standing up Cloud Scheduler.
 */
export async function runErrorDigest({ email, now = new Date() }) {
  const db = getDb();
  const col = db.collection(ERROR_COLLECTION);

  // Only unreported errors, so a digest never repeats itself even if the
  // schedule fires twice or a run half-fails.
  let snap;
  try {
    snap = await col.where('reported', '==', false).limit(MAX_DOCS).get();
  } catch (e) {
    console.error('error-digest: could not read error log', e?.message);
    return { sent: false, reason: 'read_failed' };
  }

  const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  await pruneOldErrors(col, now);

  if (docs.length === 0) return { sent: false, groups: 0, reason: 'no_errors' };

  const groups = groupErrors(docs);
  const chatId = resolveTelegramChatId(email);
  if (!chatId) {
    console.warn('error-digest: no Telegram mapping; not sending');
    return { sent: false, groups: groups.length, reason: 'no_chat_id' };
  }

  const text = buildDigest(groups, 'since the last check');
  try {
    await sendMessage(chatId, text);
  } catch (e) {
    // Leave them unreported so the next run tries again rather than silently
    // dropping a day of errors.
    console.error('error-digest: send failed', e?.message);
    return { sent: false, groups: groups.length, reason: 'send_failed' };
  }

  await markReported(col, docs.map(d => d.id));
  console.log(`error-digest: reported ${docs.length} errors in ${groups.length} groups`);
  return { sent: true, groups: groups.length, errors: docs.length };
}

/** Flag the reported docs so the next digest starts clean. Batched, chunked at Firestore's 500-op limit. */
async function markReported(col, ids) {
  for (let i = 0; i < ids.length; i += 400) {
    const batch = col.firestore.batch();
    for (const id of ids.slice(i, i + 400)) batch.update(col.doc(id), { reported: true });
    try {
      await batch.commit();
    } catch (e) {
      // Worst case a group repeats in the next digest — noisier, not wrong.
      console.warn('error-digest: could not mark reported', e?.message);
    }
  }
}

/** Drop anything past the retention window so the collection can't grow forever. */
async function pruneOldErrors(col, now) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    const old = await col.where('at', '<', cutoff).limit(400).get();
    if (old.empty) return 0;
    const batch = col.firestore.batch();
    old.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    return old.size;
  } catch (e) {
    console.warn('error-digest: prune failed', e?.message);
    return 0;
  }
}

export const errorDigest = onSchedule(
  {
    // Daily rather than hourly: a backend error here is something to look at
    // today, not something to be paged for.
    schedule: 'every day 08:00',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
    // ALLOWED_EMAILS is read below to pick the household account. It has to be
    // bound here or process.env.ALLOWED_EMAILS is undefined at runtime and the
    // digest silently returns without sending anything, forever.
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP, ALLOWED_EMAILS],
    timeoutSeconds: 120,
  },
  async () => {
    const email = (process.env.ALLOWED_EMAILS || '').split(',')[0]?.trim();
    if (!email) {
      console.warn('error-digest: ALLOWED_EMAILS not configured; skipping');
      return;
    }
    try {
      await runErrorDigest({ email });
    } catch (e) {
      console.error('error-digest: run failed', e?.message);
    }
  }
);
