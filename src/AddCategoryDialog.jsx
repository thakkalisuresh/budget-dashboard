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

const TEMPLATE_ID = import.meta.env.VITE_TEMPLATE_SHEET_ID;

const TYPES = [
  { key: 'need',   label: 'Need',   desc: 'Essentials (rent, groceries, bills)',  activeCls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600' },
  { key: 'want',   label: 'Want',   desc: 'Lifestyle (dining, entertainment)',     activeCls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600' },
  { key: 'saving', label: 'Saving', desc: 'Future (investments, emergency fund)', activeCls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-600' },
];

function monthToDate(name) {
  try { return new Date(`${name} 1`); } catch { return new Date(0); }
}

async function applyToSheet(targetSheetId, accessToken, { name, budget, type }) {
  await addCategoryToTotals(targetSheetId, accessToken, { name, budget });
  await createCategoryDetailSheet(targetSheetId, accessToken, { categoryName: name });
  await linkCategoryToDetailSheet(targetSheetId, accessToken, { categoryName: name });
  await addCategoryTo503020(targetSheetId, accessToken, { categoryName: name, type });
}

// step: 'form' | 'question' | 'saving'
export function AddCategoryDialog({ accessToken, sheetId, onClose, onSuccess, onAddCustomCategory, months = [], currentMonthName = '' }) {
  const [step, setStep]       = useState('form');
  const [name, setName]       = useState('');
  const [budget, setBudget]   = useState('');
  const [type, setType]       = useState('need');
  const [scope, setScope]     = useState('this'); // 'this' | 'future'
  const [error, setError]     = useState('');
  const [progressItems, setProgressItems] = useState([]);
  const [progressIdx, setProgressIdx]     = useState(-1);

  const futureMonths = months.filter(m => monthToDate(m.name) > monthToDate(currentMonthName));

  const validate = () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('Category name is required.'); return false; }
    const budgetNum = budget ? parseFloat(budget) : 0;
    if (budget && (isNaN(budgetNum) || budgetNum < 0)) { setError('Enter a valid budget amount.'); return false; }
    return true;
  };

  const handleNext = () => {
    if (!validate()) return;
    // If future scope and existing future months — ask about them
    if (scope === 'future' && futureMonths.length > 0) {
      setStep('question');
    } else {
      runSave(scope === 'future' ? false : null); // no existing future months to include
    }
  };

  const runSave = async (includeExisting) => {
    const trimmedName = name.trim();
    const budgetNum   = budget ? parseFloat(budget) : 0;

    const targets = [{ id: sheetId, label: `${currentMonthName || 'Current month'}` }];
    if (scope === 'future') {
      if (includeExisting) futureMonths.forEach(m => targets.push({ id: m.sheetId, label: m.name }));
      targets.push({ id: TEMPLATE_ID, label: 'Template (new months going forward)' });
    }

    const steps = [...targets.map(t => `Adding to ${t.label}…`), 'Done!'];
    setProgressItems(steps);
    setProgressIdx(0);
    setStep('saving');

    try {
      for (let i = 0; i < targets.length; i++) {
        setProgressIdx(i);
        await applyToSheet(targets[i].id, accessToken, { name: trimmedName, budget: budgetNum, type });
      }
      addCustomCategory(trimmedName);
      onAddCustomCategory?.(trimmedName);
      const typeLabel = TYPES.find(t => t.key === type)?.label ?? type;
      await appendHistoryEntry(sheetId, accessToken, {
        action: 'Category Added', category: trimmedName, amount: budgetNum || null,
        details: `Type: ${typeLabel}${budgetNum ? ` · Budget: $${budgetNum.toFixed(2)}` : ''}${scope === 'future' ? ' · Future months' : ''}`,
      });
      setProgressIdx(steps.length - 1);
      await new Promise(r => setTimeout(r, 800));
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e.message);
      setStep('form');
      setProgressItems([]);
      setProgressIdx(-1);
    }
  };

  const isSaving = step === 'saving';

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={isSaving ? undefined : onClose} />
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
                <p className="text-xs text-slate-400 mt-0.5">
                  {step === 'question' ? 'Apply to existing months?' : 'Creates a row + detail sheet'}
                </p>
              </div>
            </div>
            {!isSaving && <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"><X className="w-5 h-5" /></button>}
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-5 overflow-y-auto flex-1">

            {/* ── Saving progress ── */}
            {step === 'saving' && (
              <div className="space-y-3">
                {progressItems.map((label, i) => {
                  const done = i < progressIdx, active = i === progressIdx;
                  return (
                    <div key={i} className={`flex items-center gap-3 text-sm font-bold transition-all ${done ? 'text-emerald-500 dark:text-emerald-400' : active ? 'text-indigo-500 dark:text-indigo-400' : 'text-slate-300 dark:text-slate-600'}`}>
                      <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border-2 ${done ? 'bg-emerald-500 border-emerald-500' : active ? 'border-indigo-500 animate-pulse' : 'border-slate-200 dark:border-slate-600'}`}>
                        {done && <Check className="w-3 h-3 text-white" />}
                      </div>
                      {label}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── Existing months question ── */}
            {step === 'question' && (
              <div className="space-y-4">
                <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                  These months already exist after <span className="font-black">{currentMonthName}</span>:
                </p>
                <div className="px-4 py-3 bg-slate-50 dark:bg-slate-700/50 rounded-2xl">
                  {futureMonths.map(m => <p key={m.sheetId} className="text-sm font-bold text-slate-700 dark:text-slate-200">· {m.name}</p>)}
                </div>
                <p className="text-xs text-slate-400">Should the new category be added to these months too?</p>
                <div className="space-y-2">
                  <button onClick={() => runSave(true)}
                    className="w-full py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all">
                    Yes — add to all of these
                  </button>
                  <button onClick={() => runSave(false)}
                    className="w-full py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                    No — only new months going forward
                  </button>
                </div>
                <button onClick={() => setStep('form')} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">← Back</button>
              </div>
            )}

            {/* ── Form ── */}
            {step === 'form' && (
              <>
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">Category name</label>
                  <input type="text" placeholder="e.g. Pet Care" value={name}
                    onChange={e => { setName(e.target.value); setError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleNext()}
                    autoFocus
                    className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-400/30 placeholder:text-slate-300 dark:placeholder:text-slate-500" />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">Category type</label>
                  <div className="grid grid-cols-3 gap-2">
                    {TYPES.map(({ key, label, activeCls }) => (
                      <button key={key} type="button" onClick={() => setType(key)}
                        className={`py-2.5 rounded-2xl text-xs font-black border-2 transition-all ${type === key ? activeCls : 'bg-slate-50 dark:bg-slate-700/60 text-slate-400 border-transparent hover:border-slate-200 dark:hover:border-slate-600'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400">{TYPES.find(t => t.key === type)?.desc}</p>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">Monthly budget <span className="normal-case font-medium text-slate-300">(optional)</span></label>
                  <input type="number" placeholder="0.00" min="0" step="0.01" value={budget}
                    onChange={e => { setBudget(e.target.value); setError(''); }}
                    className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-400/30 placeholder:text-slate-300 dark:placeholder:text-slate-500" />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest text-slate-400">Apply to</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'this',   label: 'This month only' },
                      { key: 'future', label: 'All future months' },
                    ].map(({ key, label }) => (
                      <button key={key} type="button" onClick={() => setScope(key)}
                        className={`py-2.5 rounded-2xl text-xs font-black border-2 transition-all ${
                          scope === key
                            ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border-indigo-300 dark:border-indigo-600'
                            : 'bg-slate-50 dark:bg-slate-700/60 text-slate-400 border-transparent hover:border-slate-200 dark:hover:border-slate-600'
                        }`}>
                        {label}
                      </button>
                    ))}
                  </div>
                  {scope === 'future' && (
                    <p className="text-[10px] text-slate-400">Budget copied from the amount you set above. Updates the template for all new months.</p>
                  )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs font-bold">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          {step === 'form' && (
            <div className="px-8 pb-8 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
              <button onClick={onClose} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">Cancel</button>
              <button onClick={handleNext} disabled={!name.trim()}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-slate-700 dark:bg-slate-600 hover:bg-slate-800 dark:hover:bg-slate-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
                {scope === 'future' && futureMonths.length > 0 ? 'Next →' : 'Add Category'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
