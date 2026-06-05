import React from 'react';
import { Smile, Pencil, Trash2 } from 'lucide-react';

export function CategoryActionSheet({ categoryActionFor, setCategoryActionFor, categoryIcons, setIconPickerFor, setRenamingCategory, setDeletingCategory }) {
  if (!categoryActionFor) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={() => setCategoryActionFor(null)}
      />
      <div className="fixed inset-0 z-50 flex items-end justify-center">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl w-full overflow-hidden"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-4" style={{ background: 'var(--sur-20)' }} />

          <div className="px-6 pb-3 flex items-center gap-3">
            <span className="text-2xl">{categoryIcons[categoryActionFor.name] || '📁'}</span>
            <div>
              <p className="text-base font-black" style={{ color: 'var(--color-text)' }}>{categoryActionFor.name}</p>
              <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Choose an action</p>
            </div>
          </div>

          <div className="px-4 pb-4 space-y-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            <button
              onClick={() => { setCategoryActionFor(null); setIconPickerFor(categoryActionFor.name); }}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left active:scale-[0.98] transition-all"
              style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-8)' }}
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'oklch(78% 0.16 75 / 12%)' }}>
                <Smile className="w-5 h-5" style={{ color: 'var(--color-warning)' }} />
              </div>
              <div>
                <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Change Icon</p>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Pick a new emoji</p>
              </div>
            </button>

            <button
              onClick={() => { setCategoryActionFor(null); setRenamingCategory(categoryActionFor); }}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left active:scale-[0.98] transition-all"
              style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-8)' }}
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'var(--color-accent-subtle)' }}>
                <Pencil className="w-5 h-5" style={{ color: 'var(--color-accent-text)' }} />
              </div>
              <div>
                <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Rename Category</p>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Change the display name</p>
              </div>
            </button>

            <button
              onClick={() => { setCategoryActionFor(null); setDeletingCategory(categoryActionFor); }}
              className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left active:scale-[0.98] transition-all"
              style={{ background: 'oklch(62% 0.22 25 / 8%)', border: '1px solid oklch(62% 0.22 25 / 15%)' }}
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'oklch(62% 0.22 25 / 15%)' }}>
                <Trash2 className="w-5 h-5" style={{ color: 'var(--color-danger)' }} />
              </div>
              <div>
                <p className="text-sm font-bold" style={{ color: 'var(--color-danger)' }}>Delete Category</p>
                <p className="text-xs" style={{ color: 'oklch(62% 0.22 25 / 60%)' }}>Permanently remove</p>
              </div>
            </button>

            <button
              onClick={() => setCategoryActionFor(null)}
              className="w-full py-4 rounded-2xl text-sm font-bold transition-colors mt-1"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
