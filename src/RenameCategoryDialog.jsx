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
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          {/* Header */}
          <div className="flex items-center justify-between px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
                <Pencil className="w-4 h-4 text-slate-600 dark:text-slate-300" />
              </div>
              <div>
                <p className="text-base font-black text-slate-800 dark:text-slate-100">Rename Category</p>
                <p className="text-xs text-slate-400 mt-0.5 truncate max-w-[160px]">{category.name}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="px-8 py-6 space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-black uppercase tracking-widest text-slate-400">New name</label>
              <input
                type="text"
                value={newName}
                onChange={e => { setNewName(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && handleSave()}
                autoFocus
                className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-slate-400/30 placeholder:text-slate-300"
              />
            </div>
            {error && (
              <div className="flex items-center gap-2 text-rose-600 dark:text-rose-400 text-xs font-bold">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-8 pb-8 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
            <button onClick={onClose} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !newName.trim()}
              className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-slate-700 dark:bg-slate-600 hover:bg-slate-800 dark:hover:bg-slate-500 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Rename'}
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
