import React, { useState } from 'react';
import { X, Pencil, AlertCircle } from 'lucide-react';
import { renameCategory } from './sheetsApi.js';

export function RenameCategoryDialog({ accessToken, sheetId, category, onClose, onSuccess }) {
  const [newName, setNewName] = useState(category.name);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState('');

  const handleSave = async () => {
    const trimmed = newName.trim();
    if (!trimmed)                    return setError('Name cannot be empty.');
    if (trimmed === category.name)   return onClose();

    setSaving(true);
    setError('');
    try {
      await renameCategory(sheetId, accessToken, { oldName: category.name, newName: trimmed });
      onSuccess?.();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
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
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid oklch(100% 0 0 / 10%)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'oklch(100% 0 0 / 20%)' }} />

          {/* Header */}
          <div className="flex items-center justify-between px-8 pt-8 pb-6 flex-shrink-0" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(100% 0 0 / 8%)' }}>
                <Pencil className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
              </div>
              <div>
                <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>Rename Category</p>
                <p className="text-xs mt-0.5 truncate max-w-[160px]" style={{ color: 'var(--color-text-muted)' }}>{category.name}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl transition-colors"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>New name</label>
              <input
                type="text"
                value={newName}
                onChange={e => { setNewName(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                autoFocus
                className="w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all"
                style={{ background: 'oklch(100% 0 0 / 5%)', border: '1px solid oklch(100% 0 0 / 12%)', color: 'var(--color-text)' }}
              />
            </div>
            {error && (
              <div className="flex items-center gap-2 text-xs font-bold" style={{ color: 'var(--color-danger)' }}>
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-8 pb-8 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button
              onClick={onClose}
              className="flex-1 py-3 rounded-2xl text-sm font-bold transition-colors"
              style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !newName.trim()}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--color-accent)' }}
            >
              {saving ? 'Saving…' : 'Rename'}
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
