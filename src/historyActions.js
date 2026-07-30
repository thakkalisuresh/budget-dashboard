// ════════════════════════════════════════════════════════════════════════════
// historyActions.js — what the History tab's `action` column can say about a
// transaction being written, and who has to agree about it.
//
// Two halves of one fact, kept together on purpose:
//   • historyAction()  — the WRITER. Maps a write's `source` to its action.
//   • WRITE_ACTIONS    — the READER. The ledger reconciles sheet rows against
//                        History entries in this list to recover each
//                        transaction's date and method badge.
//
// They used to live apart, and the failure mode is quiet: an action the writer
// emits but the reader doesn't list isn't dropped from the ledger — the row
// still renders, just with no date and no badge, which sorts it to the bottom
// of a date-descending list and reads as "my transaction is missing".
//
// `source: 'recurring'` was previously swallowed into 'Added', so a subscription
// auto-imported by the New Month wizard was indistinguishable from something
// typed by hand and there was no way to audit what a month actually pulled in.
// ════════════════════════════════════════════════════════════════════════════

/** History action for a write, given the `source` passed to addOrUpdateExpense. */
export function historyAction(source) {
  if (source === 'scan')      return 'Receipt Scan';
  if (source === 'import')    return 'Import';
  if (source === 'recurring') return 'Recurring';
  return 'Added';
}

/** Every action historyAction can emit — what the ledger must reconcile against. */
export const WRITE_ACTIONS = ['Added', 'Receipt Scan', 'Import', 'Recurring'];

/** Short badge label per action. */
export const METHOD_LABELS = {
  'Receipt Scan': 'Scan',
  'Import':       'Import',
  'Added':        'Manual',
  'Recurring':    'Recurring',
};
