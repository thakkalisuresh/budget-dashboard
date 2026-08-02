// ════════════════════════════════════════════════════════════════════════════
// _transaction-notes.mjs — MIRROR of src/transactionNotes.js. Keep the two
// byte-identical below this banner; splitNotes.test.js fails on divergence.
//
// transactionNotes.js — the one place that knows how a transaction note is keyed.
//
// Notes live in settings.transactionNotes, keyed by sheet + category + vendor +
// amount. That key was previously rebuilt inline in three places (LedgerTab,
// DetailPanel, and now the split flow). Three copies of a format string is three
// chances to disagree — and a note written under a key nothing reads back is
// invisible rather than broken, so the drift would be silent.
//
// The bot writes notes under this same key so the dashboard can read them back;
// it is the only reason the format needs a server copy at all.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Canonical note key.
 *
 * The amount is part of the key, so it must be the amount actually written to
 * the sheet — for split receipts that means *after* the tax/fees remainder has
 * been folded in, not the raw category subtotal.
 */
export function txNoteKey(sheetId, category, vendor, amount) {
  // Trimmed as well as lowercased: addOrUpdateExpense writes vendor.trim() to
  // the sheet, so a padded vendor here would key the note differently from the
  // value the ledger reads back — and a note under an unread key is invisible
  // rather than broken. AddExpenseDialog already trimmed; nothing else did.
  return `${sheetId}_${category}_${(vendor || '').trim().toLowerCase()}_${Number(amount).toFixed(2)}`;
}
