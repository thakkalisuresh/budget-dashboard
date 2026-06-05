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
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={deleting ? undefined : onClose}
      />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid oklch(62% 0.22 25 / 20%)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'oklch(100% 0 0 / 20%)' }} />

          {/* Header */}
          <div className="px-8 pt-8 pb-6 flex-shrink-0" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'oklch(62% 0.22 25 / 12%)' }}
            >
              <Trash2 className="w-6 h-6" style={{ color: 'var(--color-danger)' }} />
            </div>
            <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>
              Delete "{category.name}"?
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              Step {step} of 3 — {step === 1 ? 'Review warning' : step === 2 ? 'Confirm name' : 'Final confirmation'}
            </p>
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-4 overflow-y-auto flex-1">

            {/* ── Step 1: Warnings ── */}
            {step === 1 && (
              <div className="space-y-3">
                <div
                  className="rounded-2xl p-4 space-y-2"
                  style={{ background: 'oklch(62% 0.22 25 / 8%)', border: '1px solid oklch(62% 0.22 25 / 20%)' }}
                >
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-danger)' }} />
                    <p className="text-sm font-black" style={{ color: 'var(--color-danger)' }}>This cannot be undone</p>
                  </div>
                  <ul className="text-xs space-y-1 ml-6 list-disc" style={{ color: 'oklch(62% 0.22 25 / 80%)' }}>
                    <li>The category row will be removed from your Totals sheet</li>
                    {isCustom
                      ? <li>The entire detail sheet and all its expense entries will be permanently deleted</li>
                      : <li>All expense entries in this category's sheet will be cleared</li>
                    }
                    <li>This will not affect your other categories</li>
                  </ul>
                </div>

                {hasSpending && (
                  <div
                    className="rounded-2xl px-4 py-3 flex items-center gap-3"
                    style={{ background: 'oklch(78% 0.16 75 / 10%)', border: '1px solid oklch(78% 0.16 75 / 25%)' }}
                  >
                    <AlertCircle className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-warning)' }} />
                    <p className="text-xs font-bold" style={{ color: 'var(--color-warning)' }}>
                      This category has <span className="font-black">${category.actual.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span> in expenses this month.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Step 2: Type name ── */}
            {step === 2 && (
              <div className="space-y-3">
                <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
                  Type <span className="font-black" style={{ color: 'var(--color-danger)' }}>{category.name}</span> to continue:
                </p>
                <input
                  type="text"
                  value={nameInput}
                  onChange={e => setNameInput(e.target.value)}
                  placeholder={category.name}
                  autoFocus
                  className="w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all"
                  style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 12%)', color: 'var(--color-text)' }}
                />
              </div>
            )}

            {/* ── Step 3: Final checkbox ── */}
            {step === 3 && (
              <div className="space-y-4">
                <div
                  className="rounded-2xl px-4 py-3"
                  style={{ background: 'oklch(62% 0.22 25 / 8%)', border: '1px solid oklch(62% 0.22 25 / 20%)' }}
                >
                  <p className="text-xs font-bold" style={{ color: 'var(--color-danger)' }}>
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
                    <div
                      className="w-5 h-5 rounded-md flex items-center justify-center transition-colors"
                      style={{
                        background: confirmed ? 'var(--color-danger)' : 'oklch(100% 0 0 / 5%)',
                        border: confirmed ? '2px solid var(--color-danger)' : '2px solid oklch(100% 0 0 / 20%)',
                      }}
                    >
                      {confirmed && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                  </div>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                    I understand this will <span className="font-black" style={{ color: 'var(--color-danger)' }}>permanently delete</span> all expense data and cannot be undone.
                  </p>
                </label>

                {error && (
                  <div className="flex items-center gap-2 text-xs font-bold" style={{ color: 'var(--color-danger)' }}>
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
              className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors disabled:opacity-40"
              style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>

            {step < 3 ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={step === 2 && !nameMatches}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--color-danger)' }}
              >
                Continue →
              </button>
            ) : (
              <button
                onClick={handleDelete}
                disabled={!confirmed || deleting}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--color-danger)' }}
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
