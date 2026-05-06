import React from 'react';
import { Pencil } from 'lucide-react';

export function StatCard({ title, value, icon, color, subtext, onEdit, currencySymbol = '$' }) {
  const colorClasses = {
    blue:    "bg-blue-50/50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-100/50 dark:border-blue-800/40",
    rose:    "bg-rose-50/50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border-rose-100/50 dark:border-rose-800/40",
    emerald: "bg-emerald-50/50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-100/50 dark:border-emerald-800/40",
    indigo:  "bg-indigo-50/50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border-indigo-100/50 dark:border-indigo-800/40",
    amber:   "bg-amber-50/50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-100/50 dark:border-amber-800/40",
  };
  return (
    <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-5 sm:p-8 space-y-4 sm:space-y-6 shadow-[0_8px_30px_rgb(0,0,0,0.02)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.15)] transition-all hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] hover:-translate-y-1">
      <div className="flex justify-between items-start gap-4">
        <div className={`p-3 sm:p-4 rounded-2xl border flex-shrink-0 ${colorClasses[color]}`}>
          {React.cloneElement(icon, { className: "w-5 h-5 sm:w-7 sm:h-7" })}
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5 mb-2">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{title}</p>
            {onEdit && (
              <button
                onClick={onEdit}
                title="Edit"
                className="p-1 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-all flex-shrink-0"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
          </div>
          <p className="text-2xl sm:text-4xl font-black text-slate-900 dark:text-slate-100 tabular-nums leading-none">{currencySymbol}{value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
      </div>
      {subtext && (
        <div className="flex items-center gap-2 pt-3 border-t border-slate-50 dark:border-slate-700">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{subtext}</p>
        </div>
      )}
    </div>
  );
}
