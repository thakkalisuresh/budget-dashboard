import React, { useState } from 'react';
import { X, FolderPlus, AlertCircle, Check } from 'lucide-react';
import {
  addCategoryToTotals,
  createCategoryDetailSheet,
  linkCategoryToDetailSheet,
  addCategoryTo503020,
  appendHistoryEntry,
} from './sheetsApi.js';
import { addCustomCategory } from './customCategories.js';

const STEPS = [
  'Adding to Totals sheet…',
  'Creating detail sheet…',
  'Linking to Totals…',
  'Adding to 50/30/20…',
  'Done!',
];

const TYPES = [
  {
    key: 'need',
    label: 'Need',
    desc: 'Essentials (rent, groceries, bills)',
    activeCls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600',
  },
  {
    key: 'want',
    label: 'Want',
    desc: 'Lifestyle (dining, entertainment)',
    activeCls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600',
  },
  {
    key: 'saving',
    label: 'Saving',
    desc: 'Future (investments, emergency fund)',
    activeCls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-600',
  },
];

export function AddCategoryDialog({ accessToken, sheetId, onClose, onSuccess }) {
  const [name, setName]     = useState('');
  const [budget, setBudget] = useState('');
  const [type, setType]     = useState('need');
  const [saving, setSaving] = useState(false);
  const [step, setStep]     = useState(-1); // -1 = idle
  const [error, setError]   = useState('');

  const handleSave = async () => {
    const trimmedName = name.trim();
    const budgetNum   = budget ? parseFloat(budget) : 0;

    if (!trimmedName) return setError('Category name is required.');
    if (budget && (isNaN(budgetNum) || budgetNum < 0)) return setError('Enter a valid budget amount.');

    setSaving(true);
    setError('');

    try {
      // Step 0 — add row to Totals
      setStep(0);
      await addCategoryToTotals(sheetId, accessToken, { name: trimmedName, budget: budgetNum });

      // Step 1 — create the detail sheet tab
      setStep(1);
      await createCategoryDetailSheet(sheetId, accessToken, { categoryName: trimmedName });

      // Step 2 — link Totals B column to the new detail sheet
      setStep(2);
      await linkCategoryToDetailSheet(sheetId, accessToken, { categoryName: trimmedName });

      // Step 3 — add to 50/30/20 sheet under the right type column
      setStep(3);
      await addCategoryTo503020(sheetId, accessToken, { categoryName: trimmedName, type });

      // Register in localStorage so SHEET_MAP picks it up this session
      addCustomCategory(trimmedName);

      // Log to history
      const typeLabel = TYPES.find(t => t.key === type)?.label ?? type;
      await appendHistoryEntry(sheetId, accessToken, {
        action:   'Category Added',
        category: trimmedName,
        amount:   budgetNum || null,
        details:  `Type: ${typeLabel}${budgetNum ? ` · Budget: $${budgetNum.toFixed(2)}` : ''}`,
      });

      setStep(4);
      await new Promise(r => setTimeout(r, 800)); // brief "Done!" pause

      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e.message);
      setSaving(false);
      setStep(-1);
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm"
        onClick={saving ? undefined : onClose}
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          {/* Header */}
          <div className="flex items-center justify-between px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
                <FolderPlus className="w-5 h-5 text-slate-600 dark:text-slate-300" />
              </div>
              <div>
                <p className="text-base font-black text-slate-800 dark:text-slate-100">New Category</p>
                <p className="text-xs text-slate-400 mt-0.5">Creates a row + detail sheet</p>
              </div>
            </div>
            {!saving && (
              <button
                onClick={onClose}
                className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-5 overflow-y-auto flex-1">

            {/* Progress — shown while saving */}
            {saving ? (
              <div className="space-y-3">
                {STEPS.map((label, i) => {
                  const done   = i < step;
                  const active = i === step;
                  return (
                    <div key={i} className={`flex items-center gap-3 text-sm font-bold transition-all ${
                      done   ? 'text-emerald-500 dark:text-emerald-400' :
                      active ? 'text-indigo-500 dark:text-indigo-400' :
                               'text-slate-300 dark:text-slate-600'
                    }`}>
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border-2 transition-all ${
                        done   ? 'bg-emerald-500 border-emerald-500' :
                        active ? 'border-indigo-500 animate-pulse' :
                                 'border-slate-200 dark:border-slate-600'
                      }`}>
                        {done && <Check className="w-3 h-3 text-white" />}
                      </div>
                      {label}
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                {/* Category name */}
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">
                    Category name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Pet Care"
                    value={name}
                    onChange={e => { setName(e.target.value); setError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                    autoFocus
                    className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-400/30 focus:border-slate-400 placeholder:text-slate-300 dark:placeholder:text-slate-500"
                  />
                </div>

                {/* Category type */}
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">
                    Category type
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {TYPES.map(({ key, label, activeCls }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setType(key)}
                        className={`py-2.5 rounded-2xl text-xs font-black border-2 transition-all ${
                          type === key
                            ? activeCls
                            : 'bg-slate-50 dark:bg-slate-700/60 text-slate-400 dark:text-slate-500 border-transparent hover:border-slate-200 dark:hover:border-slate-600'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400">
                    {TYPES.find(t => t.key === type)?.desc}
                  </p>
                </div>

                {/* Monthly budget */}
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">
                    Monthly budget <span className="normal-case font-medium text-slate-300">(optional)</span>
                  </label>
                  <input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    value={budget}
                    onChange={e => { setBudget(e.target.value); setError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                    className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-400/30 focus:border-slate-400 placeholder:text-slate-300 dark:placeholder:text-slate-500"
                  />
                </div>

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs font-bold">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />
                    {error}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          {!saving && (
            <div className="px-8 pb-8 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!name.trim()}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-slate-700 dark:bg-slate-600 hover:bg-slate-800 dark:hover:bg-slate-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg"
              >
                Add Category
              </button>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
