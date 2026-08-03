// ════════════════════════════════════════════════════════════════════════════
// offlineReplay.js — replay the offline queue.
//
// Lifted out of useOfflineSync so it can be tested without standing up React.
// That matters more here than it looks: the bug this file was extracted to fix
// (`txDate` and `paymentMethod` dropped on replay, so every offline-entered
// expense silently became "today, no card") lived inside a `useCallback` and
// was therefore never covered by anything.
// ════════════════════════════════════════════════════════════════════════════
import { dequeue, updateRetries, MAX_RETRIES } from './offlineQueue.js';

/**
 * Replay every `add_expense` item in `items`.
 *
 * `addExpense` is injected rather than imported so a test can assert on the
 * exact arguments — which is the whole point, since the failure mode is a
 * *missing* argument, not a thrown error.
 *
 * Returns { synced, stuck }: `stuck` counts items that have exhausted
 * MAX_RETRIES and will never be retried again. They stay in the queue so the
 * user can see them; they are not silently dropped.
 */
export async function drainQueue({ items, accessToken, sheetId, addExpense }) {
  let synced = 0;
  let stuck  = 0;

  for (const item of items || []) {
    if (item.type !== 'add_expense') continue;

    // Retrying forever is not resilience. addExpense mints a fresh uuid per
    // attempt, so a write that half-succeeds (row landed, response lost) is
    // indistinguishable from a failure and gets re-appended on every retry.
    if ((item.retries || 0) >= MAX_RETRIES) { stuck++; continue; }

    const p = item.payload || {};
    try {
      await addExpense(
        p.categoryName, p.vendorName, p.amount, accessToken, sheetId, p.monthName,
        p.source,
        // Every field the online path writes. Passing fewer does not fail —
        // it writes different data, which is far worse.
        p.txDate ?? null,
        p.paymentMethod ?? '',
        p.bookingMethod ?? '',
        // valid_from in the warehouse is when the network returned; entered_at
        // is when the user actually typed it, which can be days earlier.
        { enteredAt: p.enteredAt || new Date(item.queuedAt || Date.now()).toISOString() },
      );
      dequeue(item.id);
      synced++;
    } catch {
      const next = (item.retries || 0) + 1;
      updateRetries(item.id, next);
      if (next >= MAX_RETRIES) stuck++;
    }
  }

  return { synced, stuck };
}
