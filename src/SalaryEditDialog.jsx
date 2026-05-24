import React, { useState } from 'react';
import { Wallet } from 'lucide-react';

export function SalaryEditDialog({ currentSalary, onSave, onClose }) {
  const [draft, setDraft] = useState(currentSalary.toFixed(2));

  const handleSave = () => {
    const newSalary = parseFloat(draft);
    if (isNaN(newSalary) || newSalary < 0) { onClose(); return; }
    onSave(newSalary);
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden" />
          <div className="px-8 pt-6 pb-6 border-b border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center">
                <Wallet className="w-5 h-5 text-blue-500" />
              </div>
              <div>
                <p className="text-base font-black text-slate-800 dark:text-slate-100">Monthly Salary</p>
                <p className="text-xs text-slate-400 mt-0.5">Update your take-home pay for this month</p>
              </div>
            </div>
          </div>
          <div className="px-8 py-6">
            <input
              type="number"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleSave()}
              autoFocus
              placeholder="0.00"
              className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 placeholder:text-slate-300"
            />
          </div>
          <div className="px-8 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">Cancel</button>
            <button onClick={handleSave} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all shadow-lg">Save</button>
          </div>
        </div>
      </div>
    </>
  );
}
