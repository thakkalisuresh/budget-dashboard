import React from 'react';

const CATS = [
  { key: 'needs',   label: '50% — Needs',   targetPct: 0.50, icon: '🏠',
    theme: { bg: 'bg-blue-50 dark:bg-blue-900/20', border: 'border-blue-100 dark:border-blue-800/30',
             label: 'text-blue-600 dark:text-blue-400', bar: 'bg-blue-500', track: 'bg-blue-200 dark:bg-blue-800/50' } },
  { key: 'wants',   label: '30% — Wants',   targetPct: 0.30, icon: '🎯',
    theme: { bg: 'bg-amber-50 dark:bg-amber-900/20', border: 'border-amber-100 dark:border-amber-800/30',
             label: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500', track: 'bg-amber-200 dark:bg-amber-800/50' } },
  { key: 'savings', label: '20% — Savings', targetPct: 0.20, icon: '💰',
    theme: { bg: 'bg-emerald-50 dark:bg-emerald-900/20', border: 'border-emerald-100 dark:border-emerald-800/30',
             label: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500', track: 'bg-emerald-200 dark:bg-emerald-800/50' } },
];

// Target marker sits at this % of the bar width; overflow spills into the remaining portion
const TARGET_MARKER = 72;

export function BudgetRules({ data, loading, currencySymbol = '$' }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-8 h-72 animate-pulse" />
        ))}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xl font-black text-slate-800 dark:text-slate-100">50 / 30 / 20 Budget Rule</p>
        <p className="text-sm text-slate-400 mt-1">Our spending based on the 50/30/20 budget rule</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
        {CATS.map(cat => {
          const d = data[cat.key];
          const isOver = d.diff < 0;
          const ratio = cat.targetPct > 0 ? d.pct / cat.targetPct : 0;

          // Normal fill: 0 → TARGET_MARKER (capped at TARGET_MARKER when over)
          const normalFillPct = Math.min(ratio, 1) * TARGET_MARKER;
          // Overflow fill: TARGET_MARKER → up to 100, only when over
          const overflowFillPct = isOver
            ? Math.min((ratio - 1) * TARGET_MARKER, 100 - TARGET_MARKER)
            : 0;

          return (
            <div key={cat.key} className={`rounded-[2rem] border p-8 flex flex-col ${cat.theme.bg} ${cat.theme.border}`}>
              {/* Header */}
              <div className="flex items-start justify-between mb-6">
                <div>
                  <span className="text-xl mr-2">{cat.icon}</span>
                  <span className={`text-xs font-black uppercase tracking-widest ${cat.theme.label}`}>{cat.label}</span>
                  <p className="text-3xl font-black text-slate-900 dark:text-slate-100 mt-2 tabular-nums">
                    {currencySymbol}{d.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <span className={`text-[10px] font-black px-3 py-1.5 rounded-full uppercase tracking-wider mt-1 ${
                  isOver
                    ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400'
                    : 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400'
                }`}>
                  {isOver ? 'Over' : 'Under'}
                </span>
              </div>

              {/* Progress bar */}
              <div className="mb-6">
                <div className="flex justify-between text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">
                  <span>Actual <span className="text-slate-700 dark:text-slate-200">{(d.pct * 100).toFixed(1)}%</span></span>
                  <span>Target <span className="text-slate-700 dark:text-slate-200">{(cat.targetPct * 100).toFixed(0)}%</span></span>
                </div>
                <div className={`relative h-3 rounded-full overflow-hidden ${cat.theme.track}`}>
                  {/* Normal fill (0 → target marker) */}
                  <div
                    className={`absolute top-0 left-0 h-full transition-all duration-700 ${cat.theme.bar}`}
                    style={{ width: `${normalFillPct}%` }}
                  />
                  {/* Overflow fill (target marker → actual) in red */}
                  {isOver && (
                    <div
                      className="absolute top-0 h-full bg-rose-500 transition-all duration-700"
                      style={{ left: `${TARGET_MARKER}%`, width: `${overflowFillPct}%` }}
                    />
                  )}
                  {/* Target marker line */}
                  <div
                    className="absolute top-0 h-full w-0.5 bg-white/70 dark:bg-white/40 z-10"
                    style={{ left: `${TARGET_MARKER}%` }}
                  />
                </div>
              </div>

              {/* Items — grows to fill available space */}
              <div className="flex-1 space-y-2.5 mb-6">
                {d.items.map((item, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{item.name}</span>
                    <span className="text-xs font-black text-slate-800 dark:text-slate-200 tabular-nums">
                      {currencySymbol}{item.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                ))}
              </div>

              {/* Footer — pinned to bottom of card */}
              <div className="mt-auto pt-4 border-t border-black/5 dark:border-white/10 space-y-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-slate-500 dark:text-slate-400">Target amount</span>
                  <span className="font-bold text-slate-600 dark:text-slate-300 tabular-nums">
                    {currencySymbol}{d.target.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex justify-between text-xs items-center">
                  <span className="font-black text-slate-700 dark:text-slate-200">How much is left to use</span>
                  <span className={`font-black tabular-nums ${d.diff < 0 ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {d.diff < 0 ? '-' : '+'}{currencySymbol}{Math.abs(d.diff).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between text-xs items-center pt-1">
                  <span className="font-black text-slate-700 dark:text-slate-200">% Utilized</span>
                  <span className={`font-black tabular-nums ${
                    d.pct > cat.targetPct
                      ? 'text-rose-500'
                      : d.pct / cat.targetPct >= 0.90
                      ? 'text-amber-500'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}>
                    {(d.pct * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
