import React, { useState } from 'react';
import { X, RefreshCw, Check } from 'lucide-react';
import { addOrUpdateExpense } from './useExpense.js';

export function BulkRecurringDialog({ recurringExpenses = [], accessToken, sheetId, monthName, onClose, onSuccess }) {
  const [selected, setSelected]   = useState(() => new Set(recurringExpenses.map((_, i) => i)));
  const [importing, setImporting] = useState(false);
  const [progress, setProgress]   = useState({ current: 0, total: 0 });
  const [done, setDone]           = useState(false);
  const [failed, setFailed]       = useState(0);

  const toggle = (i) =>
    setSelected(prev => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; });

  const handleImport = async () => {
    const toImport = recurringExpenses.filter((_, i) => selected.has(i));
    if (toImport.length === 0) return;
    setImporting(true);
    setProgress({ current: 0, total: toImport.length });
    let failCount = 0;
    for (const exp of toImport) {
      try {
        await addOrUpdateExpense(exp.category, exp.vendor, exp.amount, accessToken, sheetId, monthName, 'recurring');
      } catch { failCount++; }
      setProgress(p => ({ ...p, current: p.current + 1 }));
    }
    setFailed(failCount);
    setDone(true);
    setImporting(false);
  };

  if (recurringExpenses.length === 0) return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 p-8 text-center">
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">No recurring expenses saved yet.</p>
          <p className="text-xs text-slate-400 mt-1">Mark expenses as "Repeats monthly" when adding them.</p>
          <button onClick={onClose} className="mt-5 px-6 py-2.5 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700">Close</button>
        </div>
      </div>
    </>
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={!importing ? onClose : undefined} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[85vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          <div className="flex items-center justify-between px-6 pt-6 pb-5 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
            <div>
              <p className="text-base font-black text-slate-800 dark:text-slate-100">Add Recurring Expenses</p>
              <p className="text-xs text-slate-400 mt-0.5">{monthName}</p>
            </div>
            {!importing && (
              <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {done ? (
              <div className="flex flex-col items-center py-8 gap-4">
                <div className="w-14 h-14 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center">
                  <Check className="w-7 h-7 text-emerald-500" />
                </div>
                <div className="text-center">
                  <p className="text-base font-black text-slate-800 dark:text-slate-100">
                    {progress.total - failed} added
                    {failed > 0 && <span className="text-rose-500"> · {failed} failed</span>}
                  </p>
                  <p className="text-xs text-slate-400 mt-1">Recurring expenses added to {monthName}</p>
                </div>
              </div>
            ) : importing ? (
              <div className="flex flex-col items-center py-8 gap-4">
                <RefreshCw className="w-8 h-8 text-indigo-400 animate-spin" />
                <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
                  Adding {progress.current} of {progress.total}…
                </p>
                <div className="w-48 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                    style={{ width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-400 mb-3">Uncheck any you want to skip this month.</p>
                {recurringExpenses.map((exp, i) => {
                  const checked = selected.has(i);
                  return (
                    <label key={i} className="flex items-center gap-3 px-4 py-3 rounded-2xl cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors border border-slate-100 dark:border-slate-700/50">
                      <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-colors ${checked ? 'bg-emerald-500 border-emerald-500' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}
                        onClick={() => toggle(i)}>
                        {checked && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
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
            )}
          </div>

          <div className="px-6 pb-6 pt-4 border-t border-slate-100 dark:border-slate-700 flex-shrink-0"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
            {done ? (
              <button onClick={() => { onSuccess?.(); onClose(); }}
                className="w-full py-3 rounded-2xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 transition-all shadow-lg">
                Done
              </button>
            ) : (
              <button
                onClick={handleImport}
                disabled={importing || selected.size === 0}
                className="w-full py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all shadow-lg disabled:opacity-40 disabled:cursor-not-allowed">
                Add {selected.size} expense{selected.size !== 1 ? 's' : ''} to {monthName}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
