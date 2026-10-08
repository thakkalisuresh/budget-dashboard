import React from 'react';
import { Check, X, GripVertical, FolderPlus, Plus, Pencil, Trash2, MoreHorizontal } from 'lucide-react';
import { hasDetail } from './fetchDetail.js';
import { ReceiptScanButton } from './ReceiptScanner.jsx';

const inputCls = "rounded-xl px-4 py-2 text-sm outline-none transition-all";
const inputStyle = { background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' };

function ExpenseTable({
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
  accessToken, sheetId, monthName, onRefresh, scanTriggerRef, smartRules, cards, cardRules, onSaveRecurring, onSaveTransactionNotes, splitReceiptVendors, userId,
}) {
  return (
    <div
      className="rounded-[2rem] overflow-hidden"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}
    >
      {/* Header */}
      <div className="px-4 py-4 sm:p-8 flex justify-between items-center gap-3" style={{ borderBottom: '1px solid var(--sur-6)' }}>
        <div>
          <h2 className="text-base sm:text-xl font-black" style={{ color: 'var(--color-text)' }}>Expense Breakdown</h2>
          <p className="text-xs sm:text-sm mt-0.5 sm:mt-1 hidden sm:block" style={{ color: 'var(--color-text-muted)' }}>Detailed view of all monthly outgoings</p>
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
            cards={cards}
            cardRules={cardRules}
            onSaveRecurring={onSaveRecurring}
            onSaveTransactionNotes={onSaveTransactionNotes}
            splitReceiptVendors={splitReceiptVendors}
            userId={userId}
          />
          <button
            onClick={onAddCategory}
            title="Add a new budget category"
            className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 rounded-2xl text-sm font-bold transition-all active:scale-95"
            style={{ background: 'var(--sur-6)', border: '1px solid var(--sur-10)', color: 'var(--color-text-secondary)' }}
          >
            <FolderPlus className="w-4 h-4" />
            <span className="hidden sm:inline">New Category</span>
          </button>
          <button
            onClick={onAddExpense}
            className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 rounded-2xl text-sm font-bold text-white transition-all active:scale-95"
            style={{ background: 'var(--color-accent)' }}
          >
            <Plus className="w-4 h-4" /><span className="hidden sm:inline"> Add</span> Expense
          </button>
        </div>
      </div>

      <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-[11px] font-black uppercase tracking-[0.1em]" style={{ color: 'var(--color-text-muted)' }}>
              <th className="px-3 py-4 sm:px-8 sm:py-5">Expense Category</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">Budget</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5">Actual</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5">Remaining</th>
              <th className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">Status</th>
              <th className="px-2 py-4 sm:px-4 sm:py-5" />
            </tr>
          </thead>
          <tbody>
            {isAdding && (
              <tr style={{ background: 'var(--color-accent-subtle)' }}>
                <td className="px-3 py-4 sm:px-8 sm:py-6">
                  <input className={`w-full ${inputCls}`} style={inputStyle} placeholder="e.g. Subscriptions" value={newItem.name} onChange={e => setNewItem({ ...newItem, name: e.target.value })} autoFocus />
                </td>
                <td className="hidden sm:table-cell px-3 py-4 sm:px-8 sm:py-6" />
                <td className="px-3 py-4 sm:px-8 sm:py-6">
                  <input type="number" className={`w-20 sm:w-28 ${inputCls}`} style={inputStyle} placeholder="0.00" value={newItem.amount} onChange={e => setNewItem({ ...newItem, amount: e.target.value })} />
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-6 text-right space-x-2">
                  <button onClick={onInsert} className="p-2 rounded-xl transition-colors" style={{ color: 'var(--color-success)' }}><Check className="w-5 h-5" /></button>
                  <button onClick={() => setIsAdding(false)} className="p-2 rounded-xl transition-colors" style={{ color: 'var(--color-text-muted)' }}><X className="w-5 h-5" /></button>
                </td>
                <td className="hidden sm:table-cell px-8 py-6">
                  <span className="text-xs font-bold px-3 py-1 rounded-full" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' }}>New Entry</span>
                </td>
                <td />
              </tr>
            )}
            {expenses.length === 0 && !isAdding && (
              <tr>
                <td colSpan={6} className="px-8 py-12 text-center">
                  <p className="text-sm font-semibold" style={{ color: 'var(--color-text-muted)' }}>No categories yet — add one to start tracking.</p>
                </td>
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
                className="group transition-all cursor-grab active:cursor-grabbing"
                style={{
                  borderTop: rowIdx === 0 ? 'none' : '1px solid var(--sur-5)',
                  ...(tableDragging === rowIdx
                    ? { opacity: 0.4 }
                    : tableDragOver === rowIdx
                    ? { background: 'var(--color-accent-subtle)', borderTop: '2px solid var(--color-accent)' }
                    : {}),
                }}
              >
                <td className="px-3 py-4 sm:px-8 sm:py-5">
                  {editingId === item.index_ ? (
                    <input className={`w-full ${inputCls}`} style={inputStyle} defaultValue={item.name} id={`edit-name-${item.index_}`} />
                  ) : (
                    <div className="flex items-center gap-2 sm:gap-3">
                      <GripVertical
                        onTouchStart={e => handleGripTouchStart(e, rowIdx)}
                        className="w-3.5 h-3.5 flex-shrink-0 touch-none select-none opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
                        style={{ color: 'var(--color-text-muted)' }}
                      />
                      <button onClick={e => { e.stopPropagation(); setIconPickerFor(item.name); }} title="Change icon" className="text-lg leading-none flex-shrink-0 hover:scale-125 transition-transform select-none">
                        {categoryIcons[item.name] || '📁'}
                      </button>
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.remaining < 0 ? 'bg-rose-400' : item.remaining === 0 ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                      <span
                        className={`font-bold text-sm sm:text-base truncate max-w-[200px] ${hasDetail(item.name) ? 'cursor-pointer underline underline-offset-4' : ''}`}
                        style={{
                          color: 'var(--color-text)',
                          textDecorationColor: hasDetail(item.name) ? 'var(--sur-15)' : undefined,
                        }}
                        title={item.name}
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
                        style={inputStyle}
                      />
                      <button onClick={() => onSaveBudget(item)} className="p-1" style={{ color: 'var(--color-success)' }}><Check className="w-3.5 h-3.5" /></button>
                      <button onClick={() => setEditingBudgetId(null)} className="p-1" style={{ color: 'var(--color-text-muted)' }}><X className="w-3.5 h-3.5" /></button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <span
                        className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums"
                        style={{ background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
                      >
                        {item.budget > 0 ? `${currencySymbol}${item.budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); setEditingBudgetId(item.index_); setBudgetDraft(item.budget.toFixed(2)); }}
                        title="Edit budget"
                        className="p-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-all"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Pencil className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums text-sm sm:text-base font-black" style={{ color: 'var(--color-text)' }}>
                  {editingId === item.index_
                    ? <input type="number" className={`w-20 sm:w-28 ${inputCls}`} style={inputStyle} defaultValue={item.actual} id={`edit-amt-${item.index_}`} />
                    : `${currencySymbol}${item.actual.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                  {editingId === item.index_
                    ? <input type="number" className={`w-20 sm:w-28 ${inputCls}`} style={inputStyle} defaultValue={item.remaining} id={`edit-rem-${item.index_}`} />
                    : <span
                        className="font-bold text-sm sm:text-base"
                        style={{ color: item.remaining < 0 ? 'var(--color-danger)' : item.remaining === 0 ? 'var(--color-warning)' : 'var(--color-success)' }}
                      >
                        {item.remaining < 0 ? '' : '+'}{currencySymbol}{item.remaining.toFixed(2)}
                      </span>}
                </td>
                <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                  <span
                    className="inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider"
                    style={item.remaining < 0
                      ? { background: 'oklch(62% 0.22 25 / 12%)', color: 'var(--color-danger)' }
                      : item.remaining === 0
                      ? { background: 'oklch(78% 0.16 75 / 12%)', color: 'var(--color-warning)' }
                      : { background: 'oklch(72% 0.17 145 / 12%)', color: 'var(--color-success)' }}
                  >
                    {item.remaining < 0 ? 'Over' : item.remaining === 0 ? 'Exact' : 'Under'}
                  </span>
                </td>
                <td className="px-2 py-4 sm:px-4 sm:py-5">
                  <div className="hidden sm:flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={e => { e.stopPropagation(); setRenamingCategory(item); }}
                      title="Rename category"
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={e => { e.stopPropagation(); setDeletingCategory(item); }}
                      title="Delete category"
                      className="p-1.5 rounded-lg transition-colors"
                      style={{ color: 'var(--color-danger)' }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    onClick={e => { e.stopPropagation(); setCategoryActionFor(item); }}
                    className="sm:hidden p-2 rounded-xl transition-colors"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--sur-10)', background: 'var(--sur-4)' }}>
              <td className="px-3 py-4 sm:px-8 sm:py-5">
                <span className="text-xs sm:text-sm font-black uppercase tracking-wide" style={{ color: 'var(--color-text)' }}>Monthly Total</span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums hidden sm:table-cell">
                <span
                  className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums"
                  style={{ background: 'var(--sur-10)', color: 'var(--color-text-muted)' }}
                >
                  {currencySymbol}{totalBudget.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                <span className="text-sm sm:text-base font-black" style={{ color: 'var(--color-text)' }}>
                  {currencySymbol}{totalActual.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                <span
                  className="text-sm sm:text-base font-black"
                  style={{ color: overallRemaining < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}
                >
                  {overallRemaining < 0 ? '' : '+'}{currencySymbol}{overallRemaining.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </td>
              <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                <span
                  className="inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider"
                  style={overallRemaining < 0
                    ? { background: 'oklch(62% 0.22 25 / 12%)', color: 'var(--color-danger)' }
                    : { background: 'oklch(72% 0.17 145 / 12%)', color: 'var(--color-success)' }}
                >
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

export const MemoExpenseTable = React.memo(ExpenseTable);
export { MemoExpenseTable as ExpenseTable };
