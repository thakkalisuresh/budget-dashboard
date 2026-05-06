import React from 'react';
import { Trash2 } from 'lucide-react';

export function DeleteMonthDialog({ deleteConfirm, setDeleteConfirm, deleteInput, setDeleteInput, months, setSelectedSheetId, deleteMonth }) {
  if (!deleteConfirm) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-rose-100 dark:border-rose-900/40 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />
          <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
            <div className="w-12 h-12 bg-rose-50 dark:bg-rose-900/30 rounded-2xl flex items-center justify-center mb-4">
              <Trash2 className="w-6 h-6 text-rose-500" />
            </div>
            <p className="text-lg font-black text-slate-800 dark:text-slate-100">Remove Month</p>
            <p className="text-xs text-slate-400 mt-1">
              This removes it from the list. The Google Sheet will <span className="font-bold text-slate-600 dark:text-slate-300">not</span> be deleted.
            </p>
          </div>
          <div className="px-8 py-6 space-y-4 overflow-y-auto flex-1">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Type <span className="font-black text-rose-500">{deleteConfirm.name}</span> to confirm:
            </p>
            <input
              type="text"
              value={deleteInput}
              onChange={e => setDeleteInput(e.target.value)}
              placeholder={deleteConfirm.name}
              className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-rose-500/40 focus:border-rose-400 placeholder:text-slate-300"
              autoFocus
            />
          </div>
          <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button
              onClick={() => setDeleteConfirm(null)}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={deleteInput !== deleteConfirm.name}
              onClick={async () => {
                const fallback = months.find(m => m.sheetId !== deleteConfirm.sheetId);
                setSelectedSheetId(fallback.sheetId);
                await deleteMonth(deleteConfirm.name);
                setDeleteConfirm(null);
                setDeleteInput('');
              }}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-rose-500 hover:bg-rose-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
