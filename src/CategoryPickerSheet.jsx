import React from 'react';
import { X } from 'lucide-react';
import { getEffectiveSheetMap } from './sheetsApi.js';
import { getCategoryIcons } from './categoryIcons.js';

/**
 * Bottom-sheet category picker, shared by DetailPanel and LedgerTab for the
 * "move to category" action. Lists every category except the current one.
 * z-index sits above DetailPanel (z-60) so it works from inside the panel.
 */
export function CategoryPickerSheet({ title, subtitle, currentCategory, onPick, onClose, saving = false }) {
  const map   = getEffectiveSheetMap();
  const icons = getCategoryIcons();

  // Dedupe alias keys that point at the same sheet tab (e.g. the legacy
  // 'Utilties' misspelling), keeping the first key per tab. Exclude the
  // current category by tab too, so an alias of it can't be picked.
  const seen = new Set();
  const currentSheet = map[currentCategory]?.sheet;
  const options = Object.entries(map)
    .filter(([, cfg]) => {
      if (cfg.sheet === currentSheet || seen.has(cfg.sheet)) return false;
      seen.add(cfg.sheet);
      return true;
    })
    .map(([name]) => name);

  return (
    <>
      <div
        className="fixed inset-0 z-[70] animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={() => !saving && onClose()}
      />
      <div className="fixed inset-0 z-[71] flex items-end sm:items-center justify-center sm:p-4">
        <div
          className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm overflow-hidden"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}
        >
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden" style={{ background: 'var(--sur-20)' }} />

          <div className="px-6 pt-5 pb-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div className="min-w-0">
              <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>{title || 'Move to category'}</p>
              {subtitle && (
                <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>{subtitle}</p>
              )}
            </div>
            <button
              onClick={onClose}
              disabled={saving}
              className="p-1.5 rounded-xl transition-colors hover:bg-[var(--sur-5)] disabled:opacity-40"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-4 py-4 grid grid-cols-2 gap-2 overflow-y-auto"
            style={{ maxHeight: 'min(50vh, 420px)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
            {options.map(name => (
              <button
                key={name}
                onClick={() => onPick(name)}
                disabled={saving}
                className="flex items-center gap-2.5 px-3.5 py-3 rounded-2xl text-left active:scale-[0.98] transition-all disabled:opacity-50"
                style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-8)' }}
              >
                <span className="text-lg flex-shrink-0">{icons[name] || '📁'}</span>
                <span className="text-xs font-bold truncate" style={{ color: 'var(--color-text)' }}>{name}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
