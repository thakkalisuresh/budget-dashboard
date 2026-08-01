// ════════════════════════════════════════════════════════════════════════════
// warehouseNotify.js — tell the backend what the browser just wrote to Sheets.
//
// The dashboard writes to the Sheets API directly, from the browser, with the
// user's own OAuth token. There is no server-side write path to hook, so the
// warehouse is told after the fact.
//
// Two rules that make this safe to sprinkle around:
//
//   • **It never throws and is never awaited.** A warehouse hiccup must not
//     make a successful expense entry look like a failure. Every call site is
//     `notifyWarehouse(...)` with no `await`.
//   • **It is called from the sheet-write MODULES, not the ~20 UI call sites.**
//     There are only two ways an expense reaches a spreadsheet from the browser
//     (`addOrUpdateExpense` and `moveTransactionCategory`, both in
//     sheetExpenses.js), so hooking there covers every dialog, every import
//     format, and — for free, with zero call-site changes — the offline-queue
//     replay path, since useOfflineSync → useExpense → sheetExpenses.
//
// What lands here is *client-asserted*, not proven. The backend records it with
// ingest_source='notify' and the reconciler, which diffs the actual sheet, is
// what confirms or retracts it.
// ════════════════════════════════════════════════════════════════════════════

const ENDPOINT = '/api/warehouse-notify';

/** Matches MAX_EVENTS_PER_REQUEST in functions/warehouse-notify.mjs. */
export const MAX_BATCH = 50;

/**
 * Fire a batch of events at the notify endpoint.
 *
 * `keepalive` is what makes this survive the page being closed or navigated
 * away from mid-request — a "log expense and close the tab" is an ordinary
 * thing to do, and without it the notify is cancelled and the row only reaches
 * the warehouse when the reconciler next runs.
 *
 * Returns a promise so tests can await it; production callers deliberately do
 * not.
 */
export function notifyWarehouse(events, accessToken) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (list.length === 0 || !accessToken) return Promise.resolve();
  if (typeof fetch !== 'function') return Promise.resolve();

  const batches = [];
  for (let i = 0; i < list.length; i += MAX_BATCH) batches.push(list.slice(i, i + MAX_BATCH));

  return Promise.all(batches.map(batch =>
    fetch(ENDPOINT, {
      method: 'POST',
      keepalive: true,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    }).catch(() => {})
  )).then(() => {}, () => {});
}

/* ── Event builders ────────────────────────────────────────────────────────
   Small and explicit so a call site can't accidentally send a field name the
   backend silently ignores. `clientReportedAt` is recorded but never used for
   ordering — the server's receive time is what orders versions. */

const nowIso = () => new Date().toISOString();

export function transactionWriteEvent({
  spreadsheetId, budgetMonth, category, uuid, budgetDate, vendor, amount,
  paymentMethod = '', bookingMethod = '', sheetRowIndex = null,
  sourceAction = null, priorTransactionKey = null, priorUuid = null,
  enteredAt = null,
}) {
  return {
    eventType: 'transaction_write',
    spreadsheetId, budgetMonth, category, uuid, budgetDate, vendor, amount,
    paymentMethod, bookingMethod, sheetRowIndex,
    sourceAction, priorTransactionKey, priorUuid, enteredAt,
    clientReportedAt: nowIso(),
  };
}

export function transactionDeleteEvent({
  spreadsheetId, budgetMonth, category, uuid, budgetDate = null, vendor = null,
  amount = null, paymentMethod = '', bookingMethod = '', sheetRowIndex = null,
  sourceAction = null, stateReason = 'deleted_in_sheet',
}) {
  return {
    eventType: 'transaction_delete',
    spreadsheetId, budgetMonth, category, uuid, budgetDate, vendor, amount,
    paymentMethod, bookingMethod, sheetRowIndex, sourceAction, stateReason,
    clientReportedAt: nowIso(),
  };
}

export function budgetWriteEvent({
  spreadsheetId, budgetMonth, category, formulaRaw = null, budgetCents = null,
  derivation = null, totalsRowNum = null, spentCentsAtObservation = null,
  sourceAction = null,
}) {
  return {
    eventType: 'budget_write',
    spreadsheetId, budgetMonth, category, formulaRaw, budgetCents, derivation,
    totalsRowNum, spentCentsAtObservation, sourceAction,
    clientReportedAt: nowIso(),
  };
}
