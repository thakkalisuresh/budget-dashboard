import { useState } from 'react';
import { hasDetail } from './fetchDetail.js';
import { fetchDetailRows, updateCategoryBudget, writeSalary } from './sheetsApi.js';

export function useDashboardHandlers({ accessToken, sheetId, monthName, refresh, updateSettings, onLedgerChanged }) {
  const [detail, setDetail]                 = useState(null);
  const [editingBudgetId, setEditingBudgetId] = useState(null);
  const [budgetDraft, setBudgetDraft]       = useState('');
  const [editingSalary, setEditingSalary]   = useState(false);
  const [iconPickerFor, setIconPickerFor]   = useState(null);

  /**
   * Open a category's detail panel. `highlight` (optional) identifies the specific
   * transaction to scroll to and flash — set when arriving from a ledger row, so
   * tapping a search result lands on that exact charge rather than the top of a
   * long list.
   */
  const handleExpenseClick = async (name, highlight = null) => {
    if (!hasDetail(name)) return;
    setDetail({ expense: name, rows: null, loading: true, highlight });
    try {
      const rows = await fetchDetailRows(name, accessToken, sheetId, monthName);
      setDetail({ expense: name, rows, loading: false, highlight });
    } catch {
      setDetail({ expense: name, rows: [], loading: false, highlight });
    }
  };

  const handleDetailRefresh = async () => {
    if (!detail) return;
    try {
      const rows = await fetchDetailRows(detail.expense, accessToken, sheetId, monthName);
      setDetail(d => ({ ...d, rows, loading: false }));
      refresh();
      // Every in-panel mutation lands here — edits, deletes, card changes, vendor
      // renames. Without this the Ledger kept serving its own cache (2 min in
      // memory, an hour in localStorage) and silently disagreed with the panel.
      onLedgerChanged?.();
    } catch {
      // keep existing rows on failure
    }
  };

  const handleSaveBudget = async (item) => {
    const newBudget = parseFloat(budgetDraft);
    if (isNaN(newBudget) || newBudget < 0) { setEditingBudgetId(null); return; }
    try {
      await updateCategoryBudget(sheetId, accessToken, {
        rowNum: item.index_ + 1,
        budget: newBudget,
        categoryName: item.name,
      });
      refresh();
    } catch (e) {
      alert(`Failed to update budget: ${e.message}`);
    } finally {
      setEditingBudgetId(null);
    }
  };

  const handleSaveSalary = async (newSalary) => {
    try {
      await writeSalary(sheetId, newSalary, accessToken);
      refresh();
    } catch (e) {
      alert(`Failed to update salary: ${e.message}`);
    } finally {
      setEditingSalary(false);
    }
  };

  const handleSetIcon = (categoryName, emoji) => {
    updateSettings(prev => ({
      ...prev,
      categoryIcons: { ...(prev.categoryIcons || {}), [categoryName]: emoji },
    }));
    setIconPickerFor(null);
  };

  return {
    detail, setDetail,
    editingBudgetId, setEditingBudgetId, budgetDraft, setBudgetDraft,
    editingSalary, setEditingSalary,
    iconPickerFor, setIconPickerFor,
    handleExpenseClick, handleDetailRefresh,
    handleSaveBudget, handleSaveSalary, handleSetIcon,
  };
}
