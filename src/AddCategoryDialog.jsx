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
  { key: 'need',   label: 'Need',   desc: 'Essentials (rent, groceries, bills)',  hue: 220 },
  { key: 'want',   label: 'Want',   desc: 'Lifestyle (dining, entertainment)',     hue: 55  },
  { key: 'saving', label: 'Saving', desc: 'Future (investments, emergency fund)', hue: 145 },
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
    if (scope === 'future' && futureMonths.length > 0) {
      setStep('question');
    } else {
      runSave(scope === 'future' ? false : null);
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
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={isSaving ? undefined : onClose}
      />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid oklch(100% 0 0 / 10%)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'oklch(100% 0 0 / 20%)' }} />

          {/* Header */}
          <div className="flex items-center justify-between px-8 pt-8 pb-6 flex-shrink-0" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(100% 0 0 / 8%)' }}>
                <FolderPlus className="w-5 h-5" style={{ color: 'var(--color-text-muted)' }} />
              </div>
              <div>
                <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>New Category</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {step === 'question' ? 'Apply to existing months?' : 'Creates a row + detail sheet'}
                </p>
              </div>
            </div>
            {!isSaving && (
              <button onClick={onClose} className="p-2 rounded-xl transition-colors" style={{ color: 'var(--color-text-muted)' }}>
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-5 overflow-y-auto flex-1">

            {/* ── Saving progress ── */}
            {step === 'saving' && (
              <div className="space-y-3">
                {progressItems.map((label, i) => {
                  const done = i < progressIdx, active = i === progressIdx;
                  return (
                    <div
                      key={i}
                      className="flex items-center gap-3 text-sm font-bold transition-all"
                      style={{
                        color: done ? 'var(--color-success)' : active ? 'var(--color-accent-text)' : 'oklch(100% 0 0 / 20%)',
                      }}
                    >
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 transition-colors"
                        style={{
                          background: done ? 'var(--color-success)' : 'transparent',
                          border: done ? 'none' : active ? '2px solid var(--color-accent)' : '2px solid oklch(100% 0 0 / 20%)',
                        }}
                      >
                        {done && <Check className="w-3 h-3 text-white" />}
                        {active && <div className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--color-accent)' }} />}
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
                <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  These months already exist after <span className="font-black" style={{ color: 'var(--color-text)' }}>{currentMonthName}</span>:
                </p>
                <div className="px-4 py-3 rounded-2xl" style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 8%)' }}>
                  {futureMonths.map(m => (
                    <p key={m.sheetId} className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>· {m.name}</p>
                  ))}
                </div>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Should the new category be added to these months too?</p>
                <div className="space-y-2">
                  <button
                    onClick={() => runSave(true)}
                    className="w-full py-3 rounded-2xl text-sm font-bold text-white transition-all"
                    style={{ background: 'var(--color-accent)' }}
                  >
                    Yes — add to all of these
                  </button>
                  <button
                    onClick={() => runSave(false)}
                    className="w-full py-3 rounded-2xl text-sm font-bold transition-colors"
                    style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text)' }}
                  >
                    No — only new months going forward
                  </button>
                </div>
                <button
                  onClick={() => setStep('form')}
                  className="text-xs transition-colors"
                  style={{ color: 'var(--color-text-muted)' }}
                >
                  ← Back
                </button>
              </div>
            )}

            {/* ── Form ── */}
            {step === 'form' && (
              <>
                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Category name</label>
                  <input
                    type="text"
                    placeholder="e.g. Pet Care"
                    value={name}
                    onChange={e => { setName(e.target.value); setError(''); }}
                    onKeyDown={e => e.key === 'Enter' && handleNext()}
                    autoFocus
                    className="w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all"
                    style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 12%)', color: 'var(--color-text)' }}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Category type</label>
                  <div className="grid grid-cols-3 gap-2">
                    {TYPES.map(({ key, label, hue }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setType(key)}
                        className="py-2.5 rounded-2xl text-xs font-black transition-all"
                        style={type === key ? {
                          background: `oklch(65% 0.18 ${hue} / 15%)`,
                          border: `2px solid oklch(65% 0.18 ${hue} / 40%)`,
                          color: `oklch(72% 0.16 ${hue})`,
                        } : {
                          background: 'oklch(100% 0 0 / 5%)',
                          border: '2px solid transparent',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{TYPES.find(t => t.key === type)?.desc}</p>
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
                    Monthly budget <span className="normal-case font-medium" style={{ color: 'oklch(100% 0 0 / 25%)' }}>(optional)</span>
                  </label>
                  <input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.01"
                    value={budget}
                    onChange={e => { setBudget(e.target.value); setError(''); }}
                    className="w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all"
                    style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 12%)', color: 'var(--color-text)' }}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Apply to</label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: 'this',   label: 'This month only' },
                      { key: 'future', label: 'All future months' },
                    ].map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setScope(key)}
                        className="py-2.5 rounded-2xl text-xs font-black transition-all"
                        style={scope === key ? {
                          background: 'var(--color-accent-subtle)',
                          border: '2px solid var(--color-accent-border)',
                          color: 'var(--color-accent-text)',
                        } : {
                          background: 'oklch(100% 0 0 / 5%)',
                          border: '2px solid transparent',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {scope === 'future' && (
                    <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>Budget copied from the amount you set above. Updates the template for all new months.</p>
                  )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-xs font-bold" style={{ color: 'var(--color-danger)' }}>
                    <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          {step === 'form' && (
            <div className="px-8 pb-8 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
              <button
                onClick={onClose}
                className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
                style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text)' }}
              >
                Cancel
              </button>
              <button
                onClick={handleNext}
                disabled={!name.trim()}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--color-accent)' }}
              >
                {scope === 'future' && futureMonths.length > 0 ? 'Next →' : 'Add Category'}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
