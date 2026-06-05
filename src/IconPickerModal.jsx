import React from 'react';
import { EMOJI_DATA } from './categoryIcons.js';

export function IconPickerModal({ categoryName, currentIcon, onPick, onClose }) {
  const [search, setSearch] = React.useState('');
  const q = search.toLowerCase().trim();
  const filtered = q
    ? EMOJI_DATA.filter(({ k }) => k.some(kw => kw.includes(q))).map(({ e }) => e)
    : EMOJI_DATA.map(({ e }) => e);

  return (
    <>
      <div
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="glass-heavy animate-dialog-enter rounded-3xl w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh]"
          style={{ border: '1px solid var(--sur-10)' }}
        >

          {/* Header */}
          <div
            className="px-6 pt-6 pb-4 flex items-center justify-between flex-shrink-0"
            style={{ borderBottom: '1px solid var(--sur-8)' }}
          >
            <div>
              <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>Choose an icon</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{categoryName}</p>
            </div>
            <span className="text-3xl leading-none">{currentIcon}</span>
          </div>

          {/* Search */}
          <div className="px-4 pt-4 pb-2 flex-shrink-0">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search  (e.g. food, car, home…)"
              autoFocus
              className="w-full rounded-2xl px-4 py-2.5 text-sm outline-none transition-all"
              style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
            />
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto p-3">
            {filtered.length === 0 ? (
              <p className="text-center text-sm py-8" style={{ color: 'var(--color-text-muted)' }}>No results for "{search}"</p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {filtered.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => onPick(emoji)}
                    className="text-xl p-2 rounded-xl transition-colors"
                    style={currentIcon === emoji ? {
                      background: 'var(--color-accent-subtle)',
                      outline: '2px solid var(--color-accent)',
                      outlineOffset: '-2px',
                    } : {}}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 pb-6 pt-2 flex-shrink-0">
            <button
              onClick={onClose}
              className="w-full py-2.5 rounded-2xl text-sm font-bold transition-colors"
              style={{ background: 'var(--sur-8)', color: 'var(--color-text)' }}
            >
              Cancel
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
