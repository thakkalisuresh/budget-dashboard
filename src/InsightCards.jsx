import React from 'react';
import { Info, TrendingUp } from 'lucide-react';

export function InsightCards({ nonMonthlyItems, nonMonthlyTotal, balanceWithoutNonMonthly, potentialDifference, currencySymbol }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      {/* Balance without one-time expenses */}
      <div className="bg-slate-900 dark:bg-slate-800 rounded-[2rem] p-5 sm:p-8 text-white relative overflow-hidden group border border-transparent dark:border-slate-700">
        <div className="relative z-10">
          <div className="bg-white/10 w-10 h-10 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center mb-4 sm:mb-6">
            <Info className="text-indigo-400 w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <h3 className="text-base sm:text-lg font-bold mb-2 sm:mb-3">Balance without one-time expenses</h3>
          {nonMonthlyItems.length > 0 ? (
            <>
              <p className="text-slate-400 text-sm leading-relaxed mb-2">
                Removing {nonMonthlyItems.length} one-time purchase{nonMonthlyItems.length > 1 ? 's' : ''} (
                {currencySymbol}{nonMonthlyTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}) from your total
                <span className={`font-black block text-xl sm:text-2xl mt-2 ${balanceWithoutNonMonthly < 0 ? 'text-rose-400' : 'text-white'}`}>
                  {currencySymbol}{balanceWithoutNonMonthly.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </p>
              <div className="mt-3 space-y-1">
                {nonMonthlyItems.map((item, i) => (
                  <div key={i} className="flex justify-between text-xs text-slate-400">
                    <span className="truncate mr-2">· {item.vendor}</span>
                    <span className="font-bold text-slate-300 flex-shrink-0">{currencySymbol}{item.amount.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-slate-500 text-sm leading-relaxed">
              No one-time expenses tracked this month.
              <span className="block mt-2 text-xs">Mark an expense as "one-time" when adding it, or via the pencil icon in the detail panel.</span>
            </p>
          )}
        </div>
        <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full -mr-16 -mt-16 blur-2xl" />
      </div>

      {/* Budget vs actual difference */}
      <div className="bg-indigo-600 dark:bg-indigo-700 rounded-[2rem] p-5 sm:p-8 text-white relative overflow-hidden group">
        <div className="relative z-10">
          <div className="bg-white/10 w-10 h-10 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center mb-4 sm:mb-6">
            <TrendingUp className="text-white w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <h3 className="text-base sm:text-lg font-bold mb-2 sm:mb-3">Difference between budgeted and actual spent</h3>
          <p className="text-indigo-100 text-sm leading-relaxed mb-4 sm:mb-6">
            Calculated difference between what we budgeted and what we spent
            <span className="text-white font-black block text-xl sm:text-2xl mt-2">
              {currencySymbol}{potentialDifference.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          </p>
          <div className="h-1 w-full bg-white/20 rounded-full overflow-hidden mt-2">
            <div className="h-full bg-white w-3/4 rounded-full" />
          </div>
        </div>
        <div className="absolute bottom-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mb-16 blur-2xl" />
      </div>
    </div>
  );
}
