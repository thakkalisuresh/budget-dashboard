/**
 * Wallet heartbeat: last time each phone (email) posted to the wallet webhook.
 *
 * A phone automation that dies (battery optimisation kills Automate, a Shortcuts
 * automation is switched off) fails silently: no request, no error, no charge.
 * The only signal is absence, so the webhook stamps `wallet_activity` on every
 * authenticated request and the daily digest alerts when one goes quiet.
 *
 * Doc id is a hash of the email (the address itself only lives in a field), so
 * nothing identifying is in a path. Only emails that have posted at least once
 * are tracked.
 */
import { createHash } from 'node:crypto';
import { getDb } from './firestore.mjs';
import { sendMessage } from './_telegram.mjs';
import { reportError } from './_error-log.mjs';

export const ACTIVITY_COLLECTION = 'wallet_activity';
export const SILENT_AFTER_MS = 4 * 24 * 60 * 60 * 1000;
// "Every 3 days", minus an hour so the daily 08:00 run's drift can't skip a cycle.
export const REALERT_MS = 71 * 60 * 60 * 1000;

const REPORT_GATE_MS = 10 * 60 * 1000;
let lastReportAt = 0;
export function resetActivityReportGate() { lastReportAt = 0; }

export const activityId = (email) =>
  createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex').slice(0, 16);

/**
 * Stamp "this phone is alive". Fails open: a webhook request must never be
 * affected by this write, so it never throws and reports at most once per
 * 10 minutes per instance.
 */
export async function recordActivity(email, source, { now = new Date() } = {}) {
  if (!email || !String(email).includes('@')) return;
  try {
    const ref = getDb().collection(ACTIVITY_COLLECTION).doc(activityId(email));
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;
    await ref.set({
      email: String(email).trim().toLowerCase(),
      lastSeenAt: now.toISOString(),
      lastSource: source || null,
      count: (Number(prev?.count) || 0) + 1,
      // Any activity resets the alert cycle: a phone that resumes and dies again
      // is alerted fresh, and resuming itself sends nothing.
      lastAlertedAt: null,
    });
  } catch (e) {
    if (now.getTime() - lastReportAt >= REPORT_GATE_MS || lastReportAt === 0) {
      lastReportAt = now.getTime();
      await reportError('WAL-006', e, { flow: 'heartbeat' });
    }
  }
}

/** Alert the household primary about each phone silent for 4+ days, every ~3 days until it resumes. */
export async function runHeartbeat({ now = new Date(), chatId, primaryEmail } = {}) {
  void primaryEmail;
  if (!chatId) return { alerted: 0, reason: 'no_chat_id' };
  const snap = await getDb().collection(ACTIVITY_COLLECTION).get();
  let alerted = 0;
  for (const d of snap.docs) {
    const data = d.data();
    const seen = Date.parse(data?.lastSeenAt);
    if (!data?.email || Number.isNaN(seen)) continue;
    const quiet = now.getTime() - seen;
    if (quiet < SILENT_AFTER_MS) continue;
    const lastAlert = data.lastAlertedAt ? Date.parse(data.lastAlertedAt) : NaN;
    if (!Number.isNaN(lastAlert) && now.getTime() - lastAlert < REALERT_MS) continue;

    const days = Math.floor(quiet / (24 * 60 * 60 * 1000));
    const text =
      `📵 No wallet activity from ${data.email} in ${days} days (last seen ${data.lastSeenAt.slice(0, 10)}). ` +
      `Check that phone's automation: Automate battery-optimization/app running, or Shortcuts automation.`;
    try {
      await sendMessage(chatId, text);
    } catch (e) {
      console.error('wallet-heartbeat: send failed', e?.message);
      continue; // lastAlertedAt stays put, so tomorrow retries
    }
    try {
      await getDb().collection(ACTIVITY_COLLECTION).doc(d.id).set({ ...data, lastAlertedAt: now.toISOString() });
    } catch (e) {
      console.warn('wallet-heartbeat: could not stamp lastAlertedAt', e?.message);
    }
    alerted += 1;
  }
  return { alerted };
}
