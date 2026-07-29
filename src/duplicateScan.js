// ════════════════════════════════════════════════════════════════════════════
// duplicateScan.js — find duplicates already sitting in the month's sheet, and
// remove the ones the user doesn't want to keep.
//
// The prevention half (functions/lib/_bot-core.mjs) stops most duplicates at
// the confirm prompt. This is for the ones that got past it: charges logged
// automatically from a wallet notification with nobody in the loop, imports,
// and anything logged before prevention existed.
// ════════════════════════════════════════════════════════════════════════════
import { fetchDetailRows } from './sheetDetail.js';
import { updateVendorAmounts } from './sheetExpenses.js';
import { clusterDuplicates } from './duplicateMatch.js';

/**
 * Flatten every category tab into individual transactions.
 *
 * A sheet row can hold several amounts for one vendor, and each of those is a
 * separate transaction that can be separately duplicated — so the unit here is
 * the amount, not the row. amtIndex is what makes a single one removable later.
 *
 * A category that fails to load is skipped rather than aborting the scan: a
 * partial answer is still useful, and the missing rows show up next time.
 */
export async function flattenTransactions(categoryNames, accessToken, sheetId, monthName = '') {
  const out = [];
  for (const category of categoryNames) {
    let rows;
    try {
      rows = await fetchDetailRows(category, accessToken, sheetId, monthName);
    } catch {
      continue;
    }
    for (const row of rows || []) {
      (row.amounts || []).forEach((amount, amtIndex) => {
        if (!Number.isFinite(Number(amount)) || Number(amount) === 0) return;
        out.push({
          key: `${category}:${row.rowIndex}:${amtIndex}`,
          category,
          rowIndex: row.rowIndex,
          amtIndex,
          amount: Number(amount),
          vendor: row.description || '',
          date: row.date || '',
          paymentMethod: row.paymentMethod || '',
          uuid: (row.uuids || [])[amtIndex] || '',
          // Carried so a delete can rewrite the row without re-fetching it.
          amounts: row.amounts || [],
          uuids: row.uuids || [],
          _v2: row._v2,
        });
      });
    }
  }
  return out;
}

/**
 * Clusters of transactions that look like the same purchase, across all tabs.
 * Cross-tab matters: a wallet charge lands in Misc while the receipt for the
 * same purchase gets filed under Grocery.
 */
export async function scanDuplicates(categoryNames, accessToken, sheetId, monthName = '') {
  const all = await flattenTransactions(categoryNames, accessToken, sheetId, monthName);
  return clusterDuplicates(all);
}

/**
 * Suggest which member of a cluster to keep.
 *
 * A row with a payment method is worth more than one without — the Split tab
 * can attribute it to a person, and it's usually the receipt-backed copy
 * rather than the bare wallet notification. Ties break toward the earliest
 * date, which is the original rather than the re-log. This is only a default
 * selection; nothing is deleted without the user confirming.
 */
export function suggestKeeper(cluster) {
  return [...cluster].sort((a, b) => {
    const carded = (x) => (x.paymentMethod ? 0 : 1);
    if (carded(a) !== carded(b)) return carded(a) - carded(b);
    return String(a.date || '').localeCompare(String(b.date || ''));
  })[0];
}

/**
 * Delete the given transactions.
 *
 * Grouped by sheet row before writing, because removing two amounts from the
 * same row one at a time would shift the indices under the second delete. All
 * indices for a row are dropped in a single rewrite instead.
 *
 * Tolerant: a row that fails doesn't stop the others, and the caller is told
 * exactly which rows survived so it can leave them on screen.
 */
export async function deleteTransactions(entries, accessToken, sheetId, onProgress) {
  const byRow = new Map();
  for (const e of entries) {
    const rowKey = `${e.category}:${e.rowIndex}`;
    if (!byRow.has(rowKey)) byRow.set(rowKey, { entry: e, indices: [] });
    byRow.get(rowKey).indices.push(e.amtIndex);
  }

  const results = { deleted: [], failed: [] };
  let done = 0;

  for (const [rowKey, { entry, indices }] of byRow) {
    const drop = new Set(indices);
    const newAmounts = (entry.amounts || []).filter((_, i) => !drop.has(i));
    const newUuids   = (entry.uuids   || []).filter((_, i) => !drop.has(i));
    const prevTotal  = (entry.amounts || []).reduce((a, b) => a + Number(b || 0), 0);
    try {
      await updateVendorAmounts(
        entry.category, entry.rowIndex, newAmounts, accessToken, sheetId,
        entry.vendor, prevTotal, newUuids, entry._v2,
      );
      results.deleted.push(rowKey);
    } catch (e) {
      results.failed.push({ rowKey, error: e?.message || 'delete failed' });
    }
    done += 1;
    onProgress?.(done, byRow.size);
  }

  return results;
}
