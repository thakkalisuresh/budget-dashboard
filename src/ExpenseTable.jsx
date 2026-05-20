import React from 'react';
import { Check, X, GripVertical, FolderPlus, Plus, Pencil, Trash2, MoreHorizontal } from 'lucide-react';
import { hasDetail } from './fetchDetail.js';
import { ReceiptScanButton } from './ReceiptScanner.jsx';

const inputCls = "bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30";

export function ExpenseTable({
  expenses, currencySymbol, categoryIcons,
  totalBudget, totalActual, overallRemaining,
  isAdding, setIsAdding, newItem, setNewItem, onInsert,
  editingId,
  editingBudgetId, setEditingBudgetId, budgetDraft, setBudgetDraft, onSaveBudget,
  onExpenseClick,
  tableDragOver, tableDragging,
  handleTableDragStart, handleTableDragOver, handleTableDrop, handleTableDragEnd, handleGripTouchStart,
  setIconPickerFor, setRenamingCategory, setDeletingCategory, setCategoryActionFor,
  onAddCategory, onAddExpense,
  accessToken, sheetId, monthName, onRefresh, scanTriggerRef, smartRules, onSaveRecurring,
}) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] overflow-hidden">
      <div className="px-4 py-4 sm:p-8 border-b border-slate-50 dark:border-slate-700 flex justify-between items-center gap-3">
        <div>
          <h2 className="text-base sm:text-xl font-black text-slate-800 dark:text-slate-100">Expense Breakdown</h2>
          <p className="text-xs sm:text-sm text-slate-400 mt-0.5 sm:mt-1 hidden sm:block">Detailed view of all monthly outgoings</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <ReceiptScanButton
            accessToken={accessToken}
            sheetId={sheetId}
            monthName={monthName}
            onSuccess={onRefresh}
            activeCategories={expenses.filter(e => e.actual > 0).map(e => e.name)}
            scanTriggerRef={scanTriggerRef}
            smartRules={smartRules}
            onSaveRecurring={onSaveRecurring}
          />
          <button
            onClick={onAddCategory}
            title="Add a new budget category"
            className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 rounded-2xl text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-all active:scale-95"
          >
            <FolderPlus className="w-4 h-4" />
            <span className="hidden sm:inline">New Category</span>
          </button>
          <button
            onClick={onAddExpense}
            className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-indigo-600 text-white rounded-2xl text-sm font-bold shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 hover:bg-indigo-700 transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" /><span className="hidden sm:inline"> Add</span> Expense
          </button>
        </div>
      </div>

      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-left border-collapse min-w-[480px] sm:min-w-0">
          <thead>
            <tr className="text-slate-400 text-[11px] font-black uppercase tracking-[0.1em]">
              <th className="px-3 py-4 sm:px-8 sm:py-5">Expense Category</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">Budget</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5">Actual</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5">Remaining</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">Status</th>
              <th className="px-2 py-4 sm:px-4 sm:py-5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
            {isAdding && (
              <tr className="bg-indigo-50/40 dark:bg-indigo-900/20">
                <td className="px-3 py-4 sm:px-8 sm:py-6">
                  <input className={`w-full ${inputCls}`} placeholder="e.g. Subscriptions" value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })} autoFocus />
                </td>
                <td className="hidden sm:table-cell px-3 py-4 sm:px-8 sm:py-6" />
                <td className="px-3 py-4 sm:px-8 sm:py-6">
                  <input type="number" className={`w-20 sm:w-28 ${inputCls}`} placeholder="0.00" value={newItem.amount} onChange={e => setNewItem({ ...newItem, amount: e.target.value })} />
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-6 text-right space-x-2">
                  <button onClick={onInsert} className="text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2 rounded-xl transition-colors"><Check className="w-5 h-5" /></button>
                  <button onClick={() => setIsAdding(false)} className="text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 p-2 rounded-xl transition-colors"><X className="w-5 h-5" /></button>
                </td>
                <td className="hidden sm:table-cell px-8 py-6"><span className="text-xs text-indigo-500 font-bold bg-indigo-100/50 dark:bg-indigo-900/40 px-3 py-1 rounded-full">New Entry</span></td>
                <td />
              </tr>
            )}
            {expenses.map((item, rowIdx) => (
              <tr
                key={item.index_}
                draggable={editingId !== item.index_}
                onDragStart={e => handleTableDragStart(e, rowIdx)}
                onDragOver={e => handleTableDragOver(e, rowIdx)}
                onDrop={e => handleTableDrop(e, rowIdx)}
                onDragEnd={handleTableDragEnd}
                data-rowindex={rowIdx}
                className={`group transition-all cursor-grab active:cursor-grabbing ${
                  tableDragging === rowIdx ? 'opacity-40'
                  : tableDragOver === rowIdx ? 'bg-indigo-50/60 dark:bg-indigo-900/20 border-t-2 border-indigo-400'
                  : 'hover:bg-slate-50/50 dark:hover:bg-slate-700/30'
                }`}
              >
                <td className="px-3 py-4 sm:px-8 sm:py-5">
                  {editingId === item.index_ ? (
                    <input className={`w-full ${inputCls}`} defaultValue={item.name} id={`edit-name-${item.index_}`} />
                  ) : (
                    <div className="flex items-center gap-2 sm:gap-3">
                      <GripVertical onTouchStart={e => handleGripTouchStart(e, rowIdx)} className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0 touch-none select-none opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity" />
                      <button onClick={e => { e.stopPropagation(); setIconPickerFor(item.name); }} title="Change icon" className="text-lg leading-none flex-shrink-0 hover:scale-125 transition-transform select-none">
                        {categoryIcons[item.name] || '📁'}
                      </button>
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.remaining < 0 ? 'bg-rose-400' : item.remaining === 0 ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                      <span
                        className={`font-bold text-slate-700 dark:text-slate-200 text-sm sm:text-base ${hasDetail(item.name) ? 'cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 underline underline-offset-4 decoration-slate-200 dark:decoration-slate-600' : ''}`}
                        onClick={() => onExpenseClick(item.name)}
                      >
                        {item.name}
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                  {editingBudgetId === item.index_ ? (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        value={budgetDraft}
                        onChange={e => setBudgetDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') onSaveBudget(item); if (e.key === 'Escape') setEditingBudgetId(null); }}
                        autoFocus
                        className={`w-24 ${inputCls}`}
                      />
                      <button onClick={() => onSaveBudget(item)} className="text-emerald-500 hover:text-emerald-600 p-1"><Check className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditingBudgetId(null)} className="text-slate-400 hover:text-slate-500 p-1"><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                        {currencySymbol}{item.budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); setEditingBudgetId(item.index_); setBudgetDraft(item.budget.toFixed(2)); }}
                        title="Edit budget"
                        className="p-1 text-slate-300 dark:text-slate-600 hover:text-indigo-500 transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums text-sm sm:text-base font-black text-slate-800 dark:text-slate-100">
                  {editingId === item.index_
                    ? <input type="number" className={`w-20 sm:w-28 ${inputCls}`} defaultValue={item.actual} id={`edit-amt-${item.index_}`} />
                    : `${currencySymbol}${item.actual.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                  {editingId === item.index_
                    ? <input type="number" className={`w-20 sm:w-28 ${inputCls}`} defaultValue={item.remaining} id={`edit-rem-${item.index_}`} />
                    : <span className={`font-bold text-sm sm:text-base ${item.remaining < 0 ? 'text-rose-500' : item.remaining === 0 ? 'text-amber-400' : 'text-emerald-500'}`}>
                        {item.remaining < 0 ? '' : '+'}{currencySymbol}{item.remaining.toFixed(2)}
                      </span>}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                  <span className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${
                    item.remaining < 0 ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400'
                    : item.remaining === 0 ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
                    : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'
                  }`}>
                    {item.remaining < 0 ? 'Over' : item.remaining === 0 ? 'Exact' : 'Under'}
                  </span>
                </td>
                <td className="px-2 py-4 sm:px-4 sm:py-5">
                  <div className="hidden sm:flex items-center gap-1 opacity-20 group-hover:opacity-100 transition-opacity">
                    <button onClick={e => { e.stopPropagation(); setRenamingCategory(item); }} title="Rename category" className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={e => { e.stopPropagation(); setDeletingCategory(item); }} title="Delete category" className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button onClick={e => { e.stopPropagation(); setCategoryActionFor(item); }} className="sm:hidden p-2 rounded-xl text-slate-400 dark:text-slate-500 active:bg-slate-100 dark:active:bg-slate-700 transition-colors">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-200 dark:border-slate-600 bg-slate-50/80 dark:bg-slate-700/40">
              <td className="px-3 py-4 sm:px-8 sm:py-5"><span className="text-xs sm:text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide">Monthly Total</span></td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums hidden sm:table-cell">
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums bg-slate-200 dark:bg-slate-600 text-slate-500 dark:text-slate-400">
                  {currencySymbol}{totalBudget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                <span className="text-sm sm:text-base font-black text-slate-900 dark:text-slate-100">{currencySymbol}{totalActual.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                <span className={`text-sm sm:text-base font-black ${overallRemaining < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>
                  {overallRemaining < 0 ? '' : '+'}{currencySymbol}{overallRemaining.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${overallRemaining < 0 ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'}`}>
                  {overallRemaining < 0 ? 'Over' : 'Under'}
                </span>
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
