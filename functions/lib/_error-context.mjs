/**
 * Request-scoped error context: who, which channel, and the steps that led here.
 *
 * Cloud Functions REUSE instances across requests, so a module-level buffer
 * would attach one user's breadcrumbs to another user's error — quietly, and
 * only under load, which is the worst way to find out. AsyncLocalStorage gives
 * each invocation its own store and cleans up when the callback returns.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/** Keep the trail short: the last few steps explain a failure, forty do not. */
export const MAX_TRAIL = 8;

/**
 * Run `fn` with a fresh context. Everything inside — including code several
 * modules deep — can call trail()/setActor() without threading a parameter
 * through every signature.
 */
export function withErrorContext(init, fn) {
  return storage.run({ ...init, trail: [] }, fn);
}

/** Record a step. No-op outside a context, so library code stays callable anywhere. */
export function trail(step) {
  const ctx = storage.getStore();
  if (!ctx || !step) return;
  ctx.trail.push(String(step).slice(0, 60));
  if (ctx.trail.length > MAX_TRAIL) ctx.trail.shift();
}

/** Identify the person once their id is known (usually after auth). */
export function setActor(actor) {
  const ctx = storage.getStore();
  if (ctx && actor) ctx.actor = String(actor).slice(0, 80);
}

/** Snapshot for attaching to an error report. Safe to call anywhere. */
export function currentErrorContext() {
  const ctx = storage.getStore();
  if (!ctx) return {};
  const out = {};
  if (ctx.channel) out.channel = ctx.channel;
  if (ctx.actor) out.actor = ctx.actor;
  if (ctx.trail?.length) out.trail = ctx.trail.join(' → ');
  return out;
}

/**
 * Map a Telegram chat id back to the email it belongs to, using the mapping
 * that already exists for sending. With two people in the household, "which of
 * us" is usually the useful part, and a bare numeric chat id doesn't say.
 */
export function describeActor(chatId) {
  const raw = process.env.TELEGRAM_EMAIL_MAP || '';
  for (const pair of raw.split(',')) {
    const [email, id] = pair.split(':').map(s => s.trim());
    if (id && String(id) === String(chatId)) return email;
  }
  return String(chatId ?? '');
}
