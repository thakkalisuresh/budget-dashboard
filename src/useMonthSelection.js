// ════════════════════════════════════════════════════════════════════════════
// useMonthSelection.js — decide which month (= which sheet tab) is being viewed.
// Each budget month is its own Google Sheet. This hook lists the available
// months, auto-picks a sensible default (the current calendar month, else the
// latest), and holds the small bits of UI state for the new/delete-month dialogs.
// ════════════════════════════════════════════════════════════════════════════
import { useState, useMemo, useEffect } from 'react';
import { useMonths } from './useMonths.js';

export function useMonthSelection(accessToken, allowedEmails) {
  // Delegate the actual list/create/delete of months to the useMonths hook.
  const { months, loading: monthsLoading, createMonth, deleteMonth, shareAllMonths } =
    useMonths(accessToken, allowedEmails);

  const defaultSheetId = import.meta.env.VITE_SHEET_ID;     // fallback sheet id from env
  const [selectedSheetId, setSelectedSheetId] = useState(defaultSheetId); // which month is open
  const [showNewMonth, setShowNewMonth]     = useState(false);  // is the "new month" dialog open?
  const [deleteConfirm, setDeleteConfirm]   = useState(null);   // month awaiting delete confirmation
  const [deleteInput, setDeleteInput]       = useState('');     // text typed to confirm a delete

  // Build a label like "June 2026" for the current calendar month. useMemo caches
  // the result; the empty [] dependency means "compute this once and reuse it".
  const currentMonthLabel = useMemo(() => {
    const now = new Date();
    return `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;
  }, []);

  // Once the month list loads, auto-select the current month if present, else the newest.
  useEffect(() => {
    if (months.length === 0) return;
    const match = months.find(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());
    setSelectedSheetId(match ? match.sheetId : months[months.length - 1].sheetId);
  }, [months, currentMonthLabel]);

  // The full month object matching the currently selected id.
  const selectedMonth = months.find(m => m.sheetId === selectedSheetId);

  // Is the selected month already in the past? (Drives "this month has ended" hints.)
  const isMonthEnded = useMemo(() => {
    if (!selectedMonth) return false;
    const monthStart = new Date(`${selectedMonth.name} 1`);
    const now = new Date();
    return monthStart < new Date(now.getFullYear(), now.getMonth(), 1);
  }, [selectedMonth]);

  // True when the current calendar month has no sheet yet (prompt to create one).
  const currentMonthMissing = !monthsLoading && months.length > 0 &&
    !months.some(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());

  // Hand the UI everything it needs to read or change about month selection.
  return {
    months, monthsLoading, createMonth, deleteMonth, shareAllMonths,
    selectedSheetId, setSelectedSheetId,
    selectedMonth, currentMonthLabel, isMonthEnded, currentMonthMissing,
    showNewMonth, setShowNewMonth,
    deleteConfirm, setDeleteConfirm,
    deleteInput, setDeleteInput,
  };
}
