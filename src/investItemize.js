// ════════════════════════════════════════════════════════════════════════════
// investItemize.js — pure helpers for brokerage contribution itemization.
//
// When an Investment-category expense routes to a BROKERAGE account, the
// flow-through posts the cash as a DEPOSIT (no balance bump — it sits in the
// SPAXX sweep). This module figures out which of those deposits still need the
// user to say what they bought, and does the running-remainder math the itemize
// dialog shows live. No network, no React — just data in, data out.
//
// Linkage (no schema churn): itemizing writes BUY activities whose `note` is
// "itemize:<depositUuid>". A deposit is "pending" until either a BUY references
// it that way OR the user dismisses it (settings.itemizeDismissed holds uuids).
// ════════════════════════════════════════════════════════════════════════════

export const ITEMIZE_NOTE_PREFIX = 'itemize:';

/** Build the note that links a BUY line back to the deposit it itemizes. */
export function itemizeNote(depositUuid) {
  return `${ITEMIZE_NOTE_PREFIX}${depositUuid}`;
}

/** Extract the deposit uuid a BUY note references, or '' if it isn't a link. */
export function itemizeTargetUuid(note) {
  const m = /itemize:(\S+)/.exec(String(note || ''));
  return m ? m[1] : '';
}

/**
 * Brokerage DEPOSITs that still need itemizing — i.e. not yet referenced by any
 * BUY's "itemize:" note and not dismissed by the user.
 *
 * `accounts` is needed to join accountId → type (HYSA deposits are never
 * itemizable; only brokerage cash gets the nudge).
 *
 * @param {Array} activities  — invest Activities rows ({ type, accountId, amount, date, note, uuid })
 * @param {Array} accounts    — invest Accounts rows ({ id, name, type })
 * @param {string[]} dismissedUuids — settings.itemizeDismissed
 * @returns {Array<{ uuid, accountId, accountName, amount, date }>} newest-last, input order
 */
export function pendingItemizations(activities = [], accounts = [], dismissedUuids = []) {
  const brokerage = new Map(
    accounts.filter(a => a?.type === 'brokerage').map(a => [a.id, a])
  );
  if (!brokerage.size) return [];

  const itemized = new Set();
  for (const a of activities) {
    if (a?.type !== 'BUY') continue;
    const target = itemizeTargetUuid(a.note);
    if (target) itemized.add(target);
  }

  const dismissed = new Set(dismissedUuids || []);

  return activities
    .filter(a =>
      a?.type === 'DEPOSIT' &&
      a.uuid &&
      brokerage.has(a.accountId) &&
      !itemized.has(a.uuid) &&
      !dismissed.has(a.uuid)
    )
    .map(a => ({
      uuid: a.uuid,
      accountId: a.accountId,
      accountName: brokerage.get(a.accountId)?.name || a.accountId,
      amount: Number(a.amount) || 0,
      date: a.date || '',
    }));
}

/** Cost of one BUY line = shares × price; 0 when either is missing/invalid. */
export function lineCost(row) {
  const qty = Number(row?.qty);
  const price = Number(row?.price);
  if (!(qty > 0) || !(price > 0)) return 0;
  return qty * price;
}

/** Σ(shares × price) across rows, rounded to cents. */
export function rowsCost(rows = []) {
  return +rows.reduce((s, r) => s + lineCost(r), 0).toFixed(2);
}

/**
 * Deposit minus what's been allocated to BUY lines.
 *   > 0  → leftover cash stays in the sweep (fine)
 *   = 0  → fully allocated
 *   < 0  → over-allocated (warn, don't block)
 */
export function itemizeRemainder(depositAmount, rows = []) {
  return +((Number(depositAmount) || 0) - rowsCost(rows)).toFixed(2);
}
