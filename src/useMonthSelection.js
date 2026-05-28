import { useState, useMemo, useEffect } from 'react';
import { useMonths } from './useMonths.js';

export function useMonthSelection(accessToken, allowedEmails) {
  const { months, loading: monthsLoading, createMonth, deleteMonth, shareAllMonths } =
    useMonths(accessToken, allowedEmails);

  const defaultSheetId = import.meta.env.VITE_SHEET_ID;
  const [selectedSheetId, setSelectedSheetId] = useState(defaultSheetId);
  const [showNewMonth, setShowNewMonth]     = useState(false);
  const [deleteConfirm, setDeleteConfirm]   = useState(null);
  const [deleteInput, setDeleteInput]       = useState('');

  const currentMonthLabel = useMemo(() => {
    const now = new Date();
    return `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;
  }, []);

  useEffect(() => {
    if (months.length === 0) return;
    const match = months.find(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());
    setSelectedSheetId(match ? match.sheetId : months[months.length - 1].sheetId);
  }, [months, currentMonthLabel]);

  const selectedMonth = months.find(m => m.sheetId === selectedSheetId);

  const isMonthEnded = useMemo(() => {
    if (!selectedMonth) return false;
    const monthStart = new Date(`${selectedMonth.name} 1`);
    const now = new Date();
    return monthStart < new Date(now.getFullYear(), now.getMonth(), 1);
  }, [selectedMonth]);

  const currentMonthMissing = !monthsLoading && months.length > 0 &&
    !months.some(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());

  return {
    months, monthsLoading, createMonth, deleteMonth, shareAllMonths,
    selectedSheetId, setSelectedSheetId,
    selectedMonth, currentMonthLabel, isMonthEnded, currentMonthMissing,
    showNewMonth, setShowNewMonth,
    deleteConfirm, setDeleteConfirm,
    deleteInput, setDeleteInput,
  };
}
