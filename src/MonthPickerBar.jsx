import React from 'react';
import { Plus, Trash2 } from 'lucide-react';

export function MonthPickerBar({ selectedSheetId, setSelectedSheetId, monthsLoading, months, selectedMonth, onNewMonth, onDeleteMonth }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        value={selectedSheetId}
        onChange={e => setSelectedSheetId(e.target.value)}
        disabled={monthsLoading}
        className="flex-1 sm:flex-none bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-2xl px-4 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer shadow-sm min-w-0"
      >
        {monthsLoading && <option>Loading…</option>}
        {months.map(m => (
          <option key={m.sheetId} value={m.sheetId}>{m.name}</option>
        ))}
      </select>
      <button
        onClick={onNewMonth}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-2xl text-sm font-bold shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 hover:bg-indigo-700 transition-all active:scale-95"
      >
        <Plus className="w-4 h-4" /> New Month
      </button>
      {selectedMonth && months.length > 1 && (
        <button
          onClick={onDeleteMonth}
          className="p-2 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-rose-500 hover:border-rose-300 dark:hover:border-rose-700 transition-all shadow-sm"
          title="Remove this month"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
