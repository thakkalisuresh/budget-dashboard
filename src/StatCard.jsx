import React from 'react';
import { Pencil } from 'lucide-react';
import { useCountUp } from './useCountUp.js';

function FormattedValue({ value, currencySymbol }) {
  const animated = useCountUp(value);
  const isNeg = animated < 0;
  const abs = Math.abs(animated).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return <>{isNeg ? '-' : ''}{currencySymbol}{abs}</>;
}

export function StatCard({
  title, value, subtext, onEdit,
  currencySymbol = '$', hero = false, valueColor,
  enterDelay = 0,
}) {
  const isNeg = value < 0;
  const numColor = valueColor || (isNeg
    ? 'text-rose-500 dark:text-rose-400'
    : 'text-slate-900 dark:text-white');

  if (hero) {
    return (
      <div
        className="animate-enter py-6 px-2"
        style={{ '--enter-delay': `${enterDelay}ms` }}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold text-slate-400 tracking-widest uppercase">{title}</p>
          {onEdit && (
            <button
              onClick={onEdit}
              title="Edit"
              className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-[150ms] active:scale-95"
            >
              <Pencil className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <p
          className={`font-extrabold tabular-nums leading-none tracking-tight ${numColor}`}
          style={{ fontSize: 'clamp(2.5rem, 5vw, 3.5rem)' }}
        >
          <FormattedValue value={value} currencySymbol={currencySymbol} />
        </p>

        {subtext && (
          <div className="mt-4">
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
    <div
      className="animate-enter bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-800 px-5 py-4 flex items-center justify-between gap-6"
      style={{ '--enter-delay': `${enterDelay}ms` }}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-400 tracking-wide truncate">{title}</p>
        {subtext && <p className="text-[11px] text-slate-400 mt-0.5">{subtext}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <p className={`text-lg font-extrabold tabular-nums ${numColor}`}>
          <FormattedValue value={value} currencySymbol={currencySymbol} />
        </p>
        {onEdit && (
          <button
            onClick={onEdit}
            title="Edit"
            className="p-1 rounded text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 transition-colors duration-[150ms] active:scale-95"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}
