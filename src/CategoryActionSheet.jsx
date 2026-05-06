import React from 'react';
import { Smile, Pencil, Trash2 } from 'lucide-react';

export function CategoryActionSheet({ categoryActionFor, setCategoryActionFor, categoryIcons, setIconPickerFor, setRenamingCategory, setDeletingCategory }) {
  if (!categoryActionFor) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={() => setCategoryActionFor(null)} />
      <div className="fixed inset-0 z-50 flex items-end justify-center">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] w-full shadow-2xl border border-slate-100 dark:border-slate-700 overflow-hidden">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-4" />

          <div className="px-6 pb-3 flex items-center gap-3">
            <span className="text-2xl">{categoryIcons[categoryActionFor.name] || '📁'}</span>
            <div>
              <p className="text-base font-black text-slate-800 dark:text-slate-100">{categoryActionFor.name}</p>
              <p className="text-xs text-slate-400">Choose an action</p>
            </div>
          </div>

          <div className="px-4 pb-4 space-y-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            <button
              onClick={() => { setCategoryActionFor(null); setIconPickerFor(categoryActionFor.name); }}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left bg-slate-50 dark:bg-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-[0.98] transition-all"
            >
              <div className="w-9 h-9 bg-amber-50 dark:bg-amber-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
                <Smile className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Change Icon</p>
                <p className="text-xs text-slate-400">Pick a new emoji</p>
              </div>
            </button>

            <button
              onClick={() => { setCategoryActionFor(null); setRenamingCategory(categoryActionFor); }}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left bg-slate-50 dark:bg-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-[0.98] transition-all"
            >
              <div className="w-9 h-9 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
                <Pencil className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Rename Category</p>
                <p className="text-xs text-slate-400">Change the display name</p>
              </div>
            </button>

            <button
              onClick={() => { setCategoryActionFor(null); setDeletingCategory(categoryActionFor); }}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 active:scale-[0.98] transition-all"
            >
              <div className="w-9 h-9 bg-rose-100 dark:bg-rose-900/40 rounded-xl flex items-center justify-center flex-shrink-0">
                <Trash2 className="w-5 h-5 text-rose-500" />
              </div>
              <div>
                <p className="text-sm font-bold text-rose-600 dark:text-rose-400">Delete Category</p>
                <p className="text-xs text-rose-400/70 dark:text-rose-500/60">Permanently remove</p>
              </div>
            </button>

            <button
              onClick={() => setCategoryActionFor(null)}
              className="w-full py-4 rounded-2xl text-sm font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors mt-1"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
