import React from 'react';
import { Camera, X, Plus, AlertCircle, CheckCircle, ChevronRight, Upload, FileText } from 'lucide-react';
import { CATEGORIES } from './sheetsApi.js';
import { useReceiptScanner } from './useReceiptScanner.js';

const inputCls    = "w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all";
const inputErrCls = "w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all";
const inputStyle    = { background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' };
const inputErrStyle = { background: 'oklch(62% 0.22 25 / 10%)', border: '1px solid oklch(62% 0.22 25 / 30%)', color: 'var(--color-text)' };

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
  const checkedBg = color === 'emerald' ? 'var(--color-success)' : 'var(--color-accent)';
  return (
    <div
      onClick={onClick}
      className={`${sizeClass} flex items-center justify-center flex-shrink-0 cursor-pointer`}
      style={checked
        ? { background: checkedBg, borderColor: checkedBg }
        : { background: 'var(--sur-5)', borderColor: 'var(--sur-20)' }
      }
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
    <svg className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
    </svg>
  );
}

function WarningTriangle() {
  return (
    <svg className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'oklch(78% 0.16 75)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
  );
}

// ── Modals ───────────────────────────────────────────────────────────────────

function Backdrop({ onClick }) {
  return <div className="fixed inset-0 z-40 animate-overlay-in" style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }} onClick={onClick} />;
}

