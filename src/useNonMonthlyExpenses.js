// ════════════════════════════════════════════════════════════════════════════
// useNonMonthlyExpenses.js — manage "non-monthly" (one-off) expenses for a month.
// These are irregular costs tracked separately from the recurring categories. The
// hook fetches them, runs a one-time migration from an older storage cell, and
// hands back a `refresh` function the rest of the app calls after making edits.
// ════════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchNonMonthlyItems, migrateNonMonthlyFromI4 } from './sheetsApi.js';

/**
 * Manages non-monthly expense state: fetching, one-time migration, and refresh.
 */
export function useNonMonthlyExpenses(selectedSheetId, accessToken) {
  const [nonMonthlyItems, setNonMonthlyItems] = useState([]);
  // A "tick" counter: bumping it re-runs the fetch effect below. A common trick
  // for a manual refresh that reuses the existing fetch logic instead of copying it.
  const [nonMonthlyTick, setNonMonthlyTick] = useState(0);
  const refreshNonMonthly = useCallback(() => setNonMonthlyTick(t => t + 1), []);
  // Remember which sheets we've already migrated so the migration runs only once each.
  const migratedSheets = useRef(new Set());

  useEffect(() => {
    if (!selectedSheetId || !accessToken) return;
    // `cancelled` guards a race: if the sheet changes mid-fetch, we discard the
    // stale result instead of overwriting the newly-selected month's data.
    let cancelled = false;
    (async () => {
      try {
        let items = await fetchNonMonthlyItems(selectedSheetId, accessToken);
        // One-time migration from legacy I4 cell for months that predate this feature
        if (items.length === 0 && !migratedSheets.current.has(selectedSheetId)) {
          migratedSheets.current.add(selectedSheetId);
          await migrateNonMonthlyFromI4(selectedSheetId, accessToken);
          items = await fetchNonMonthlyItems(selectedSheetId, accessToken);
        }
        if (!cancelled) setNonMonthlyItems(items);
      } catch {
        if (!cancelled) setNonMonthlyItems([]);   // on any error, fall back to an empty list
      }
    })();
    return () => { cancelled = true; };   // cleanup flips the guard when deps change/unmount
  }, [selectedSheetId, accessToken, nonMonthlyTick]);

  return { nonMonthlyItems, refreshNonMonthly };
}
