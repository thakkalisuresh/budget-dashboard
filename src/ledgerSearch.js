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

  // Amount queries are typed the way people read money: "$1,234.50", "₹45".
  // Rows are matched against plain digits, so strip separators/symbols first.
  const aq = normalizeAmountQuery(q);
  if (aq) {
    const amt = Number(t?.amount);
    if (Number.isFinite(amt) && amountContains(amt, aq)) return true;
    if (typeof receiptTotal === 'number' && amountContains(receiptTotal, aq)) return true;
  }

  return false;
}

/**
 * Reduce a typed query to digits and at most one '.', or '' if it isn't a
 * plausible amount fragment (so "," or "$" alone never match every row).
 */
export function normalizeAmountQuery(q) {
  const cleaned = String(q ?? '').replace(/[^0-9.]/g, '');
  if (!/\d/.test(cleaned) || (cleaned.match(/\./g) || []).length > 1) return '';
  return cleaned;
}

function amountContains(amount, aq) {
  const abs = Math.abs(amount);
  return abs.toFixed(2).includes(aq) || String(Math.floor(abs)).includes(aq);
}