function ScanErrorModal({ scanError, onDismiss }) {
  if (!scanError) return null;
  return (
    <>
      <Backdrop onClick={onDismiss} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="glass-heavy animate-dialog-enter rounded-3xl w-full max-w-sm p-8 space-y-5"
          style={{ border: '1px solid oklch(62% 0.22 25 / 20%)' }}>
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'oklch(62% 0.22 25 / 15%)' }}>
              <AlertCircle className="w-5 h-5" style={{ color: 'var(--color-danger)' }} />
            </div>
            <p className="text-sm font-medium leading-relaxed pt-1" style={{ color: 'var(--color-text)' }}>{scanError}</p>
          </div>
          <button onClick={onDismiss} className="w-full py-3 rounded-2xl text-sm font-bold transition-colors hover:bg-[var(--sur-5)]"
            style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>
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
        <div className="glass-heavy animate-dialog-enter rounded-3xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)' }}>

          <div className="px-8 pt-8 pb-6 flex items-start justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>Review Receipt</p>
                {s.totalInQueue > 1 && (
                  <span className="text-xs font-bold px-2.5 py-1 rounded-full"
                    style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                    {s.currentNum} of {s.totalInQueue}
                  </span>
                )}
              </div>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                {s.wasUnreadable ? "Couldn't read clearly — please fill in manually" : 'Verify the details before saving'}
              </p>
            </div>
            <button onClick={s.phase === 'saving' ? undefined : s.handleClose} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>

          {s.totalInQueue > 1 && (
            <div className="px-8 pt-4 flex-shrink-0">
              <div className="w-full rounded-full h-1.5" style={{ background: 'var(--sur-8)' }}>
                <div className="h-1.5 rounded-full transition-all duration-300" style={{ width: `${(s.currentNum / s.totalInQueue) * 100}%`, background: 'var(--color-accent)' }} />
              </div>
            </div>
          )}

          {s.wasUnreadable && (
            <div className="mx-8 mt-5 flex items-start gap-3 px-4 py-3 rounded-2xl flex-shrink-0"
              style={{ background: 'oklch(78% 0.16 75 / 12%)', border: '1px solid oklch(78% 0.16 75 / 25%)' }}>
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'oklch(78% 0.16 75)' }} />
              <p className="text-xs font-medium leading-relaxed" style={{ color: 'oklch(78% 0.16 75)' }}>The receipt was unclear. All fields need to be filled in manually.</p>
            </div>
          )}

          <div className="overflow-y-auto flex-1 px-8 py-6 space-y-5">
            {s.showCurrencyPrompt && s.foreignCurrency && (
              <div className="flex items-start gap-3 px-4 py-3 rounded-2xl"
                style={{ background: 'oklch(70% 0.15 220 / 12%)', border: '1px solid oklch(70% 0.15 220 / 25%)' }}>
                <span className="text-lg flex-shrink-0">💱</span>
                <div>
                  <p className="text-xs font-black" style={{ color: 'oklch(70% 0.15 220)' }}>Foreign currency detected</p>
                  <p className="text-xs mt-0.5 leading-relaxed" style={{ color: 'oklch(70% 0.15 220)' }}>
                    Receipt shows <span className="font-black">{s.foreignCurrency.currency} {s.foreignCurrency.original.toFixed(2)}</span>.
                    Converted to <span className="font-black">USD {s.foreignCurrency.converted.toFixed(2)}</span> at today's rate
                    (1 USD = {s.foreignCurrency.rate.toFixed(4)} {s.foreignCurrency.currency}).
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Vendor / Name</label>
              <input type="text" value={s.vendor} onChange={e => s.setVendor(e.target.value)} placeholder="e.g. Walmart" autoFocus={s.wasUnreadable}
                className={!s.vendor.trim() && s.formErr ? inputErrCls : inputCls}
                style={!s.vendor.trim() && s.formErr ? inputErrStyle : inputStyle} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Category</label>
              <select value={s.category} onChange={e => { s.setCategory(e.target.value); if (!['Eating Out','Thakkali'].includes(e.target.value)) s.setTip(''); }}
                className={`${!s.category && s.formErr ? inputErrCls : inputCls} cursor-pointer`}
                style={!s.category && s.formErr ? inputErrStyle : inputStyle}>
                <option value="">Select a category…</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {s.cards?.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Payment Method</label>
                <select value={s.paymentMethod} onChange={e => { s.setPaymentMethod(e.target.value); s.setBookingMethod(''); }}
                  className={`${inputCls} cursor-pointer`} style={inputStyle}>
                  <option value="">— Select card (optional) —</option>
                  {s.cards.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {s.paymentMethod === 'Chase Sapphire Reserve' && ['Travel', 'Holiday'].includes(s.category) && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold" style={{ color: 'var(--color-accent-text)' }}>
                  📊 {s.bookingMethod === 'direct' ? '4x UR — Booked direct' : '8x UR — Chase Travel portal'}
                </span>
                <button type="button" onClick={() => s.setBookingMethod(bm => bm === 'direct' ? '' : 'direct')}
                  className="text-xs underline transition-colors" style={{ color: 'var(--color-text-muted)' }}>
                  {s.bookingMethod === 'direct' ? '← Switch to portal (8x)' : 'Booked direct instead? → 4x'}
                </button>
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                Amount{['Eating Out', 'Thakkali'].includes(s.category) && parseFloat(s.tip) > 0 ? ' (before tip)' : ''}
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
                <input type="number" step="0.01" min="0.01" placeholder="0.00" value={s.amount} onChange={e => s.setAmount(e.target.value)}
                  className={`${(!s.amount || parseFloat(s.amount) <= 0) && s.formErr ? inputErrCls : inputCls} pl-8`}
                  style={(!s.amount || parseFloat(s.amount) <= 0) && s.formErr ? inputErrStyle : inputStyle} />
              </div>
            </div>
            {['Eating Out', 'Thakkali'].includes(s.category) && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                  Tip <span className="font-medium" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>(optional)</span>
                </label>
                <div className="relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
                  <input type="number" step="0.01" min="0" placeholder="0.00" value={s.tip} onChange={e => s.setTip(e.target.value)}
                    className={`${inputCls} pl-8`} style={inputStyle} />
                </div>
                {parseFloat(s.tip) > 0 && (
                  <p className="text-xs px-1" style={{ color: 'var(--color-text-muted)' }}>
                    Total: <span className="font-black" style={{ color: 'var(--color-text)' }}>${(parseFloat(s.amount || 0) + parseFloat(s.tip)).toFixed(2)}</span>
                  </p>
                )}
              </div>
            )}
            <label className="flex items-start gap-3 cursor-pointer group">
              <div className="relative flex-shrink-0 mt-0.5">
                <input type="checkbox" checked={s.isRandom} onChange={e => s.setIsRandom(e.target.checked)} className="sr-only" />
                <CheckboxSquare checked={s.isRandom} onClick={() => s.setIsRandom(!s.isRandom)} />
              </div>
              <div>
                <p className="text-sm font-bold transition-colors" style={{ color: 'var(--color-text)' }}>One-time / random expense</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Marks this as a non-monthly expense</p>
              </div>
            </label>
            {s.formErr && (
              <p className="text-xs font-medium px-4 py-2.5 rounded-xl"
                style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>{s.formErr}</p>
            )}

            {s.dupWarning && (
              <div className="flex items-start gap-3 px-4 py-3 rounded-2xl"
                style={{ background: 'oklch(78% 0.16 75 / 12%)', border: '1px solid oklch(78% 0.16 75 / 25%)' }}>
                <WarningTriangle />
                <p className="text-xs font-medium leading-relaxed" style={{ color: 'oklch(78% 0.16 75)' }}>
                  <span className="font-black">{s.vendor.trim()} ${parseFloat(s.amount).toFixed(2)}</span> is already logged in <span className="font-black">{s.category}</span> this month. Add it again?
                </p>
              </div>
            )}
          </div>

          <div className="px-8 pb-8 pt-4 flex gap-3 flex-shrink-0" style={{ borderTop: '1px solid var(--sur-8)' }}>
            {s.totalInQueue > 1 && !s.dupWarning ? (
              <button onClick={s.handleSkip} disabled={s.phase === 'saving'}
                className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>Skip</button>
            ) : (
              <button onClick={s.dupWarning ? () => s.setDupWarning(false) : s.handleClose} disabled={s.phase === 'saving'}
                className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50"
                style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>
                {s.dupWarning ? 'Go Back' : 'Cancel'}
              </button>
            )}
            <button
              onClick={s.dupWarning ? s.doReceiptSave : s.handleConfirm}
              disabled={s.phase === 'saving'}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: s.dupWarning ? 'oklch(78% 0.16 75)' : 'var(--color-accent)' }}
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
      className="flex flex-col p-3 rounded-2xl transition-colors"
      style={{
        background: 'var(--sur-4)',
        border: t.selected
          ? '1px solid var(--color-accent)'
          : '1px solid var(--sur-10)',
      }}
    >
      <div className="flex items-center gap-3">
        <CheckboxSquare checked={t.selected} onClick={() => onToggle(i)} />
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => onEdit(i)}>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{t.vendor || 'Unknown'}</p>
            {t.isDuplicate && (
              <span className="text-[10px] font-black px-2 py-0.5 rounded-full whitespace-nowrap"
                style={{ background: 'oklch(78% 0.16 75 / 15%)', color: 'oklch(78% 0.16 75)' }}>Already logged</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
            <span className="text-xs font-medium" style={{ color: 'var(--color-text-muted)' }}>{t.category || 'No category'}</span>
            {t.date && <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>· {t.date}</span>}
            {t.card && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap"
                style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>💳 {t.card}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 cursor-pointer" onClick={() => onEdit(i)}>
          <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>${t.amount?.toFixed(2)}</p>
          <EditIcon />
        </div>
      </div>
      <div className="flex gap-3 mt-1.5 pl-8">
        <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
          <CheckboxSquare size="sm" checked={t.isNonMonthly} onClick={() => onToggleNonMonthly(i)} />
          <span className="text-[10px] font-bold" style={{ color: 'var(--color-text-muted)' }}>One-time</span>
        </label>
        <label className="flex items-center gap-1.5 cursor-pointer" onClick={e => e.stopPropagation()}>
          <CheckboxSquare size="sm" color="emerald" checked={t.isRecurring} onClick={() => onToggleRecurring(i)} />
          <span className="text-[10px] font-bold" style={{ color: 'var(--color-text-muted)' }}>Recurring</span>
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
        <div className="glass-heavy animate-dialog-enter rounded-3xl w-full max-w-lg overflow-hidden max-h-[75vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)' }}>

          <div className="px-6 pt-7 pb-5 flex items-start justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-5 h-5" style={{ color: 'var(--color-accent-text)' }} />
                <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>
                  {s.stmtTransactions.length} Transaction{s.stmtTransactions.length !== 1 ? 's' : ''} Found
                </p>
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {s.selectedCount} selected for import
                {s.duplicateCount > 0 && (
                  <span className="ml-2 font-bold" style={{ color: 'oklch(78% 0.16 75)' }}>· {s.duplicateCount} possible duplicate{s.duplicateCount !== 1 ? 's' : ''} unchecked</span>
                )}
              </p>
            </div>
            <button onClick={s.phase === 'statement-importing' ? undefined : s.handleClose} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>

          {s.duplicateCount > 0 && (
            <div className="mx-6 mt-4 flex items-start gap-3 px-4 py-3 rounded-2xl flex-shrink-0"
              style={{ background: 'oklch(78% 0.16 75 / 12%)', border: '1px solid oklch(78% 0.16 75 / 25%)' }}>
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: 'oklch(78% 0.16 75)' }} />
              <p className="text-xs font-medium leading-relaxed" style={{ color: 'oklch(78% 0.16 75)' }}>
                {s.duplicateCount} transaction{s.duplicateCount !== 1 ? 's' : ''} already appear to be logged this month and have been unchecked. Review before importing.
              </p>
            </div>
          )}

          <div className="px-6 pt-4 pb-2 flex items-center gap-3 flex-shrink-0">
            <button onClick={() => s.setStmtTransactions(prev => prev.map(t => ({ ...t, selected: true })))}
              className="text-xs font-bold hover:underline" style={{ color: 'var(--color-accent-text)' }}>Select all</button>
            <span style={{ color: 'var(--color-text-muted)' }}>·</span>
            <button onClick={() => s.setStmtTransactions(prev => prev.map(t => ({ ...t, selected: false })))}
              className="text-xs font-bold hover:underline transition-colors" style={{ color: 'var(--color-text-muted)' }}>Deselect all</button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 pb-4 space-y-2">
            {s.stmtTransactions.map((t, i) => (
              <StatementTransactionRow key={i} t={t} i={i} onToggle={toggleSelection} onEdit={s.openRowEdit} onToggleNonMonthly={toggleNonMonthly} onToggleRecurring={toggleRecurring} />
            ))}
          </div>

          <div className="px-6 pb-7 pt-4 flex gap-3 flex-shrink-0" style={{ borderTop: '1px solid var(--sur-8)' }}>
            <button onClick={s.handleClose} disabled={s.phase === 'statement-importing'}
              className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>Cancel</button>
            <button
              onClick={s.handleStatementImport}
              disabled={s.phase === 'statement-importing' || s.selectedCount === 0}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: 'var(--color-accent)' }}
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
      <div className="fixed inset-0 z-[60] animate-overlay-in" style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }} onClick={() => s.setEditingIndex(null)} />
      <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
        <div className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden flex flex-col"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none', maxHeight: 'calc(92vh - env(safe-area-inset-bottom))' }}>
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'var(--sur-20)' }} />

          <div className="px-6 pt-5 pb-4 flex items-center justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>Edit Transaction</p>
            <button onClick={() => s.setEditingIndex(null)} className="p-1.5 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 space-y-4 overflow-y-auto flex-1">
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Vendor / Name</label>
              <input type="text" value={s.editVendor} onChange={e => s.setEditVendor(e.target.value)} placeholder="e.g. Whole Foods" autoFocus className={inputCls} style={inputStyle} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Amount</label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
                <input type="number" step="0.01" min="0.01" placeholder="0.00" value={s.editAmount} onChange={e => s.setEditAmount(e.target.value)} className={`${inputCls} pl-8`} style={inputStyle} />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Category</label>
              <select value={s.editCategory} onChange={e => s.setEditCategory(e.target.value)} className={`${inputCls} cursor-pointer`} style={inputStyle}>
                <option value="">Select a category…</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {s.cards?.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Payment Method</label>
                <select value={s.editCard} onChange={e => s.setEditCard(e.target.value)} className={`${inputCls} cursor-pointer`} style={inputStyle}>
                  <option value="">— Select card (optional) —</option>
                  {s.cards.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {s.editErr && (
              <p className="text-xs font-medium px-4 py-2.5 rounded-xl"
                style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>{s.editErr}</p>
            )}
          </div>

          <div className="px-6 pt-1 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
            <button onClick={() => s.setEditingIndex(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>Cancel</button>
            <button onClick={s.saveRowEdit} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              style={{ background: 'var(--color-accent)' }}>
              <CheckCircle className="w-4 h-4" /> Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function SplitReceiptModal({ s }) {
  if (s.phase !== 'split-reviewing' && s.phase !== 'split-saving') return null;
  const saving = s.phase === 'split-saving';

  // Live per-category preview = auto groups + chosen item categories.
  const preview = { ...s.splitGroups };
  for (const it of s.splitItems) {
    if (it.category) preview[it.category] = Math.round(((preview[it.category] || 0) + it.amount) * 100) / 100;
  }
  const assignedSum = Math.round(Object.values(preview).reduce((a, b) => a + b, 0) * 100) / 100;
  const remainder = Math.round((s.splitTotal - assignedSum) * 100) / 100;

  return (
    <>
      <Backdrop onClick={saving ? undefined : s.handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="glass-heavy animate-dialog-enter rounded-3xl w-full max-w-lg overflow-hidden max-h-[80vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)' }}>

          <div className="px-6 pt-7 pb-5 flex items-start justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <FileText className="w-5 h-5" style={{ color: 'var(--color-accent-text)' }} />
                <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>Split {s.splitVendor}</p>
              </div>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                ${Number(s.splitTotal).toFixed(2)} total · pick a category for each item below
              </p>
            </div>
            <button onClick={saving ? undefined : s.handleClose} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1 px-6 py-4 space-y-4">
            {Object.keys(s.splitGroups).length > 0 && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-muted)' }}>Auto-sorted</p>
                <div className="space-y-1.5">
                  {Object.entries(s.splitGroups).map(([cat, amt]) => (
                    <div key={cat} className="flex items-center justify-between px-4 py-2.5 rounded-xl" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-10)' }}>
                      <span className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>{cat}</span>
                      <span className="text-sm font-mono" style={{ color: 'var(--color-text-secondary)' }}>${Number(amt).toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {s.splitItems.length > 0 && (
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-muted)' }}>Pick a category</p>
                <div className="space-y-2">
                  {s.splitItems.map((it, i) => (
                    <div key={i} className="flex items-center gap-3 px-4 py-2.5 rounded-xl" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-10)' }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{it.name}</p>
                        <p className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>${Number(it.amount).toFixed(2)}</p>
                      </div>
                      <select
                        value={it.category || ''}
                        disabled={saving}
                        onChange={e => s.setSplitItemCategory(i, e.target.value)}
                        className="rounded-xl px-3 py-2 text-sm outline-none flex-shrink-0"
                        style={inputStyle}
                      >
                        <option value="">Choose…</option>
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between px-4 py-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span>Assigned: ${assignedSum.toFixed(2)} of ${Number(s.splitTotal).toFixed(2)}</span>
              {Math.abs(remainder) >= 0.01 && (
                <span>tax/fees ${remainder.toFixed(2)} → largest category</span>
              )}
            </div>
          </div>

          <div className="px-6 pb-7 pt-4 flex gap-3 flex-shrink-0" style={{ borderTop: '1px solid var(--sur-8)' }}>
            <button onClick={s.handleClose} disabled={saving}
              className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-50"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>Cancel</button>
            <button
              onClick={s.handleSplitSave}
              disabled={saving || !s.splitReady}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{ background: 'var(--color-accent)' }}
            >
              {saving ? <Spinner /> : <CheckCircle className="w-4 h-4" />}
              {saving ? 'Logging…' : `Log Split (${Object.keys(preview).length})`}
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
        <div className="glass-heavy animate-dialog-enter rounded-3xl w-full max-w-md overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)' }}>

          <div className="px-8 pt-8 pb-6 flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div className="flex items-center gap-3 mb-1">
              <div className="w-9 h-9 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(70% 0.15 145 / 15%)' }}>
                <CheckCircle className="w-5 h-5" style={{ color: 'var(--color-success)' }} />
              </div>
              <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>
                {s.stmtSavedCount > 0
                  ? `${s.stmtSavedCount} Transaction${s.stmtSavedCount !== 1 ? 's' : ''} Imported`
                  : s.savedReceipts.length === 1 ? '1 Receipt Added' : `${s.savedReceipts.length} Receipts Added`}
              </p>
            </div>
            <p className="text-xs ml-12" style={{ color: 'var(--color-text-muted)' }}>All expenses saved to {monthName}</p>
          </div>

          <div className="overflow-y-auto flex-1 px-8 py-6 space-y-3">
            {s.stmtSavedCount > 0
              ? s.stmtTransactions.filter(t => t.selected).map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-3 px-4 rounded-2xl"
                    style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-8)' }}>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>{t.vendor}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{t.category}</p>
                    </div>
                    <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>${t.amount?.toFixed(2)}</p>
                  </div>
                ))
              : s.savedReceipts.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-3 px-4 rounded-2xl"
                    style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-8)' }}>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>{r.vendor}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{r.category}</p>
                    </div>
                    <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>${r.amount.toFixed(2)}</p>
                  </div>
                ))
            }

            {s.unmatchedLogged.length > 0 && (
              <div className="pt-2">
                <div className="flex items-center gap-2 mb-3">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'oklch(78% 0.16 75)' }} />
                  <p className="text-xs font-black uppercase tracking-wide" style={{ color: 'oklch(78% 0.16 75)' }}>
                    Not found in statement ({s.unmatchedLogged.length})
                  </p>
                </div>
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-2xl mb-3"
                  style={{ background: 'oklch(78% 0.16 75 / 10%)', border: '1px solid oklch(78% 0.16 75 / 20%)' }}>
                  <p className="text-xs leading-relaxed" style={{ color: 'oklch(78% 0.16 75)' }}>
                    These expenses are logged this month but didn't appear in the uploaded statement. They may be on a different account.
                  </p>
                </div>
                {s.unmatchedLogged.map((t, i) => (
                  <div key={i} className="flex items-center justify-between py-2.5 px-4 rounded-2xl mb-2"
                    style={{ background: 'oklch(78% 0.16 75 / 8%)', border: '1px solid oklch(78% 0.16 75 / 15%)' }}>
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>{t.vendor}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{t.category}</p>
                    </div>
                    <p className="text-sm font-black" style={{ color: 'oklch(78% 0.16 75)' }}>${t.amount.toFixed(2)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="px-8 pb-8 pt-4 flex gap-3 flex-shrink-0" style={{ borderTop: '1px solid var(--sur-8)' }}>
            <button onClick={s.handleClose} className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}>Done</button>
            <button
              onClick={() => { s.warmup(); s.handleClose(); setTimeout(() => s.fileInputRef.current?.click(), 50); }}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] flex items-center justify-center gap-2"
              style={{ background: 'var(--color-accent)' }}
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
        onClick={() => { s.warmup(); s.fileInputRef.current?.click(); }}
        onPointerEnter={s.warmup}
        onFocus={s.warmup}
        disabled={s.phase === 'processing'}
        title="Scan receipt or import bank statement"
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 rounded-2xl text-sm font-bold transition-all active:scale-95 disabled:opacity-50"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--sur-10)',
          color: 'var(--color-text)',
        }}
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
      <SplitReceiptModal s={s} />
      <RowEditModal s={s} />
      <SummaryModal s={s} monthName={props.monthName} />
    </>
  );
}
