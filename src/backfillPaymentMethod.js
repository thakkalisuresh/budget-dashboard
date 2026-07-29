// ════════════════════════════════════════════════════════════════════════════
// backfillPaymentMethod.js — find and fix transactions with no payment method.
//
// The Split tab derives "who spent this" entirely from the card (see
// cardOwners.js), so a transaction with no payment method can't be attributed
// to anyone. Today those rows don't show up as "unassigned" — they're skipped
// outright and vanish from the split, which quietly understates both totals.
//
// This module finds them and writes a card back to the sheet. Pure logic and
// network calls only; the UI lives in SplitTab.jsx.
// ════════════════════════════════════════════════════════════════════════════
import { fetchDetailRows } from './sheetDetail.js';
import { updatePaymentMethod } from './sheetExpenses.js';
import { updateHistoryPaymentMethod } from './sheetHistory.js';

/**
 * A payment method that exists but belongs to nobody. Offered alongside the
 * user's real cards because cardOwners.js treats unlisted methods like 'Cash'
 * as deliberately unowned — assigning it moves a row out of the invisible pile
 * and into the visible "Unassigned" bucket, which is a real answer, not a
 * workaround.
 */
export const CASH_OPTION = 'Cash';

/** Card options for the picker: the user's cards, with Cash always available. */
export function buildCardOptions(cards = []) {
  const list = (cards || []).filter(Boolean);
  return list.includes(CASH_OPTION) ? list : [...list, CASH_OPTION];
}

/**
 * Scan every category tab for rows with no payment method.
 *
 * One request per category, so this is deliberately caller-triggered (the
 * panel loads on expand) rather than run as part of the Split tab's normal
 * load. fetchDetailRows is cached, so re-opening the panel is usually free.
 *
 * A category that fails to load is skipped rather than aborting the scan — a
 * partial list is more useful than an error, and the missing rows simply
 * reappear next time.
 */
export async function collectMethodlessRows(categoryNames, accessToken, sheetId, monthName = '') {
  const out = [];
  for (const category of categoryNames) {
    let rows;
    try {
      rows = await fetchDetailRows(category, accessToken, sheetId, monthName);
    } catch {
      continue;
    }
    for (const row of rows || []) {
      if (String(row.paymentMethod || '').trim()) continue;
      const total = (row.amounts || []).reduce((sum, a) => sum + (Number(a) || 0), 0);
      if (!total) continue; // empty/placeholder row, nothing to attribute
      out.push({
        // rowIndex + category is what identifies the sheet row to write;
        // uuids are what identify the matching History rows to patch.
        key: `${category}:${row.rowIndex}`,
        category,
        rowIndex: row.rowIndex,
        uuids: (row.uuids || []).filter(Boolean),
        description: row.description || '',
        amount: total,
        date: row.date || '',
      });
    }
  }
  // Biggest first: the rows that most distort the split are worth fixing first.
  return out.sort((a, b) => b.amount - a.amount);
}

/**
 * Write the chosen card for each assigned row.
 *
 * Both sides have to be written: updatePaymentMethod sets column F on the
 * category tab (the source of truth), while the Split tab actually reads
 * History — so without the History patch the row would still be missing from
 * the split until the next full re-import.
 *
 * Deliberately tolerant: one failed row does not abort the rest, and a row is
 * only reported as saved if its category-tab write succeeded. A failed History
 * patch is downgraded to a warning, because the sheet is then correct and the
 * split catches up on its own.
 */
export async function saveAssignments(assignments, accessToken, sheetId, onProgress) {
  const results = { saved: [], failed: [] };
  let done = 0;

  for (const { row, card } of assignments) {
    try {
      await updatePaymentMethod(row.category, row.rowIndex, card, accessToken, sheetId);
      for (const uuid of row.uuids) {
        try {
          await updateHistoryPaymentMethod(sheetId, accessToken, uuid, card);
        } catch (e) {
          console.warn(`backfill: History patch failed for ${uuid}`, e?.message);
        }
      }
      results.saved.push(row.key);
    } catch (e) {
      results.failed.push({ key: row.key, error: e?.message || 'write failed' });
    }
    done += 1;
    onProgress?.(done, assignments.length);
  }

  return results;
}
