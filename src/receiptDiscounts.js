// ════════════════════════════════════════════════════════════════════════════
// receiptDiscounts.js — net Costco-style instant-savings lines into the item
// they discount, so a coupon never lands in a budget category as its own line.
//
// The bug this exists to kill: Costco prints a discount as its own line —
// `0000385751 / 1860911  −4.00` — referencing the article number of the item it
// reduces (the number after the `/`). The extractor used to read that as a line
// item with a negative amount, and the server sanitizer then `Math.abs()`-ed it
// into a +$4 PHANTOM CHARGE in whatever category it guessed. So a $4 saving
// became a $4 expense. (Confirmed live on two real receipts, 2026-10-05.)
//
// The fix is to net each discount into the product it names, by article code,
// BEFORE the item is categorized or grouped — leaving the item list all-positive
// products. Two input shapes are handled, because provider adherence to the
// extraction schema varies:
//   1. an explicit `discounts: [{ applies_to_code, amount }]` array (the schema
//      the prompts now ask for), and
//   2. a negative-amount entry that leaked into `items[]` (what a provider that
//      ignored the schema still produces) — treated as a discount signal and
//      removed from the product list so no negative can survive into a category.
//
// Reconciliation is the caller's existing job: both surfaces compute
// `remainder = printedTotal − sum(items)` and fold it into the largest category.
// Because the printed total already reflects every discount, netting the matched
// ones collapses that remainder to exactly tax, and an unmatched discount (OCR
// dropped the item line it referenced) or an over-discount overflow is absorbed
// by that same total-based reconciliation automatically. `remainderAdjustment`
// is returned for completeness and for any future caller that builds its
// remainder from discounts explicitly — a total-reconciling caller MUST ignore
// it and use `items` only, or the discount is counted twice.
//
// Pure: no network, no React, no Sheets — so the (fiddly) matching rules are
// testable without mocking anything.
//
// MIRROR: byte-identical below the marker with functions/lib/_receipt-discounts.mjs
// (the Cloud Functions bot cannot import client modules). Drift is silent: one
// surface would net discounts and the other wouldn't. Guarded by a drift test.
// ════════════════════════════════════════════════════════════════════════════

/** Round to cents the same way every money path in this app does. */
export function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Comparison key for an article code. Costco reprints the same number with
 * stray punctuation/leading zeros across the item line and the discount line
 * ("0000385751 / 1860911"), so compare on digits/letters only.
 */
export function normDiscountCode(code) {
  return String(code ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^0+(?=.)/, '');
}

/**
 * Net discounts into the items they reference.
 *
 * @param items     [{ name, amount, item_category?, code? }]
 * @param discounts [{ applies_to_code, amount }]  (amount is the saving; sign ignored)
 * @returns {
 *   items,                // products only, amounts reduced, clamped at 0, $0 lines dropped
 *   unmatched,            // [{ code, amount }] discounts that referenced no present item
 *   remainderAdjustment,  // ≤0, the discount dollars not absorbed by a product
 * }
 *
 * Matching rule (locked): a discount nets into the FIRST item whose code
 * matches — duplicate codes (Costco prints one discount line per discounted
 * unit) all resolve to that first match. Over-discount is clamped at 0 and the
 * overflow carries to remainderAdjustment. An unmatched discount is never
 * dropped: its full magnitude carries to remainderAdjustment.
 */
export function applyDiscounts(items = [], discounts = []) {
  const products = [];
  const signals = [];

  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    if (typeof it.amount === 'number' && isFinite(it.amount) && it.amount < 0) {
      // A discount the provider put in items[] instead of discounts[]. Pull it
      // out as a signal so no negative amount can reach a category total.
      signals.push({ code: it.code, amount: Math.abs(it.amount) });
    } else {
      products.push({ ...it });
    }
  }

  for (const d of Array.isArray(discounts) ? discounts : []) {
    if (!d) continue;
    const amt = Number(d.amount);
    if (!isFinite(amt) || amt === 0) continue;
    signals.push({ code: d.applies_to_code ?? d.code, amount: Math.abs(amt) });
  }

  const unmatched = [];
  let remainderAdjustment = 0;
  // One discount per discounted unit: Costco prints one instant-savings line per
  // unit, so each discount nets the NEXT item sharing its code that hasn't been
  // discounted yet. Two $17.99 units with a $4 line each then read $13.99 +
  // $13.99, not $9.99 + $17.99 — which matters once the per-item breakdown is
  // shown. Category totals are identical either way.
  const discounted = new Set();

  for (const sig of signals) {
    const key = normDiscountCode(sig.code);
    const idx = key
      ? products.findIndex((p, i) => !discounted.has(i) && typeof p.amount === 'number' && normDiscountCode(p.code) === key)
      : -1;
    if (idx === -1) {
      // No un-discounted unit for this code. A code not present at all is a
      // genuinely unmatched discount (OCR dropped the item); an "extra" beyond
      // the matching units simply has nowhere to land. Either way the dollars
      // fold into the remainder rather than being dropped.
      const codeExists = key && products.some(p => typeof p.amount === 'number' && normDiscountCode(p.code) === key);
      if (!codeExists) unmatched.push({ code: sig.code ?? null, amount: sig.amount });
      remainderAdjustment = round2(remainderAdjustment - sig.amount);
      continue;
    }
    const target = products[idx];
    discounted.add(idx);
    const applied = Math.min(target.amount, sig.amount);
    target.amount = round2(target.amount - applied);
    // Remember the saving on the unit so the split note can show "was $X, −$Y".
    target.discount = round2((Number(target.discount) || 0) + applied);
    const carry = round2(sig.amount - applied);
    if (carry > 0) remainderAdjustment = round2(remainderAdjustment - carry);
  }

  // Drop items a coupon zeroed out — a $0 line is nothing to categorize or add,
  // and keeping it would create an empty category entry. Non-numeric amounts are
  // left untouched for the caller's existing guards to skip.
  const netted = products.filter(p => typeof p.amount !== 'number' || p.amount > 0.005);
  return { items: netted, unmatched, remainderAdjustment };
}
