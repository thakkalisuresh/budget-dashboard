import React, { useState } from 'react';
import { resolveImportDate } from './recurringExpenses.js';
import { X, Plus, ChevronRight, ChevronLeft, ChevronDown, ChevronUp } from 'lucide-react';
import {
  fetchTotalsForEdit, writeSalary, writeBudgetAmounts,
  addCategoryToTotals, createCategoryDetailSheet, linkCategoryToDetailSheet,
} from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';

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
  // index → edited amount string. Absent means "use the template's amount".
  const [recurringAmounts, setRecurringAmounts] = useState({});

  const hasRecurring   = recurringExpenses.length > 0;
  const totalSteps     = hasRecurring ? 3 : 2;

  // Shared
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const fieldCls   = "w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all";
  const fieldStyle = { background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' };
  const selectCls  = fieldCls + " cursor-pointer";
  const inputCls   = fieldCls;

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
        await writeSalary(newMonth.sheetId, salaryVal, accessToken, name);
      }

      // Write modified built-in budget amounts
      const modified = budgetRows.filter(r => r.modified && !r.isCustom);
      if (modified.length > 0) {
        await writeBudgetAmounts(
          newMonth.sheetId,
          // categoryName is warehouse-only: rowNum alone would archive the
          // budget under a null category, which is the partition/cluster key.
          modified.map(r => ({ rowNum: r.rowNum, amount: parseFloat(r.amount) || 0, categoryName: r.name })),
          accessToken,
          name,
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
      const monthIndex = MONTHS.indexOf(month);
      for (const [i, exp] of recurringExpenses.entries()) {
        if (!selectedRecurring.has(i)) continue;
        const edited = parseFloat(recurringAmounts[i]);
        const amount = Number.isFinite(edited) && edited > 0 ? edited : exp.amount;
        // Entries saved before day/card existed have neither; resolveImportDate
        // falls back to the 1st and clamps into the target month.
        await addOrUpdateExpense(
          exp.category, exp.vendor, amount,
          accessToken, newMonth.sheetId, name, 'recurring',
          resolveImportDate(exp, Number(year), monthIndex),
          exp.card || ''
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
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-md overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'var(--sur-20)' }} />

          {/* Header */}
          <div className="px-8 pt-8 pb-6 flex items-center justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>New Month</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {step === 1 ? 'Select the month to create'
                  : step === 2 ? `Setting up ${month} ${year}`
                  : 'Review recurring expenses'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {/* Step indicator */}
              <div className="flex gap-1.5">
                {Array.from({ length: totalSteps }, (_, i) => (
                  <div
                    key={i}
                    className="w-2 h-2 rounded-full transition-colors"
                    style={{ background: step === i + 1 ? 'var(--color-accent)' : 'var(--sur-15)' }}
                  />
                ))}
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
              >
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
                    <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Month</label>
                    <select value={month} onChange={e => setMonth(e.target.value)} className={selectCls} style={fieldStyle}>
                      <option value="">Select…</option>
                      {MONTHS.map(m => {
                        const taken = existingMonths.some(e => e.name.toLowerCase() === `${m} ${year}`.toLowerCase());
                        return <option key={m} value={m} disabled={taken}>{m}{taken ? ' ✓' : ''}</option>;
                      })}
                    </select>
                  </div>
                  <div className="w-28 space-y-1.5">
                    <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Year</label>
                    <select value={year} onChange={e => setYear(e.target.value)} className={selectCls} style={fieldStyle}>
                      {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                  </div>
                </div>

                {month && (
                  <p className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>
                    Will create: <span className="font-black" style={{ color: 'var(--color-accent-text)' }}>{month} {year}</span>
                  </p>
                )}
              </>
            )}

            {/* ── STEP 2 ── */}
            {step === 2 && (
              <>
                {/* Salary */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                    Monthly Income / Salary
                  </label>
                  <div className="relative">
                    <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={salary}
                      onChange={e => setSalary(e.target.value)}
                      className={`${inputCls} pl-8`}
                      style={fieldStyle}
                      autoFocus
                    />
                  </div>
                </div>

                {/* Budget review — collapsible */}
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--sur-10)' }}>
                  <button
                    type="button"
                    onClick={() => setBudgetsOpen(o => !o)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm font-black transition-colors"
                    style={{ background: 'var(--sur-5)', color: 'var(--color-text)' }}
                  >
                    <span>Edit budget amounts</span>
                    <div className="flex items-center gap-2">
                      {loadingBudgets && (
                        <svg className="w-4 h-4 animate-spin" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                        </svg>
                      )}
                      <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }}>Optional</span>
                      {budgetsOpen
                        ? <ChevronUp className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                        : <ChevronDown className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />}
                    </div>
                  </button>

                  {budgetsOpen && (
                    <div>
                      {budgetRows.length === 0 && !loadingBudgets && (
                        <p className="text-xs text-center py-4" style={{ color: 'var(--color-text-muted)' }}>No budget rows found</p>
                      )}
                      {(() => {
                        const totalBudget = budgetRows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
                        return budgetRows.map((r, idx) => {
                          const pct = totalBudget > 0 ? ((parseFloat(r.amount) || 0) / totalBudget * 100).toFixed(1) : '0.0';
                          return (
                            <div
                              key={r.isCustom ? `custom-${r.name}` : r.rowNum}
                              className="flex items-center gap-3 px-4 py-2.5"
                              style={idx > 0 ? { borderTop: '1px solid var(--sur-6)' } : {}}
                            >
                              <span className="flex-1 flex items-center gap-1.5 min-w-0">
                                <span className="text-sm font-medium truncate" style={{ color: 'var(--color-text)' }}>{r.name}</span>
                                {r.isCustom && (
                                  <span
                                    className="flex-shrink-0 text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                                    style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' }}
                                  >
                                    Custom
                                  </span>
                                )}
                              </span>
                              <span className="text-xs font-bold w-10 text-right flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>{pct}%</span>
                              <div className="relative w-28 flex-shrink-0">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs" style={{ color: 'var(--color-text-muted)' }}>$</span>
                                <input
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={r.amount}
                                  onChange={e => updateBudgetRow(r.rowNum, r.name, e.target.value)}
                                  className="w-full rounded-xl pl-6 pr-2 py-1.5 text-sm outline-none tabular-nums"
                                  style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
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
                <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                  These will be written into {month} {year} automatically. Uncheck anything you want to skip this month.
                </p>
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--sur-10)' }}>
                  {recurringExpenses.map((exp, i) => {
                    const checked = selectedRecurring.has(i);
                    return (
                      <label
                        key={i}
                        className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors"
                        style={i > 0 ? { borderTop: '1px solid var(--sur-6)' } : {}}
                      >
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
                          <div
                            className="w-5 h-5 rounded-md flex items-center justify-center transition-colors"
                            style={{
                              background: checked ? 'var(--color-success)' : 'var(--sur-5)',
                              border: checked ? '2px solid var(--color-success)' : '2px solid var(--sur-20)',
                            }}
                          >
                            {checked && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                          </div>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{exp.vendor}</p>
                          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{exp.category}</p>
                        </div>
                        {/* Editable rather than fixed: the template stores one
                            amount, so a variable bill (utilities) would import
                            last month's number. Tick and ignore for a fixed
                            subscription; overwrite for anything that moves. */}
                        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.preventDefault()}>
                          <span className="text-sm font-black" style={{ color: 'var(--color-text-muted)' }}>$</span>
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            value={recurringAmounts[i] ?? exp.amount}
                            onChange={e => setRecurringAmounts(prev => ({ ...prev, [i]: e.target.value }))}
                            className="w-20 rounded-lg px-2 py-1 text-sm font-black text-right outline-none"
                            style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
                          />
                        </div>
                      </label>
                    );
                  })}
                </div>
                <p className="text-[11px] text-center" style={{ color: 'var(--color-text-muted)' }}>
                  {selectedRecurring.size} of {recurringExpenses.length} selected
                </p>
              </div>
            )}

            {error && (
              <p className="text-xs font-medium px-4 py-2.5 rounded-xl" style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>
                {error}
              </p>
            )}

            {saving && (
              <p className="text-xs font-medium text-center" style={{ color: 'var(--color-accent-text)' }}>
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
                className="flex items-center gap-1 px-4 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}
            {step === 3 && (
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={saving}
                className="flex items-center gap-1 px-4 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}
              >
                <ChevronLeft className="w-4 h-4" /> Back
              </button>
            )}

            {/* Cancel (step 1 only) */}
            {step === 1 && (
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
                style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}
              >
                Cancel
              </button>
            )}

            {/* Primary action */}
            {step === 1 && (
              <button
                type="button"
                onClick={handleNext}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                style={{ background: 'var(--color-accent)' }}
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {step === 2 && hasRecurring && (
              <button
                type="button"
                onClick={() => setStep(3)}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] flex items-center justify-center gap-2"
                style={{ background: 'var(--color-accent)' }}
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
            )}
            {(step === 3 || (step === 2 && !hasRecurring)) && (
              <button
                type="button"
                onClick={handleCreate}
                disabled={saving}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                style={{ background: 'var(--color-accent)' }}
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
