import React from 'react';
import { Pencil } from 'lucide-react';

export function StatCard({ title, value, subtext, onEdit, currencySymbol = '$', hero = false, valueColor }) {
  const abs = Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const isNeg = value < 0;
  const numColor = valueColor || (isNeg
    ? 'text-rose-500 dark:text-rose-400'
    : 'text-slate-900 dark:text-white');

  if (hero) {
    return (
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-8 sm:p-10">
        <div className="flex items-center justify-between mb-8">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-[0.15em]">{title}</p>
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit"
              className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <p className={`text-5xl sm:text-6xl font-black tabular-nums leading-none tracking-tight ${numColor}`}>
          {isNeg ? '-' : ''}{currencySymbol}{abs}
        </p>
        {subtext && (
          <div className="mt-5">
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              isNeg
                ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400'
                : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
            }`}>
              {subtext}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-800 px-5 py-4 flex items-center justify-between gap-6">
      <div className="min-w-0">
        <p className="text-xs font-medium text-slate-400 uppercase tracking-[0.1em] truncate">{title}</p>
        {subtext && <p className="text-[11px] text-slate-400 mt-0.5">{subtext}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <p className={`text-lg font-black tabular-nums ${numColor}`}>
          {isNeg ? '-' : ''}{currencySymbol}{abs}
        </p>
        {onEdit && (
          <button
            onClick={onEdit}
            title="Edit"
            className="p-1 rounded text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
