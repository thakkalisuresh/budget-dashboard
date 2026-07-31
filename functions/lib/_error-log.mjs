/**
 * Error log — record backend failures somewhere they can be found later.
 *
 * Everything already calls console.error, which lands in Cloud Logging: fine
 * if you go looking, useless if you don't. Reading it back needs the Cloud
 * Logging API and IAM setup, so this records at the point of failure instead,
 * into Firestore, where the scheduled digest can group and report it.
 *
 * reportError never replaces console.error, it wraps it — the Cloud Logging
 * trail stays exactly as it was, so nothing that relied on it breaks.
 */
import { createHash } from 'node:crypto';
import { getDb } from './firestore.mjs';
import { errorLabel, describeError } from './_error-codes.mjs';
import { sendMessage, resolveTelegramChatId } from './_telegram.mjs';
import { currentErrorContext } from './_error-context.mjs';

export const ERROR_COLLECTION = 'error_log';

/** Keep the log bounded; the digest prunes anything older on each run. */
export const RETENTION_DAYS = 14;

/** Per-fingerprint alert state, so a storm of one failure sends one message. */
export const ALERT_COLLECTION = 'error_alerts';

/**
 * How long one distinct failure stays quiet after alerting.
 *
 * The scenario this exists for: Sheets rate-limits and forty errors fire in
 * ninety seconds. Without this you get forty Telegram messages, and the next
 * thing you do is mute the bot — at which point the one alert that mattered is
 * muted with the rest. One message per distinct failure per hour keeps the
 * signal usable.
 */
export const ALERT_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Collapse a message to a stable grouping key.
 *
 * The same failure rarely produces a byte-identical message — it carries a
 * row number, a uuid, an HTTP status, a vendor name. Stripping the variable
 * parts is what turns 40 near-identical lines into one digest entry with a
 * count, which is the entire point of grouping.
 */
