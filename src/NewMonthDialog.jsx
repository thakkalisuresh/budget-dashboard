import React, { useState } from 'react';
import { X, Plus, ChevronRight, ChevronLeft, ChevronDown, ChevronUp } from 'lucide-react';
import {
  fetchTotalsForEdit, writeSalary, writeBudgetAmounts,
  addCategoryToTotals, createCategoryDetailSheet, linkCategoryToDetailSheet,
  addOrUpdateExpense,
} from './sheetsApi.js';

const TEMPLATE_ID = import.meta.env.VITE_TEMPLATE_SHEET_ID;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const currentYear = new Date().getFullYear();
const YEARS = [currentYear - 1, currentYear, currentYear + 1];

// Rows to exclude from budget editing
const EXCLUDED_ROWS = ['expense', 'total expenses', 'moving exp', ''];

export function NewMonthDialog({ onClose, onCreate, existingMonths = [], accessToken, customCategories = [], recurringExpenses = [] }) {
  // Step 1 state
  const [month, setMonth]   = useState('');
  const [year, setYear]     = useState(String(currentYear));

  // Step 2 state
  const [step, setStep]             = useState(1);
  const [salary, setSalary]         = useState('');
  const [budgetRows, setBudgetRows] = useState([]);  // [{rowNum, name, amount, modified}]
  const [budgetsOpen, setBudgetsOpen] = useState(false);
  const [loadingBudgets, setLoadingBudgets] = useState(false);

  // Step 3 state — Set of indices into recurringExpenses that are selected
  const [selectedRecurring, setSelectedRecurring] = useState(() =>
    new Set(recurringExpenses.map((_, i) => i))
  );

  const hasRecurring   = recurringExpenses.length > 0;
  const totalSteps     = hasRecurring ? 3 : 2;

  // Shared
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const selectCls = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all cursor-pointer";
  const inputCls  = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400";

  // ── Step 1 → Step 2 ──────────────────────────────────────────────────────
  const handleNext = async () => {
    setError('');
    if (!month) { setError('Please select a month.'); return; }
    const name = `${month} ${year}`;
    if (existingMonths.some(m => m.name.toLowerCase() === name.toLowerCase())) {
      setError(`${name} already exists.`);
      return;
    }
    setStep(2);
    setSelectedRecurring(new Set(recurringExpenses.map((_, i) => i)));
    setLoadingBudgets(true);
    try {
      // Read budgets from the template sheet as defaults
      const rows = await fetchTotalsForEdit(TEMPLATE_ID, accessToken);
      const expenseRows = rows.filter(r => {
        const name = String(r.row[0] || '').trim().toLowerCase();
        return name && !EXCLUDED_ROWS.includes(name) && typeof r.row[0] === 'string';
      });
      const builtInRows = expenseRows.map(r => ({
        rowNum: r.rowNum,
        name: String(r.row[0]),
        amount: r.row[2] ?? 0,
        modified: false,
        isCustom: false,
      }));
      const customRows = (customCategories || []).map(n => ({
        rowNum: null,
        name: n,
        amount: 0,
        modified: false,
        isCustom: true,
      }));
      setBudgetRows([...builtInRows, ...customRows]);
    } catch (e) {
      console.warn('Could not load template budgets:', e);
      setBudgetRows([]);
    } finally {
      setLoadingBudgets(false);
    }
  };

  const updateBudgetRow = (rowNum, name, value) => {
    setBudgetRows(prev => prev.map(r =>
      (r.isCustom ? r.name === name : r.rowNum === rowNum)
        ? { ...r, amount: value, modified: true }
        : r
    ));
  };

  // ── Step 2 → Create ──────────────────────────────────────────────────────
  const handleCreate = async () => {
    setError('');
    setSaving(true);
    try {
      const name = `${month} ${year}`;
      const newMonth = await onCreate(name);
      if (!newMonth?.sheetId) throw new Error('Month created but sheet ID missing');

      // Write salary if provided
      const salaryVal = parseFloat(salary);
      if (!isNaN(salaryVal) && salaryVal > 0) {
        await writeSalary(newMonth.sheetId, salaryVal, accessToken);
      }

      // Write modified built-in budget amounts
      const modified = budgetRows.filter(r => r.modified && !r.isCustom);
      if (modified.length > 0) {
        await writeBudgetAmounts(
          newMonth.sheetId,
          modified.map(r => ({ rowNum: r.rowNum, amount: parseFloat(r.amount) || 0 })),
          accessToken
        );
      }

      // Recreate custom categories in the new month's sheet
      const customRows = budgetRows.filter(r => r.isCustom);
      for (const row of customRows) {
        const budget = parseFloat(row.amount) || 0;
        await addCategoryToTotals(newMonth.sheetId, accessToken, { name: row.name, budget });
        await createCategoryDetailSheet(newMonth.sheetId, accessToken, { categoryName: row.name });
        await linkCategoryToDetailSheet(newMonth.sheetId, accessToken, { categoryName: row.name });
      }

      // Write selected recurring expenses into the new month's detail sheets
      for (const [i, exp] of recurringExpenses.entries()) {
        if (!selectedRecurring.has(i)) continue;
        await addOrUpdateExpense(
          exp.category, exp.vendor, exp.amount,
          accessToken, newMonth.sheetId, name, 'recurring', false
        );
      }

      onClose();
    } catch (e) {
      setError(e.message || 'Failed to create month. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          {/* Header */}
          <div className="px-8 pt-8 pb-6 flex items-center justify-between border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
            <div>
              <p className="text-lg font-black text-slate-800 dark:text-slate-100">New Month</p>
              <p className="text-xs text-slate-400 mt-0.5">
                {step === 1 ? 'Select the month to create'
                  : step === 2 ? `Setting up ${month} ${year}`
                  : 'Review recurring expenses'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* Step indicator */}
              <div className="flex gap-1.5">
                {Array.from({ length: totalSteps }, (_, i) => (
                  <div key={i} className={`w-2 h-2 rounded-full transition-colors ${step === i + 1 ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-slate-600'}`} />
                ))}
              </div>
              <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1 px-8 py-6 space-y-5">

            {/* ── STEP 1 ── */}
            {step === 1 && (
              <>
                <div className="flex gap-3">
                  <div className="flex-1 space-y-1.5">
                    <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Month</label>
                    <select value={month} onChange={e => setMonth(e.target.value)} className={selectCls}>
                      <option value="">Select…</option>
                      {MONTHS.map(m => {
                        const taken = existingMonths.some(e => e.name.toLowerCase() === `${m} ${year}`.toLowerCase());
                        return <option key={m} value={m} disabled={taken}>{m}{taken ? ' ✓' : ''}</option>;
                      })}
                    </select>
                  </div>
                  <div className="w-28 space-y-1.5">
                    <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Year</label>
                    <select value={year} onChange={e => setYear(e.target.value)} className={selectCls}>
                      {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                </div>

                {month && (
                  <p className="text-xs text-slate-400 font-medium">
                    Will create: <span className="text-indigo-500 font-black">{month} {year}</span>
                  </p>
                )}
              </>
            )}

            {/* ── STEP 2 ── */}
            {step === 2 && (
              <>
                {/* Salary */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">
                    Monthly Income / Salary
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={salary}
                      onChange={e => setSalary(e.target.value)}
                      className={`${inputCls} pl-8`}
                      autoFocus
                    />
                  </div>
                </div>

                {/* Budget review — collapsible */}
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setBudgetsOpen(o => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-700/50 text-sm font-black text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                  >
                    <span>Edit budget amounts</span>
                    <div className="flex items-center gap-2">
                      {loadingBudgets && (
                        <svg className="w-4 h-4 animate-spin text-slate-400" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                        </svg>
                      )}
                      <span className="text-[10px] font-medium text-slate-400">Optional</span>
                      {budgetsOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                    </div>
                  </button>

                  {budgetsOpen && (
                    <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
                      {budgetRows.length === 0 && !loadingBudgets && (
                        <p className="text-xs text-slate-400 text-center py-4">No budget rows found</p>
                      )}
                      {(() => {
                        const totalBudget = budgetRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
                        return budgetRows.map(r => {
                          const pct = totalBudget > 0 ? ((parseFloat(r.amount) || 0) / totalBudget * 100).toFixed(1) : '0.0';
                          return (
                            <div key={r.isCustom ? `custom-${r.name}` : r.rowNum} className="flex items-center gap-3 px-4 py-2.5">
                              <span className="flex-1 flex items-center gap-1.5 min-w-0">
                                <span className="text-sm text-slate-700 dark:text-slate-200 font-medium truncate">{r.name}</span>
                                {r.isCustom && (
                                  <span className="flex-shrink-0 text-[9px] font-black uppercase tracking-wider text-indigo-500 bg-indigo-50 dark:bg-indigo-900/40 px-1.5 py-0.5 rounded-full">
                                    Custom
                                  </span>
                                )}
                              </span>
                              <span className="text-xs font-bold text-slate-400 w-10 text-right flex-shrink-0">{pct}%</span>
                              <div className="relative w-28 flex-shrink-0">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={r.amount}
                                  onChange={e => updateBudgetRow(r.rowNum, r.name, e.target.value)}
                                  className="w-full bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-xl pl-6 pr-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 tabular-nums"
                                />
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── STEP 3 ── */}
            {step === 3 && (
              <div className="space-y-3">
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  These will be written into {month} {year} automatically. Uncheck anything you want to skip this month.
                </p>
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-700/50 overflow-hidden">
                  {recurringExpenses.map((exp, i) => {
                    const checked = selectedRecurring.has(i);
                    return (
                      <label key={i} className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors">
                        <div className="relative flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedRecurring(prev => {
                                const next = new Set(prev);
                                next.has(i) ? next.delete(i) : next.add(i);
                                return next;
                              });
                            }}
                            className="sr-only"
                          />
                          <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${checked ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}>
                            {checked && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{exp.vendor}</p>
                          <p className="text-xs text-slate-400">{exp.category}</p>
                        </div>
                        <span className="text-sm font-black text-slate-700 dark:text-slate-200 flex-shrink-0">
                          ${exp.amount.toFixed(2)}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[11px] text-slate-400 text-center">
                  {selectedRecurring.size} of {recurringExpenses.length} selected
                </p>
              </div>
            )}

            {error && (
              <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">
                {error}
              </p>
            )}

            {saving && (
              <p className="text-xs text-indigo-500 font-medium text-center">
                Creating {month} {year}… this may take a few seconds
              </p>
            )}
          </div>

          {/* Footer buttons */}
          <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            {/* Back button */}
            {step === 2 && (
              <button
                type="button"
                onClick={() => { setStep(1); setError(''); }}
                disabled={saving}
                className="flex items-center gap-1 px-4 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={saving}
                className="flex items-center gap-1 px-4 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}

            {/* Cancel (step 1 only) */}
            {step === 1 && (
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
            )}

            {/* Primary action */}
            {step === 1 && (
              <button
                type="button"
                onClick={handleNext}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 2 && hasRecurring && (
              <button
                type="button"
                onClick={() => setStep(3)}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {(step === 3 || (step === 2 && !hasRecurring)) && (
              <button
                type="button"
                onClick={handleCreate}
                disabled={saving}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving ? (
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                ) : <Plus className="w-4 h-4" />}
                {saving ? 'Creating…' : 'Create Month'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
