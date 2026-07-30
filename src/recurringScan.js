// ════════════════════════════════════════════════════════════════════════════
// recurringScan.js — read past months so recurring expenses can be detected.
//
// Deliberately lighter than LedgerTab's buildLedger: detection only needs
// category, vendor, amount and date, so this skips the History fetch and the
// UUID/fuzzy reconciliation buildLedger does to work out *how* each transaction
// was logged. That halves the requests per month.
//
// Still request-heavy though — N months x ~16 categories. Concurrency is bounded
// and progress is reported so the UI can show it rather than appearing hung.
// ════════════════════════════════════════════════════════════════════════════
import { getAllCategoryNames, fetchDetailRows } from './sheetsApi.js';

/** Months scanned by default. Enough to see a quarterly pattern twice. */
export const DEFAULT_SCAN_MONTHS = 6;

/** Category fetches in flight at once. Sheets rate-limits per user per minute. */
const CONCURRENCY = 4;

async function mapWithLimit(items, limit, fn) {
  const results = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Flatten one month's category sheets into transactions.
 * A failed category yields nothing rather than failing the month — a single
 * missing tab shouldn't abort a six-month scan.
 */
export async function scanMonth(month, accessToken) {
  const categories = getAllCategoryNames();
  const perCategory = await mapWithLimit(categories, CONCURRENCY, async (cat) => {
    try {
      const rows = await fetchDetailRows(cat, accessToken, month.sheetId, month.name);
      return rows.flatMap(row =>
        (row.amounts || [])
          .filter(a => a > 0)
          .map(amount => ({
            category: cat,
            vendor: row.description,
            amount,
            txDate: row.date || '',
            paymentMethod: row.paymentMethod || '',
          }))
      );
    } catch {
      return [];
    }
  });
  return { monthKey: month.name, transactions: perCategory.flat() };
}

/**
 * Scan the most recent `limit` months, oldest → newest — the order
 * detectRecurring needs to spot a consecutive run.
 *
 * @param months    the app's month list, newest first (as useMonths provides)
 * @param onProgress ({ done, total }) => void
 */
export async function scanRecentMonths(months = [], accessToken, {
  limit = DEFAULT_SCAN_MONTHS,
  onProgress,
} = {}) {
  const recent = months.slice(0, limit);
  const total = recent.length;
  if (total === 0) return [];

  const out = [];
  let done = 0;
  onProgress?.({ done, total });

  // Sequential across months on purpose: each month already fans out across its
  // categories, and running months in parallel too would multiply into a burst
  // big enough to get rate-limited.
  for (const month of recent) {
    out.push(await scanMonth(month, accessToken));
    onProgress?.({ done: ++done, total });
  }

  return out.reverse();   // oldest → newest
}
