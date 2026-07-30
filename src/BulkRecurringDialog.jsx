import React, { useState } from 'react';
import { X, RefreshCw, Check } from 'lucide-react';
import { addOrUpdateExpense } from './useExpense.js';
import { resolveImportDate } from './recurringExpenses.js';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function BulkRecurringDialog({ recurringExpenses = [], accessToken, sheetId, monthName, onClose, onSuccess }) {
  const [selected, setSelected]   = useState(() => new Set(recurringExpenses.map((_, i) => i)));
  const [importing, setImporting] = useState(false);
  const [progress, setProgress]   = useState({ current: 0, total: 0 });
  const [done, setDone]           = useState(false);
  const [failed, setFailed]       = useState(0);
  // index → edited amount string. Absent means "use the template's amount".
  const [amounts, setAmounts]     = useState({});

  const toggle = (i) =>
    setSelected(prev => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; });

  const handleImport = async () => {
    const toImport = recurringExpenses
      .map((exp, i) => ({ exp, i }))
      .filter(({ i }) => selected.has(i));
    if (toImport.length === 0) return;
    setImporting(true);
    setProgress({ current: 0, total: toImport.length });

    // monthName is "Aug 2026"; match it against full month names for the date.
    const [mLabel, yLabel] = String(monthName || '').trim().split(/\s+/);
    const monthIndex = MONTHS.findIndex(m => m.toLowerCase().startsWith((mLabel || '').toLowerCase().slice(0, 3)));
    const year = Number(yLabel) || new Date().getFullYear();

    let failCount = 0;
    for (const { exp, i } of toImport) {
      const edited = parseFloat(amounts[i]);
      const amount = Number.isFinite(edited) && edited > 0 ? edited : exp.amount;
      try {
        await addOrUpdateExpense(
          exp.category, exp.vendor, amount, accessToken, sheetId, monthName, 'recurring',
          monthIndex >= 0 ? resolveImportDate(exp, year, monthIndex) : null,
          exp.card || ''
        );
      } catch { failCount++; }
      setProgress(p => ({ ...p, current: p.current + 1 }));
    }
    setFailed(failCount);
    setDone(true);
    setImporting(false);
  };

  const backdropEl = (
    <div
      className="fixed inset-0 z-40 animate-overlay-in"
      style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
      onClick={!importing ? onClose : undefined}
    />
  );

  if (recurringExpenses.length === 0) return (
    <>
      {backdropEl}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm p-8 text-center"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-secondary)' }}>No recurring expenses saved yet.</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Mark expenses as "Repeats monthly" when adding them.</p>
          <button
            onClick={onClose}
            className="mt-5 px-6 py-2.5 rounded-2xl text-sm font-bold transition-colors"
            style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}
          >
            Close
          </button>
        </div>
      </div>
    </>
  );

  return (
    <>
      {backdropEl}
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden max-h-[85vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'var(--sur-20)' }} />

          <div className="flex items-center justify-between px-6 pt-6 pb-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>Add Recurring Expenses</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{monthName}</p>
            </div>
            {!importing && (
              <button onClick={onClose} className="p-2 rounded-xl transition-colors" style={{ color: 'var(--color-text-muted)' }}>
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-4">
            {done ? (
              <div className="flex flex-col items-center py-8 gap-4">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(72% 0.17 145 / 15%)' }}>
                  <Check className="w-7 h-7" style={{ color: 'var(--color-success)' }} />
                </div>
                <div className="text-center">
                  <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>
                    {progress.total - failed} added
                    {failed > 0 && <span style={{ color: 'var(--color-danger)' }}> · {failed} failed</span>}
                  </p>
                  <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Recurring expenses added to {monthName}</p>
                </div>
              </div>
            ) : importing ? (
              <div className="flex flex-col items-center py-8 gap-4">
                <RefreshCw className="w-8 h-8 animate-spin" style={{ color: 'var(--color-accent-text)' }} />
                <p className="text-sm font-bold" style={{ color: 'var(--color-text-secondary)' }}>
                  Adding {progress.current} of {progress.total}…
                </p>
                <div className="w-48 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--sur-10)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : '0%',
                      background: 'var(--color-accent)',
                    }}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>Uncheck any you want to skip this month.</p>
                {recurringExpenses.map((exp, i) => {
                  const checked = selected.has(i);
                  return (
                    <label
                      key={i}
                      className="flex items-center gap-3 px-4 py-3 rounded-2xl cursor-pointer transition-colors"
                      style={{ border: '1px solid var(--sur-8)', background: 'var(--sur-3)' }}
                    >
                      <div
                        className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 transition-colors"
                        style={{
                          background: checked ? 'var(--color-success)' : 'var(--sur-5)',
                          border: checked ? '2px solid var(--color-success)' : '2px solid var(--sur-20)',
                        }}
                        onClick={() => toggle(i)}
                      >
                        {checked && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{exp.vendor}</p>
                        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{exp.category}</p>
                      </div>
                      {/* Editable — a variable bill would otherwise import
                          whatever it cost the month it was tagged. */}
                      <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.preventDefault()}>
                        <span className="text-sm font-black" style={{ color: 'var(--color-text-muted)' }}>$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={amounts[i] ?? exp.amount}
                          onChange={e => setAmounts(prev => ({ ...prev, [i]: e.target.value }))}
                          className="w-20 rounded-lg px-2 py-1 text-sm font-black text-right outline-none"
                          style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
                        />
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div
            className="px-6 pb-6 pt-4 flex-shrink-0"
            style={{
              borderTop: '1px solid var(--sur-8)',
              paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)',
            }}
          >
            {done ? (
              <button
                onClick={() => { onSuccess?.(); onClose(); }}
                className="w-full py-3 rounded-2xl text-sm font-bold text-white transition-all"
                style={{ background: 'var(--color-success)' }}
              >
                Done
              </button>
            ) : (
              <button
                onClick={handleImport}
                disabled={importing || selected.size === 0}
                className="w-full py-3 rounded-2xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--color-accent)' }}
              >
                Add {selected.size} expense{selected.size !== 1 ? 's' : ''} to {monthName}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
