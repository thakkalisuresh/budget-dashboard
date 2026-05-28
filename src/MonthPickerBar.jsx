import React from 'react';
import { Plus, Trash2, ChevronDown } from 'lucide-react';

function abbreviateMonth(name) {
  return name.replace(/^([A-Za-z]{3})[a-z]+(\s)/, '$1$2');
}

export function MonthPickerBar({ selectedSheetId, setSelectedSheetId, monthsLoading, months, selectedMonth, onNewMonth, onDeleteMonth }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {/* Month selector */}
      <div className="relative flex-1 sm:flex-none min-w-0">
        <select
          value={selectedSheetId}
          onChange={e => setSelectedSheetId(e.target.value)}
          disabled={monthsLoading}
          className="w-full sm:w-auto appearance-none bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-xl pl-4 pr-9 py-2 text-sm font-semibold outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 dark:focus:border-indigo-500 cursor-pointer shadow-sm transition-colors duration-[150ms] disabled:opacity-50"
        >
          {monthsLoading && <option>Loading…</option>}
          {months.map(m => (
            <option key={m.sheetId} value={m.sheetId}>{abbreviateMonth(m.name)}</option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
      </div>

      {/* New month */}
      <button
        onClick={onNewMonth}
        className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-semibold shadow-sm shadow-indigo-200 dark:shadow-indigo-900/30 hover:bg-indigo-700 transition-colors duration-[150ms] active:scale-[0.97]"
      >
        <Plus className="w-3.5 h-3.5" />
        New month
      </button>

      {/* Delete month */}
      {selectedMonth && months.length > 1 && (
        <button
          onClick={onDeleteMonth}
          className="p-2 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-rose-500 hover:border-rose-300 dark:hover:border-rose-700 transition-colors duration-[150ms] shadow-sm active:scale-95"
          title="Remove this month"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
