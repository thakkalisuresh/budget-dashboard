import { useState } from 'react';
import { hasDetail } from './fetchDetail.js';
import { fetchDetailRows, updateCategoryBudget, writeSalary } from './sheetsApi.js';

export function useDashboardHandlers({ accessToken, sheetId, monthName, refresh, updateSettings }) {
  const [detail, setDetail]                 = useState(null);
  const [editingBudgetId, setEditingBudgetId] = useState(null);
  const [budgetDraft, setBudgetDraft]       = useState('');
  const [editingSalary, setEditingSalary]   = useState(false);
  const [iconPickerFor, setIconPickerFor]   = useState(null);

  const handleExpenseClick = async (name) => {
    if (!hasDetail(name)) return;
    setDetail({ expense: name, rows: null, loading: true });
    try {
      const rows = await fetchDetailRows(name, accessToken, sheetId, monthName);
      setDetail({ expense: name, rows, loading: false });
    } catch {
      setDetail({ expense: name, rows: [], loading: false });
    }
  };

  const handleDetailRefresh = async () => {
    if (!detail) return;
    try {
      const rows = await fetchDetailRows(detail.expense, accessToken, sheetId, monthName);
      setDetail(d => ({ ...d, rows, loading: false }));
      refresh();
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
