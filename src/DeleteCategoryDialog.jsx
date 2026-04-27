import React, { useState } from 'react';
import { X, Trash2, AlertTriangle, AlertCircle } from 'lucide-react';
import { deleteCategory } from './sheetsApi.js';
import { BUILT_IN_SHEET_MAP } from './fetchDetail.js';

export function DeleteCategoryDialog({ accessToken, sheetId, category, onClose, onSuccess }) {
  const [step, setStep]         = useState(1); // 1 → 2 → 3
  const [nameInput, setNameInput] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting]   = useState(false);
  const [error, setError]         = useState('');

  const isCustom   = !BUILT_IN_SHEET_MAP[category.name];
  const hasSpending = category.actual > 0;
  const nameMatches = nameInput.trim().toLowerCase() === category.name.toLowerCase();

  const handleDelete = async () => {
    setDeleting(true);
    setError('');
    try {
      await deleteCategory(sheetId, accessToken, { categoryName: category.name });
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e.message);
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={deleting ? undefined : onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-rose-100 dark:border-rose-900/40 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          {/* Header */}
          <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700">
            <div className="w-12 h-12 bg-rose-50 dark:bg-rose-900/30 rounded-2xl flex items-center justify-center mb-4">
              <Trash2 className="w-6 h-6 text-rose-500" />
            </div>
            <p className="text-lg font-black text-slate-800 dark:text-slate-100">
              Delete "{category.name}"?
            </p>
            <p className="text-xs text-slate-400 mt-1">
              Step {step} of 3 — {step === 1 ? 'Review warning' : step === 2 ? 'Confirm name' : 'Final confirmation'}
            </p>
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-4 overflow-y-auto flex-1">

            {/* ── Step 1: Warnings ── */}
            {step === 1 && (
              <div className="space-y-3">
                <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40 rounded-2xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-500 flex-shrink-0" />
                    <p className="text-sm font-black text-rose-700 dark:text-rose-300">This cannot be undone</p>
                  </div>
                  <ul className="text-xs text-rose-600/80 dark:text-rose-400/80 space-y-1 ml-6 list-disc">
                    <li>The category row will be removed from your Totals sheet</li>
                    {isCustom
                      ? <li>The entire detail sheet and all its expense entries will be permanently deleted</li>
                      : <li>All expense entries in this category's sheet will be cleared</li>
                    }
                    <li>This will not affect your other categories</li>
                  </ul>
                </div>

                {hasSpending && (
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl px-4 py-3 flex items-center gap-3">
                    <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <p className="text-xs font-bold text-amber-700 dark:text-amber-300">
                      This category has <span className="font-black">${category.actual.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> in expenses this month.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Step 2: Type name ── */}
            {step === 2 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Type <span className="font-black text-rose-500">{category.name}</span> to continue:
                </p>
                <input
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  placeholder={category.name}
                  autoFocus
                  className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-rose-500/30 focus:border-rose-400 placeholder:text-slate-300"
                />
              </div>
            )}

            {/* ── Step 3: Final checkbox ── */}
            {step === 3 && (
              <div className="space-y-4">
                <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800/40 rounded-2xl px-4 py-3">
                  <p className="text-xs font-bold text-rose-600 dark:text-rose-400">
                    You are about to permanently delete <span className="font-black">{category.name}</span> and all its data.
                  </p>
                </div>
                <label className="flex items-start gap-3 cursor-pointer">
                  <div className="relative flex-shrink-0 mt-0.5">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={e => setConfirmed(e.target.checked)}
                      className="sr-only"
                    />
                    <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-colors ${confirmed ? 'bg-rose-500 border-rose-500' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}>
                      {confirmed && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                    I understand this will <span className="font-black text-rose-500">permanently delete</span> all expense data and cannot be undone.
                  </p>
                </label>

                {error && (
                  <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs font-bold">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-8 pb-8 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button
              onClick={onClose}
              disabled={deleting}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>

            {step < 3 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={step === 2 && !nameMatches}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-rose-500 hover:bg-rose-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={handleDelete}
                disabled={!confirmed || deleting}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-rose-600 hover:bg-rose-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : `Delete ${category.name}`}
              </button>
            )}
          </div>

        </div>
      </div>
    </>
  );
}
