import React from 'react';
import { Minus, TrendingUp, TrendingDown } from 'lucide-react';

export function InsightCards({
  nonMonthlyItems, nonMonthlyTotal, balanceWithoutNonMonthly,
  potentialDifference, currencySymbol,
}) {
  const isSurplus = potentialDifference >= 0;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
      {/* Balance without one-time expenses */}
      <div className="animate-enter bg-slate-900 dark:bg-slate-800 rounded-[1.25rem] p-5 sm:p-7 text-white border border-slate-800 dark:border-slate-700"
        style={{ '--enter-delay': '60ms' }}
      >
        <p className="text-[10px] font-semibold text-slate-500 mb-4">
          Balance excl. one-time expenses
        </p>

        {nonMonthlyItems.length > 0 ? (
          <>
            <p className={`text-3xl font-black tabular-nums leading-none mb-4 ${
              balanceWithoutNonMonthly < 0 ? 'text-rose-400' : 'text-white'
            }`}>
              {balanceWithoutNonMonthly < 0 ? '-' : ''}{currencySymbol}
              {Math.abs(balanceWithoutNonMonthly).toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-slate-500 mb-3">
              {nonMonthlyItems.length} one-time purchase{nonMonthlyItems.length > 1 ? 's' : ''} removed
              ({currencySymbol}{nonMonthlyTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })})
            </p>
            <div className="space-y-1.5 border-t border-slate-800 dark:border-slate-700 pt-3">
              {nonMonthlyItems.map((item, i) => (
                <div key={i} className="flex justify-between text-xs text-slate-500">
                  <span className="truncate mr-2">{item.vendor}</span>
                  <span className="font-semibold text-slate-400 flex-shrink-0 tabular-nums">
                    {currencySymbol}{item.amount.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-3xl font-black tabular-nums text-slate-500 leading-none mb-4">
              {currencySymbol}—
            </p>
            <p className="text-xs text-slate-500 leading-relaxed">
              No one-time expenses this month. Mark an expense as "one-time" via the pencil icon in the detail panel.
            </p>
          </>
        )}
      </div>

      {/* Budget vs actual difference */}
      <div
        className="animate-enter rounded-[1.25rem] p-5 sm:p-7 text-white border"
        style={{
          '--enter-delay': '120ms',
          backgroundColor: isSurplus ? 'oklch(55% 0.18 155)' : 'oklch(55% 0.20 20)',
          borderColor: isSurplus ? 'oklch(50% 0.18 155)' : 'oklch(50% 0.20 20)',
        }}
      >
        <p className="text-[10px] font-semibold mb-4" style={{ opacity: 0.65 }}>
          Budget vs actual difference
        </p>

        <div className="flex items-start justify-between gap-4 mb-4">
          <p className="text-3xl font-black tabular-nums leading-none">
            {isSurplus ? '+' : '-'}{currencySymbol}
            {Math.abs(potentialDifference).toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </p>
          <div className="p-2 rounded-lg flex-shrink-0 mt-0.5" style={{ backgroundColor: 'rgba(255,255,255,0.15)' }}>
            {isSurplus
              ? <TrendingDown className="w-4 h-4" />
              : <TrendingUp className="w-4 h-4" />
            }
          </div>
        </div>

        <p className="text-xs leading-relaxed" style={{ opacity: 0.7 }}>
          {isSurplus
            ? 'Spent less than budgeted — good discipline.'
            : 'Spent more than budgeted this month.'}
        </p>
      </div>
    </div>
  );
}
