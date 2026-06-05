import React from 'react';
import { Trash2 } from 'lucide-react';

export function DeleteMonthDialog({ deleteConfirm, setDeleteConfirm, deleteInput, setDeleteInput, months, setSelectedSheetId, deleteMonth }) {
  if (!deleteConfirm) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={() => setDeleteConfirm(null)}
      />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid oklch(100% 0 0 / 10%)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'oklch(100% 0 0 / 20%)' }} />

          <div className="px-8 pt-8 pb-6 flex-shrink-0" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: 'oklch(62% 0.22 25 / 12%)' }}
            >
              <Trash2 className="w-6 h-6" style={{ color: 'var(--color-danger)' }} />
            </div>
            <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>Remove Month</p>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              This removes it from the list. The Google Sheet will <span className="font-bold" style={{ color: 'var(--color-text)' }}>not</span> be deleted.
            </p>
          </div>

          <div className="px-8 py-6 space-y-4 overflow-y-auto flex-1">
            <p className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
              Type <span className="font-black" style={{ color: 'var(--color-danger)' }}>{deleteConfirm.name}</span> to confirm:
            </p>
            <input
              type="text"
              value={deleteInput}
              onChange={e => setDeleteInput(e.target.value)}
              placeholder={deleteConfirm.name}
              className="w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all"
              style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 12%)', color: 'var(--color-text)' }}
              autoFocus
            />
          </div>

          <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button
              onClick={() => setDeleteConfirm(null)}
              className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
              style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text)' }}
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
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--color-danger)' }}
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
