import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';

export function BudgetBarsChart({ expenses, currencySymbol, overallRemaining, barSortOrder }) {
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Re-trigger on data change (month switch)
  const dataKey = expenses.map(e => `${e.name}:${e.actual}`).join(',');
  const prevKey = useRef(dataKey);
  useEffect(() => {
    if (prevKey.current === dataKey) return;
    prevKey.current = dataKey;
    setMounted(false);
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [dataKey]);

  const sorted = [...expenses].sort((a, b) => {
    if (barSortOrder === 'name')      return a.name.localeCompare(b.name);
    if (barSortOrder === 'remaining') return a.remaining - b.remaining;
    return b.actual - a.actual;
  });

  return (
    <div className="animate-enter bg-white dark:bg-slate-800 rounded-[1.25rem] shadow-[0_4px_20px_rgb(0,0,0,0.04)] dark:shadow-[0_4px_20px_rgb(0,0,0,0.2)] border border-slate-100 dark:border-slate-700 p-5 sm:p-8">
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-5 sm:mb-8">
        Actual vs budget
      </h2>

      <div className="space-y-4 pt-1 max-h-80 overflow-y-auto pr-1">
        {sorted.map((item, i) => {
          const budget       = item.budget || 1;
          const ratio        = item.actual / budget;
          const isOver       = item.remaining < 0;
          const baseFill     = Math.min(ratio, 1) * 100;
          const overflowFill = isOver ? Math.min((ratio - 1) * 100, 100) : 0;

          return (
            <div
              key={i}
              className="group"
              style={{
                opacity: mounted ? 1 : 0,
                transform: mounted ? 'none' : 'translateY(4px)',
                transition: `opacity var(--dur-normal) var(--ease-out), transform var(--dur-normal) var(--ease-out)`,
                transitionDelay: `${i * 35}ms`,
              }}
            >
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-semibold text-slate-700 dark:text-slate-300 group-hover:text-indigo-500 transition-colors duration-[150ms]">
                  {item.name}
                </span>
                <span className="text-slate-400 font-medium tabular-nums">
                  <span className="text-slate-900 dark:text-slate-100">{currencySymbol}{item.actual.toFixed(0)}</span>
                  {' '}/{' '}{currencySymbol}{item.budget.toFixed(0)}
                </span>
              </div>
              <div className="relative h-1.5 w-full bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="absolute top-0 left-0 h-full rounded-full bg-emerald-500"
                  style={{
                    width: mounted ? `${baseFill}%` : '0%',
                    transition: `width 600ms var(--ease-out)`,
                    transitionDelay: `${80 + i * 35}ms`,
                  }}
                />
                {isOver && (
                  <div
                    className="absolute top-0 right-0 h-full rounded-full bg-rose-500"
                    style={{
                      width: mounted ? `${overflowFill}%` : '0%',
                      transition: `width 600ms var(--ease-out)`,
                      transitionDelay: `${200 + i * 35}ms`,
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center gap-5 text-[10px] font-semibold text-slate-400">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-1.5 bg-emerald-500 rounded-full" />
          Spent
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-1.5 bg-rose-500 rounded-full" />
          Over budget
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-full" />
          Remaining
        </div>
      </div>

      {overallRemaining < 0 && (
        <div className="mt-5 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40 rounded-[0.875rem] p-4">
          <div className="flex items-start gap-3">
            <div className="bg-rose-500 p-1.5 rounded-lg flex-shrink-0 mt-0.5">
              <AlertCircle className="w-4 h-4 text-white" />
            </div>
            <div>
              <h4 className="text-sm font-bold text-rose-700 dark:text-rose-300">Over budget</h4>
              <p className="text-xs text-rose-600/80 dark:text-rose-400/80 mt-1 leading-relaxed">
                {currencySymbol}{Math.abs(overallRemaining).toFixed(2)} over the aggregate monthly budget.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
