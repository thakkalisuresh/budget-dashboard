import React from 'react';
import { BarChart3, AlertCircle } from 'lucide-react';

export function BudgetBarsChart({ expenses, currencySymbol, overallRemaining, barSortOrder }) {
  const sorted = [...expenses].sort((a, b) => {
    if (barSortOrder === 'name')      return a.name.localeCompare(b.name);
    if (barSortOrder === 'remaining') return a.remaining - b.remaining;
    return b.actual - a.actual;
  });

  return (
    <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] border border-slate-100 dark:border-slate-700 p-5 sm:p-8">
      <h2 className="text-sm font-black flex items-center gap-2 mb-5 sm:mb-8 text-slate-800 dark:text-slate-100 uppercase tracking-widest">
        <BarChart3 className="w-4 h-4 text-indigo-500" /> Actual vs Budget
      </h2>

      <div className="space-y-4 pt-2 max-h-80 overflow-y-auto pr-1">
        {sorted.map((item, i) => {
          const budget       = item.budget || 1;
          const ratio        = item.actual / budget;
          const isOver       = item.remaining < 0;
          const baseFill     = Math.min(ratio, 1) * 100;
          const overflowFill = isOver ? (ratio - 1) * 100 : 0;
          return (
            <div key={i} className="group">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-semibold text-slate-700 dark:text-slate-300 group-hover:text-indigo-500 transition-colors">{item.name}</span>
                <span className="text-slate-400 font-medium">
                  <span className="text-slate-900 dark:text-slate-100">{currencySymbol}{item.actual.toFixed(0)}</span> / {currencySymbol}{item.budget.toFixed(0)}
                </span>
              </div>
              <div className="relative h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full rounded-full transition-all duration-700 ease-out bg-emerald-500"
                  style={{ width: `${baseFill}%` }}
                />
                {isOver && (
                  <div
                    className="absolute top-0 right-0 h-full transition-all duration-700 ease-out bg-rose-500"
                    style={{ width: `${overflowFill}%` }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-10 flex items-center gap-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.1em]">
        <div className="flex items-center gap-2"><div className="w-4 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-sm" /> Under budget</div>
        <div className="flex items-center gap-2"><div className="w-4 h-1.5 bg-emerald-500 rounded-sm" /> Actual</div>
        <div className="flex items-center gap-2"><div className="w-4 h-1.5 bg-rose-500 rounded-sm" /> Over budget</div>
      </div>

      {overallRemaining < 0 && (
        <div className="mt-6 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40 rounded-[2rem] p-5">
          <div className="flex items-start gap-4">
            <div className="bg-rose-500 p-2 rounded-xl flex-shrink-0">
              <AlertCircle className="w-5 h-5 text-white" />
            </div>
            <div>
              <h4 className="text-sm font-black text-rose-900 dark:text-rose-300 uppercase tracking-tight">Spending Alert</h4>
              <p className="text-xs text-rose-700/80 dark:text-rose-400/80 mt-1.5 leading-relaxed font-medium">
                We are currently <span className="font-bold underline decoration-rose-300 underline-offset-4">{currencySymbol}{Math.abs(overallRemaining).toFixed(2)}</span> over our aggregate monthly budget.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
