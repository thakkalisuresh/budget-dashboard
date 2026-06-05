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
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden"
          style={{ border: '1px solid oklch(100% 0 0 / 10%)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden" style={{ background: 'oklch(100% 0 0 / 20%)' }} />

          <div className="px-8 pt-6 pb-6" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(65% 0.18 220 / 15%)' }}>
                <Wallet className="w-5 h-5" style={{ color: 'var(--color-accent-text)' }} />
              </div>
              <div>
                <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>Monthly Salary</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Update your take-home pay for this month</p>
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
              className="w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all"
              style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 12%)', color: 'var(--color-text)' }}
            />
          </div>

          <div className="px-8 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
              style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all"
              style={{ background: 'var(--color-accent)' }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
