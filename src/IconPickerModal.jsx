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
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col max-h-[85vh]">

          {/* Header */}
          <div className="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="text-sm font-black text-slate-800 dark:text-slate-100">Choose an icon</p>
              <p className="text-xs text-slate-400 mt-0.5">{categoryName}</p>
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
              className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 placeholder:text-slate-300 dark:placeholder:text-slate-500"
            />
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto p-3">
            {filtered.length === 0 ? (
              <p className="text-center text-sm text-slate-400 py-8">No results for "{search}"</p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {filtered.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => onPick(emoji)}
                    className={`text-xl p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${currentIcon === emoji ? 'bg-indigo-50 dark:bg-indigo-900/30 ring-2 ring-inset ring-indigo-400' : ''}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 pb-6 pt-2 flex-shrink-0">
            <button onClick={onClose} className="w-full py-2.5 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              Cancel
            </button>
          </div>

        </div>
      </div>
    </>
  );
}
