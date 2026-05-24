import { useState, useEffect, useRef, useCallback } from 'react';
import { fetchNonMonthlyItems, migrateNonMonthlyFromI4 } from './sheetsApi.js';

/**
 * Manages non-monthly expense state: fetching, one-time migration, and refresh.
 */
export function useNonMonthlyExpenses(selectedSheetId, accessToken) {
  const [nonMonthlyItems, setNonMonthlyItems] = useState([]);
  const [nonMonthlyTick, setNonMonthlyTick] = useState(0);
  const refreshNonMonthly = useCallback(() => setNonMonthlyTick(t => t + 1), []);
  const migratedSheets = useRef(new Set());

  useEffect(() => {
    if (!selectedSheetId || !accessToken) return;
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
        if (!cancelled) setNonMonthlyItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSheetId, accessToken, nonMonthlyTick]);

  return { nonMonthlyItems, refreshNonMonthly };
}
