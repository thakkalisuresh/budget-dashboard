// ════════════════════════════════════════════════════════════════════════════
// transactionNotes.js — the one place that knows how a transaction note is keyed.
//
// Notes live in settings.transactionNotes, keyed by sheet + category + vendor +
// amount. That key was previously rebuilt inline in three places (LedgerTab,
// DetailPanel, and now the split flow). Three copies of a format string is three
// chances to disagree — and a note written under a key nothing reads back is
// invisible rather than broken, so the drift would be silent.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Canonical note key.
 *
 * The amount is part of the key, so it must be the amount actually written to
 * the sheet — for split receipts that means *after* the tax/fees remainder has
 * been folded in, not the raw category subtotal.
 */
export function txNoteKey(sheetId, category, vendor, amount) {
  return `${sheetId}_${category}_${(vendor || '').toLowerCase()}_${Number(amount).toFixed(2)}`;
}
