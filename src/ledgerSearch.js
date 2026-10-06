// ════════════════════════════════════════════════════════════════════════════
// ledgerSearch.js — the ledger search-match rule, extracted so it is testable
// without rendering the ledger (the project has no React render harness).
//
// A split receipt writes one row per category, each with its own subtotal — no
// row equals the receipt total, so searching the total used to find nothing. The
// split save now stamps the whole-receipt total onto each row's note; LedgerTab
// resolves that `receiptTotal` from the note and passes it in here, so typing the
// total surfaces every row of that split. Matching is PARTIAL (substring), the
// same rule the row's own amount already used.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Does a ledger row match the search query?
 *
 * @param t             { vendor, category, amount }
 * @param query         raw search string
 * @param receiptTotal  the split total stamped on the row's note, or null
 */
export function rowMatchesQuery(t, query, receiptTotal = null) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;

  if ((t?.vendor || '').toLowerCase().includes(q)) return true;
  if ((t?.category || '').toLowerCase().includes(q)) return true;

  const amt = Number(t?.amount);
  if (Number.isFinite(amt) && (amt.toFixed(2).includes(q) || String(Math.floor(amt)).includes(q))) return true;

  if (typeof receiptTotal === 'number' &&
      (receiptTotal.toFixed(2).includes(q) || String(Math.floor(receiptTotal)).includes(q))) return true;

  return false;
}
