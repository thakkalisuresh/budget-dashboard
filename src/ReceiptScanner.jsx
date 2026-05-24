import React from 'react';
import { Camera, X, Plus, AlertCircle, CheckCircle, ChevronRight, Upload, FileText } from 'lucide-react';
import { CATEGORIES } from './sheetsApi.js';
import { useReceiptScanner } from './useReceiptScanner.js';

const inputCls    = "w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition-all placeholder:text-slate-400";
const inputErrCls = "w-full bg-rose-50 dark:bg-rose-900/20 border border-rose-300 dark:border-rose-700 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-rose-500/40 placeholder:text-rose-300 transition-all";

function Spinner({ className = "w-4 h-4" }) {
  return (
    <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
    </svg>
  );
}

function Checkmark() {
  return <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function CheckboxSquare({ checked, onClick, size = 'md', color = 'indigo' }) {
  const sizeClass = size === 'sm' ? 'w-3.5 h-3.5 rounded border' : 'w-5 h-5 rounded-md border-2';
  const colorClass = color === 'emerald' ? 'bg-emerald-500 border-emerald-500' : 'bg-indigo-600 border-indigo-600';
  return (
    <div
      onClick={onClick}
      className={`${sizeClass} flex items-center justify-center flex-shrink-0 transition-colors cursor-pointer ${
        checked ? colorClass : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'
      }`}
    >
      {checked && (size === 'sm'
        ? <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        : <Checkmark />
      )}
    </div>
  );
}

function EditIcon() {
  return (
    <svg className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
    </svg>
  );
}

function WarningTriangle() {
  return (
    <svg className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function Backdrop({ onClick }) {
  return <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClick} />;
}

function ScanErrorModal({ scanError, onDismiss }) {
  if (!scanError) return null;
  return (
    <>
      <Backdrop onClick={onDismiss} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-sm p-8 border border-rose-100 dark:border-rose-900/40 space-y-5">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 bg-rose-50 dark:bg-rose-900/30 rounded-2xl flex items-center justify-center flex-shrink-0">
              <AlertCircle className="w-5 h-5 text-rose-500" />
            </div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200 leading-relaxed pt-1">{scanError}</p>
          </div>
          <button onClick={onDismiss} className="w-full py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            OK
          </button>
        </div>
      </div>
    </>
  );
}

function ReceiptConfirmModal({ s }) {
  if (s.phase !== 'confirming' && s.phase !== 'saving') return null;
  return (
    <>
      <Backdrop onClick={s.phase === 'saving' ? undefined : s.handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

          <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between flex-shrink-0">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-lg font-black text-slate-800 dark:text-slate-100">Review Receipt</p>
                {s.totalInQueue > 1 && (
                  <span className="text-xs font-bold px-2.5 py-1 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400 rounded-full">
                    {s.currentNum} of {s.totalInQueue}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {s.wasUnreadable ? "Couldn't read clearly — please fill in manually" : 'Verify the details before saving'}
              </p>
            </div>
            <button onClick={s.phase === 'saving' ? undefined : s.handleClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {s.totalInQueue > 1 && (
            <div className="px-8 pt-4 flex-shrink-0">
              <div className="w-full bg-slate-100 dark:bg-slate-700 rounded-full h-1.5">
                <div className="bg-indigo-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${(s.currentNum / s.totalInQueue) * 100}%` }} />
              </div>
            </div>
          )}

          {s.wasUnreadable && (
            <div className="mx-8 mt-5 flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl flex-shrink-0">
              <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">The receipt was unclear. All fields need to be filled in manually.</p>
            </div>
          )}

          <div className="overflow-y-auto flex-1 px-8 py-6 space-y-5">
            {s.showCurrencyPrompt && s.foreignCurrency && (
              <div className="flex items-start gap-3 px-4 py-3 bg-sky-50 dark:bg-sky-900/20 border border-sky-200 dark:border-sky-700/40 rounded-2xl">
                <span className="text-lg flex-shrink-0">💱</span>
                <div>
                  <p className="text-xs font-black text-sky-800 dark:text-sky-300">Foreign currency detected</p>
                  <p className="text-xs text-sky-700 dark:text-sky-400 mt-0.5 leading-relaxed">
                    Receipt shows <span className="font-black">{s.foreignCurrency.currency} {s.foreignCurrency.original.toFixed(2)}</span>.
                    Converted to <span className="font-black">USD {s.foreignCurrency.converted.toFixed(2)}</span> at today's rate
                    (1 USD = {s.foreignCurrency.rate.toFixed(4)} {s.foreignCurrency.currency}).
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Vendor / Name</label>
              <input type="text" value={s.vendor} onChange={e => s.setVendor(e.target.value)} placeholder="e.g. Walmart" autoFocus={s.wasUnreadable} className={!s.vendor.trim() && s.formErr ? inputErrCls : inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Category</label>
              <select value={s.category} onChange={e => s.setCategory(e.target.value)} className={`${!s.category && s.formErr ? inputErrCls : inputCls} cursor-pointer`}>
                <option value="">Select a category…</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Amount</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                <input type="number" step="0.01" min="0.01" placeholder="0.00" value={s.amount} onChange={e => s.setAmount(e.target.value)} className={`${(!s.amount || parseFloat(s.amount) <= 0) && s.formErr ? inputErrCls : inputCls} pl-8`} />
              </div>
            </div>
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative flex-shrink-0 mt-0.5">
                <input type="checkbox" checked={s.isRandom} onChange={e => s.setIsRandom(e.target.checked)} className="sr-only" />
                <CheckboxSquare checked={s.isRandom} onClick={() => s.setIsRandom(!s.isRandom)} />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">One-time / random expense</p>
                <p className="text-xs text-slate-400 mt-0.5">Marks this as a non-monthly expense</p>
              </div>
            </label>
            {s.formErr && <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">{s.formErr}</p>}

            {s.dupWarning && (
              <div className="flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl">
                <WarningTriangle />
                <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                  <span className="font-black">{s.vendor.trim()} ${parseFloat(s.amount).toFixed(2)}</span> is already logged in <span className="font-black">{s.category}</span> this month. Add it again?
                </p>
              </div>
            )}
          </div>

          <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0">
            {s.totalInQueue > 1 && !s.dupWarning ? (
              <button onClick={s.handleSkip} disabled={s.phase === 'saving'} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50">Skip</button>
            ) : (
              <button onClick={s.dupWarning ? () => s.setDupWarning(false) : s.handleClose} disabled={s.phase === 'saving'} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50">
                {s.dupWarning ? 'Go Back' : 'Cancel'}
              </button>
            )}
            <button
              onClick={s.dupWarning ? s.doReceiptSave : s.handleConfirm}
              disabled={s.phase === 'saving'}
              className={`flex-1 py-3 rounded-2xl text-sm font-bold text-white shadow-lg transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                s.dupWarning
                  ? 'bg-amber-500 hover:bg-amber-600 shadow-amber-200 dark:shadow-amber-900/30'
                  : 'bg-indigo-600 hover:bg-indigo-700 shadow-indigo-200 dark:shadow-indigo-900/30'
              }`}
            >
              {s.phase === 'saving' ? (
                <Spinner />
              ) : s.totalInQueue > 1 && s.currentNum < s.totalInQueue && !s.dupWarning ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <Plus className="w-4 h-4" />
              )}
              {s.phase === 'saving' ? 'Saving…' : s.dupWarning ? 'Add Anyway' : s.totalInQueue > 1 && s.currentNum < s.totalInQueue ? 'Save & Next' : 'Add Expense'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function StatementTransactionRow({ t, i, onToggle, onEdit, onToggleNonMonthly, onToggleRecurring }) {
  return (
    <div
      className={`flex flex-col p-3 rounded-2xl border transition-all bg-white dark:bg-slate-700/50 ${
        t.selected
          ? 'border-indigo-400 dark:border-indigo-500 shadow-sm shadow-indigo-100 dark:shadow-none'
          : 'border-slate-200 dark:border-slate-600/40'
      }`}
    >
      <div className="flex items-center gap-3">
        <CheckboxSquare checked={t.selected} onClick={() => onToggle(i)} />
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onEdit(i)}>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{t.vendor || 'Unknown'}</p>
            {t.isDuplicate && (
              <span className="text-[10px] font-black px-2 py-0.5 bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 rounded-full whitespace-nowrap">Already logged</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t.category || 'No category'}</span>
            {t.date && <span className="text-xs text-slate-400">· {t.date}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 cursor-pointer" onClick={() => onEdit(i)}>
          <p className="text-sm font-black text-slate-700 dark:text-slate-200">${t.amount?.toFixed(2)}</p>
          <EditIcon />
        </div>
      </div>
      <div className="flex gap-3 mt-1.5 pl-8">
        <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
          <CheckboxSquare size="sm" checked={t.isNonMonthly} onClick={() => onToggleNonMonthly(i)} />
          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">One-time</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
          <CheckboxSquare size="sm" color="emerald" checked={t.isRecurring} onClick={() => onToggleRecurring(i)} />
          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400">Recurring</span>
        </label>
      </div>
    </div>
  );
}

function StatementReviewModal({ s }) {
  if (s.phase !== 'statement-reviewing' && s.phase !== 'statement-importing') return null;

  const toggleSelection = (i) => s.setStmtTransactions(prev => prev.map((x, j) => j === i ? { ...x, selected: !x.selected } : x));
  const toggleNonMonthly = (i) => s.setStmtTransactions(prev => prev.map((x, j) => j === i ? { ...x, isNonMonthly: !x.isNonMonthly, isRecurring: x.isNonMonthly ? x.isRecurring : false } : x));
  const toggleRecurring = (i) => s.setStmtTransactions(prev => prev.map((x, j) => j === i ? { ...x, isRecurring: !x.isRecurring } : x));

  return (
    <>
      <Backdrop onClick={s.phase === 'statement-importing' ? undefined : s.handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-lg border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

          <div className="px-6 pt-7 pb-5 border-b border-slate-100 dark:border-slate-700 flex items-start justify-between flex-shrink-0">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-5 h-5 text-indigo-500" />
                <p className="text-lg font-black text-slate-800 dark:text-slate-100">
                  {s.stmtTransactions.length} Transaction{s.stmtTransactions.length !== 1 ? 's' : ''} Found
                </p>
              </div>
              <p className="text-xs text-slate-400">
                {s.selectedCount} selected for import
                {s.duplicateCount > 0 && (
                  <span className="ml-2 text-amber-500 font-bold">· {s.duplicateCount} possible duplicate{s.duplicateCount !== 1 ? 's' : ''} unchecked</span>
                )}
              </p>
            </div>
            <button onClick={s.phase === 'statement-importing' ? undefined : s.handleClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {s.duplicateCount > 0 && (
            <div className="mx-6 mt-4 flex items-start gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl flex-shrink-0">
              <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                {s.duplicateCount} transaction{s.duplicateCount !== 1 ? 's' : ''} already appear to be logged this month and have been unchecked. Review before importing.
              </p>
            </div>
          )}

          <div className="px-6 pt-4 pb-2 flex items-center gap-3 flex-shrink-0">
            <button onClick={() => s.setStmtTransactions(prev => prev.map(t => ({ ...t, selected: true })))} className="text-xs font-bold text-indigo-600 dark:text-indigo-400 hover:underline">Select all</button>
            <span className="text-slate-300 dark:text-slate-600">·</span>
            <button onClick={() => s.setStmtTransactions(prev => prev.map(t => ({ ...t, selected: false })))} className="text-xs font-bold text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 hover:underline">Deselect all</button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 pb-4 space-y-2">
            {s.stmtTransactions.map((t, i) => (
              <StatementTransactionRow key={i} t={t} i={i} onToggle={toggleSelection} onEdit={s.openRowEdit} onToggleNonMonthly={toggleNonMonthly} onToggleRecurring={toggleRecurring} />
            ))}
          </div>

          <div className="px-6 pb-7 pt-3 flex gap-3 flex-shrink-0 border-t border-slate-100 dark:border-slate-700">
            <button onClick={s.handleClose} disabled={s.phase === 'statement-importing'} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50">Cancel</button>
            <button
              onClick={s.handleStatementImport}
              disabled={s.phase === 'statement-importing' || s.selectedCount === 0}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {s.phase === 'statement-importing' ? <Spinner /> : <Upload className="w-4 h-4" />}
              {s.phase === 'statement-importing' ? 'Importing…' : `Import ${s.selectedCount} Transaction${s.selectedCount !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function RowEditModal({ s }) {
  if (s.editingIndex === null) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-[60] backdrop-blur-sm" onClick={() => s.setEditingIndex(null)} />
      <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden" />

          <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
            <p className="text-base font-black text-slate-800 dark:text-slate-100">Edit Transaction</p>
            <button onClick={() => s.setEditingIndex(null)} className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 space-y-4">
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Vendor / Name</label>
              <input type="text" value={s.editVendor} onChange={e => s.setEditVendor(e.target.value)} placeholder="e.g. Whole Foods" autoFocus className={inputCls} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Amount</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">$</span>
                <input type="number" step="0.01" min="0.01" placeholder="0.00" value={s.editAmount} onChange={e => s.setEditAmount(e.target.value)} className={`${inputCls} pl-8`} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest text-slate-400">Category</label>
              <select value={s.editCategory} onChange={e => s.setEditCategory(e.target.value)} className={`${inputCls} cursor-pointer`}>
                <option value="">Select a category…</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {s.editErr && <p className="text-xs text-rose-500 font-medium bg-rose-50 dark:bg-rose-900/20 px-4 py-2.5 rounded-xl">{s.editErr}</p>}
          </div>

          <div className="px-6 pb-6 pt-1 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
            <button onClick={() => s.setEditingIndex(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">Cancel</button>
            <button onClick={s.saveRowEdit} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2">
              <CheckCircle className="w-4 h-4" /> Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SummaryModal({ s, monthName }) {
  if (s.phase !== 'summary') return null;
  return (
    <>
      <Backdrop onClick={s.handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-md border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">

          <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center">
                <CheckCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              </div>
              <p className="text-lg font-black text-slate-800 dark:text-slate-100">
                {s.stmtSavedCount > 0
                  ? `${s.stmtSavedCount} Transaction${s.stmtSavedCount !== 1 ? 's' : ''} Imported`
                  : s.savedReceipts.length === 1 ? '1 Receipt Added' : `${s.savedReceipts.length} Receipts Added`}
              </p>
            </div>
            <p className="text-xs text-slate-400 ml-12">All expenses saved to {monthName}</p>
          </div>

          <div className="overflow-y-auto flex-1 px-8 py-6 space-y-3">
            {s.stmtSavedCount > 0
              ? s.stmtTransactions.filter(t => t.selected).map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-3 px-4 bg-slate-50 dark:bg-slate-700/50 rounded-2xl">
                    <div>
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{t.vendor}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{t.category}</p>
                    </div>
                    <p className="text-sm font-black text-slate-700 dark:text-slate-200">${t.amount?.toFixed(2)}</p>
                  </div>
                ))
              : s.savedReceipts.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-3 px-4 bg-slate-50 dark:bg-slate-700/50 rounded-2xl">
                    <div>
                      <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{r.vendor}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{r.category}</p>
                    </div>
                    <p className="text-sm font-black text-slate-700 dark:text-slate-200">${r.amount.toFixed(2)}</p>
                  </div>
                ))
            }

            {s.unmatchedLogged.length > 0 && (
              <div className="pt-2">
                <div className="flex items-center gap-2 mb-3">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                  <p className="text-xs font-black text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                    Not found in statement ({s.unmatchedLogged.length})
                  </p>
                </div>
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl mb-3">
                  <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
                    These expenses are logged this month but didn't appear in the uploaded statement. They may be on a different account.
                  </p>
                </div>
                {s.unmatchedLogged.map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-2.5 px-4 bg-amber-50/60 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-800/30 rounded-2xl mb-2">
                    <div>
                      <p className="text-sm font-bold text-slate-700 dark:text-slate-300">{t.vendor}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{t.category}</p>
                    </div>
                    <p className="text-sm font-black text-amber-600 dark:text-amber-400">${t.amount.toFixed(2)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0">
            <button onClick={s.handleClose} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">Done</button>
            <button
              onClick={() => { s.handleClose(); setTimeout(() => s.fileInputRef.current?.click(), 50); }}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 transition-all active:scale-[0.98] flex items-center justify-center gap-2"
            >
              <Camera className="w-4 h-4" />
              Scan More
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Main export ──────────────────────────────────────────────────────────────

export function ReceiptScanButton(props) {
  const s = useReceiptScanner(props);

  return (
    <>
      <input
        ref={s.fileInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.gif,.webp,.heic,.heif,.pdf,image/*"
        multiple
        className="hidden"
        onChange={s.handleFileChange}
      />

      <button
        onClick={() => s.fileInputRef.current?.click()}
        disabled={s.phase === 'processing'}
        title="Scan receipt or import bank statement"
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-200 border border-slate-200 dark:border-slate-600 rounded-2xl text-sm font-bold hover:bg-slate-50 dark:hover:bg-slate-600 shadow-sm transition-all active:scale-95 disabled:opacity-50"
      >
        {s.phase === 'processing' ? (
          <>
            <Spinner />
            <span className="hidden sm:inline">
              {s.processingProgress
                ? `Reading ${s.processingProgress.current} of ${s.processingProgress.total}…`
                : 'Reading…'}
            </span>
          </>
        ) : (
          <>
            <Camera className="w-4 h-4" />
            <span className="hidden sm:inline">Scan / Import</span>
          </>
        )}
      </button>

      <ScanErrorModal scanError={s.scanError} onDismiss={() => s.setScanError('')} />
      <ReceiptConfirmModal s={s} />
      <StatementReviewModal s={s} />
      <RowEditModal s={s} />
      <SummaryModal s={s} monthName={props.monthName} />
    </>
  );
}