export function fingerprint(code, message) {
  const normalized = String(message || '')
    .toLowerCase()
    .replace(/tx_[a-z0-9_]+/g, '<uuid>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d[\d,.]*\b/g, '<n>')
    .replace(/['"`][^'"`]{0,80}['"`]/g, '<str>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return `${code}:${normalized}`;
}

/**
 * Record a failure.
 *
 * Always logs to the console first, so a Firestore problem can never cost the
 * original error. The write is best-effort and swallows its own failure — an
 * error reporter that throws would turn a handled degradation into a crash,
 * which is precisely backwards.
 *
 * Returns a promise. Await it where the surrounding code is already async
 * (nearly everywhere): a Cloud Function can freeze the moment it returns, and
 * an un-awaited write may simply never land.
 */
export async function reportError(code, error, context = {}) {
  const message = error?.message || String(error || 'unknown error');
  // The code leads the line so it is greppable in Cloud Logging and readable
  // at a glance in a digest: "SHT-009 — Expense write failed: <detail>".
  console.error(`${errorLabel(code)}:`, message);
  const meta = describeError(code);

  try {
    const db = getDb();
    await db.collection(ERROR_COLLECTION).add({
      code,
      severity: meta?.severity || 'unknown',
      title: meta?.title || '',
      message: message.slice(0, 500),
      fingerprint: fingerprint(code, message),
      // Stack is the difference between "Sheets API 500" and knowing which
      // call made it, but it's bulky — first few frames are enough.
      stack: String(error?.stack || '').split('\n').slice(0, 4).join('\n').slice(0, 800),
      // Ambient request context first, explicit call-site context second, so a
      // deliberate value at the call site always wins over the inferred one.
      context: sanitizeContext({ ...currentErrorContext(), ...context }),
      at: new Date().toISOString(),
      reported: false,
      alerted: false,
    });
  } catch (e) {
    // Deliberately quiet: the console.error above already happened, and a
    // second failure here is not worth a second alarm.
    console.warn('error-log: could not persist error', e?.message);
  }

  // Fatal means the user's action did not happen and they have to redo it —
  // a wallet charge that vanished should not wait until 08:00 tomorrow.
  // degraded and config keep flowing to the daily digest only.
  if (meta?.severity === 'fatal') {
    await maybeAlertNow(code, meta, message, context);
  }
}

/** Firestore doc ids can't hold arbitrary text; hash the fingerprint instead. */
function alertKey(fp) {
  return createHash('sha1').update(String(fp)).digest('hex').slice(0, 32);
}

/**
 * Send an immediate Telegram alert for a fatal error, at most once per hour
 * per distinct failure.
 *
 * Never throws and never blocks the caller's own error handling: the Firestore
 * record is already written by the time this runs, and the daily digest is the
 * backstop if Telegram is unreachable. An alerting path that can itself throw
 * would turn a handled failure into a crash.
 */
async function maybeAlertNow(code, meta, message, context) {
  try {
    const email = (process.env.ALLOWED_EMAILS || '').split(',')[0]?.trim();
    const chatId = resolveTelegramChatId(email);
    if (!chatId) return;

    const db = getDb();
    const key = alertKey(fingerprint(code, message));
    const ref = db.collection(ALERT_COLLECTION).doc(key);
    const snap = await ref.get();
    const lastAt = snap.exists ? Date.parse(snap.data()?.lastAt || '') : NaN;
    if (Number.isFinite(lastAt) && Date.now() - lastAt < ALERT_COOLDOWN_MS) return;

    const ctx = Object.entries(sanitizeContext({ ...currentErrorContext(), ...context }))
      .slice(0, 3).map(([k, v]) => `${k}=${v}`).join(' ');
    await sendMessage(chatId, [
      `🔴 ${code} — ${meta.title}`,
      '',
      message.slice(0, 200),
      ctx || null,
      '',
      meta.fix,
    ].filter(v => v !== null).join('\n'));

    await ref.set({ lastAt: new Date().toISOString(), code });
  } catch (e) {
    console.warn('error-log: instant alert failed (digest remains the backstop)', e?.message);
  }
}

/**
 * Trim context to something safe to store.
 *
 * Callers pass loose objects, and this collection is read back into a Telegram
 * message — so drop anything that isn't a small scalar, and keep it short.
 * Nothing here should ever carry a token or a full request body.
 */
export function sanitizeContext(context) {
  const out = {};
  for (const [k, v] of Object.entries(context || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') continue;
    out[k] = String(v).slice(0, 120);
  }
  return out;
}

/**
 * Group raw error documents into one entry per distinct failure.
 * Most frequent first — a thing failing 40 times matters more than a one-off.
 */
export function groupErrors(docs) {
  const byPrint = new Map();
  for (const d of docs || []) {
    const key = d.fingerprint || fingerprint(d.code || '?', d.message);
    if (!byPrint.has(key)) {
      byPrint.set(key, {
        fingerprint: key, code: d.code || '?', severity: d.severity || 'unknown',
        title: d.title || '', message: d.message || '',
        count: 0, first: d.at, last: d.at, context: d.context || {},
        alerted: false,
      });
    }
    const g = byPrint.get(key);
    g.count += 1;
    if (d.alerted) g.alerted = true;
    if (d.at && (!g.first || d.at < g.first)) g.first = d.at;
    if (d.at && (!g.last || d.at > g.last)) { g.last = d.at; g.message = d.message || g.message; g.context = d.context || g.context; }
  }
  return [...byPrint.values()].sort((a, b) => b.count - a.count);
}

/** "Jul 29 08:00" in the household's timezone — a bare ISO string reads badly on a phone. */
function shortTime(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: 'America/Los_Angeles',
  });
}

/** Render a grouped digest as one Telegram message. */
export function buildDigest(groups, sinceLabel) {
  if (groups.length === 0) return null;
  const total = groups.reduce((n, g) => n + g.count, 0);
  const lines = [
    `🚨 ${total} backend error${total !== 1 ? 's' : ''} ${sinceLabel} — ${groups.length} distinct:`,
    '',
  ];
  for (const g of groups.slice(0, 10)) {
    const flag = g.severity === 'fatal' ? '🔴' : g.severity === 'config' ? '⚙️' : '🟡';
    // Flag anything already sent instantly, so the morning recap reads as a
    // summary rather than a surprise repeat.
    lines.push(`${flag} ${g.count}× ${g.code} — ${g.title}${g.alerted ? ' (already alerted)' : ''}`);
    lines.push(`   ${g.message.slice(0, 140)}`);
    // When it happened. A repeated failure shows the span rather than a single
    // point — that is what tells you whether it is ongoing or already over.
    const when = g.count > 1 && g.first && g.last && g.first !== g.last
      ? `${shortTime(g.first)} → ${shortTime(g.last)}`
      : shortTime(g.last || g.first);
    if (when) lines.push(`   when: ${when}`);
    // The trail gets its own line — it is the part that actually explains the
    // failure, and it is too long to sit inline with the other fields.
    const { trail, ...rest } = g.context || {};
    const ctx = Object.entries(rest).slice(0, 4).map(([k, v]) => `${k}=${v}`).join(' ');
    if (ctx) lines.push(`   ${ctx}`);
    if (trail) lines.push(`   steps: ${trail}`);
    lines.push('');
  }
  if (groups.length > 10) lines.push(`…and ${groups.length - 10} more kinds.`);
  lines.push('Look codes up in docs/ERROR_CODES.md.');
  return lines.join('\n').trim();
}
