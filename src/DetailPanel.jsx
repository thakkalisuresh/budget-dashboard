import React, { useState } from 'react';
import { X, Edit2, Check, Trash2, AlertTriangle } from 'lucide-react';
import { updateVendorName, updateVendorAmounts, removeRandomExpenseNote } from './sheetsApi.js';

/**
 * rows: Array of { rowIndex, description, amounts: number[] }
 */
export function DetailPanel({ expense, rows, loading, onClose, accessToken, sheetId, onRefresh, currencySymbol = '$' }) {
  const total = rows ? rows.reduce((s, r) => s + r.amounts.reduce((a, b) => a + b, 0), 0) : 0;

  // Editing state
  const [editingVendor, setEditingVendor]   = useState(null); // { rowIndex, value }
  const [editingAmount, setEditingAmount]   = useState(null); // { rowIndex, amtIndex, value }
  const [deletingVendor, setDeletingVendor] = useState(null); // rowIndex of vendor pending full delete
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState('');

  const inputCls = "bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-xl px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/40 w-full";

  const withSave = async (fn) => {
    setSaving(true);
    setError('');
    try {
      await fn();
      onRefresh?.();
    } catch (e) {
      setError(e.message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  // ── Vendor name edit ────────────────────────────────────────────────────
  const saveVendorName = (row) => {
    const newName = editingVendor?.value?.trim();
    if (!newName || newName === row.description) { setEditingVendor(null); return; }
    withSave(async () => {
      await updateVendorName(expense, row.rowIndex, newName, accessToken, sheetId, row.description);
      setEditingVendor(null);
    });
  };

  // ── Amount edit ─────────────────────────────────────────────────────────
  const saveAmount = (row) => {
    const newVal = parseFloat(editingAmount?.value);
    if (isNaN(newVal) || newVal <= 0) { setEditingAmount(null); return; }
    withSave(async () => {
      const newAmounts = row.amounts.map((a, i) =>
        i === editingAmount.amtIndex ? newVal : a
      );
      const prevTotal = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, newAmounts, accessToken, sheetId, row.description, prevTotal);
      setEditingAmount(null);
    });
  };

  // ── Amount delete (single transaction) ─────────────────────────────────
  const deleteAmount = (row, amtIndex) => {
    if (!window.confirm(
      row.amounts.length === 1
        ? `Delete this transaction and clear the "${row.description}" row entirely?`
        : `Remove ${currencySymbol}${row.amounts[amtIndex].toFixed(2)} from "${row.description}"?`
    )) return;
    withSave(async () => {
      const newAmounts = row.amounts.filter((_, i) => i !== amtIndex);
      const prevTotal = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, newAmounts, accessToken, sheetId, row.description, prevTotal);
      if (newAmounts.length === 0) {
        await removeRandomExpenseNote(sheetId, row.description, accessToken);
      }
    });
  };

  // ── Delete entire vendor (all transactions) ─────────────────────────────
  const deleteAllAmounts = (row) => {
    withSave(async () => {
      const prevTotal = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, [], accessToken, sheetId, row.description, prevTotal);
      await removeRandomExpenseNote(sheetId, row.description, accessToken);
      setDeletingVendor(null);
    });
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 dark:bg-black/50 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-sm bg-white dark:bg-slate-800 z-50 shadow-2xl flex flex-col">

        {/* Header — padded below notch */}
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center flex-shrink-0"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)' }}
        >
          <div>
            <p className="text-lg font-black text-slate-800 dark:text-slate-100">{expense}</p>
            <p className="text-xs text-slate-400 mt-0.5">Itemised breakdown</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mt-3 px-4 py-2.5 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40 rounded-2xl">
            <p className="text-xs text-rose-600 dark:text-rose-400 font-medium">{error}</p>
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">

          {loading && (
            <div className="space-y-3 p-2">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-12 bg-slate-100 dark:bg-slate-700 rounded-2xl animate-pulse" />
              ))}
            </div>
          )}

          {!loading && rows?.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-12">No transactions found</p>
          )}

          {!loading && rows?.map((row) => (
            <div key={row.rowIndex} className="rounded-2xl bg-slate-50 dark:bg-slate-700/40 overflow-hidden">

              {/* ── Vendor name row ── */}
              {deletingVendor === row.rowIndex ? (
                // Layer 2: confirm full delete
                <div className="flex items-center gap-2 px-4 py-2.5 bg-rose-50 dark:bg-rose-900/30 border-b border-rose-100 dark:border-rose-800/40">
                  <AlertTriangle className="w-4 h-4 text-rose-500 flex-shrink-0" />
                  <span className="text-xs font-bold text-rose-700 dark:text-rose-300 flex-1 min-w-0 truncate">
                    Delete <span className="font-black">{row.description}</span> + all {row.amounts.length} transaction{row.amounts.length !== 1 ? 's' : ''}?
                  </span>
                  <button
                    onClick={() => setDeletingVendor(null)}
                    disabled={saving}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors flex-shrink-0"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => deleteAllAmounts(row)}
                    disabled={saving}
                    className="px-2.5 py-1 rounded-lg text-xs font-black text-white bg-rose-500 hover:bg-rose-600 transition-colors flex-shrink-0 disabled:opacity-50"
                  >
                    {saving ? '…' : 'Delete All'}
                  </button>
                </div>
              ) : editingVendor?.rowIndex === row.rowIndex ? (
                // Editing vendor name
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 dark:border-slate-700/50">
                  <input
                    className={inputCls}
                    value={editingVendor.value}
                    onChange={e => setEditingVendor(ev => ({ ...ev, value: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && saveVendorName(row)}
                    autoFocus
                    disabled={saving}
                  />
                  <button
                    onClick={() => saveVendorName(row)}
                    disabled={saving}
                    className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors flex-shrink-0"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setEditingVendor(null)}
                    className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors flex-shrink-0"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                // Normal vendor row
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 dark:border-slate-700/50">
                  <span className="text-sm font-black text-slate-700 dark:text-slate-200 flex-1 truncate">
                    {row.description}
                  </span>
                  <span className="text-sm font-black text-slate-500 dark:text-slate-400 tabular-nums ml-2 flex-shrink-0">
                    {currencySymbol}{row.amounts.reduce((a, b) => a + b, 0).toFixed(2)}
                  </span>
                  <button
                    onClick={() => setEditingVendor({ rowIndex: row.rowIndex, value: row.description })}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors flex-shrink-0"
                    title="Rename vendor"
                  >
                    <Edit2 className="w-3.5 h-3.5" />
                  </button>
                  {/* Layer 1: first delete click */}
                  <button
                    onClick={() => { setEditingAmount(null); setDeletingVendor(row.rowIndex); }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors flex-shrink-0"
                    title="Delete entire vendor"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Individual amounts */}
              {deletingVendor !== row.rowIndex && row.amounts.map((amt, amtIndex) => (
                <div key={amtIndex} className="flex items-center gap-2 px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors group">

                  {editingAmount?.rowIndex === row.rowIndex && editingAmount?.amtIndex === amtIndex ? (
                    <>
                      <span className="text-slate-400 text-sm">{currencySymbol}</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        className={`${inputCls} w-28`}
                        value={editingAmount.value}
                        onChange={e => setEditingAmount(ea => ({ ...ea, value: e.target.value }))}
                        onKeyDown={e => e.key === 'Enter' && saveAmount(row)}
                        autoFocus
                        disabled={saving}
                      />
                      <button
                        onClick={() => saveAmount(row)}
                        disabled={saving}
                        className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 transition-colors flex-shrink-0"
                      >
                        <Check className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => setEditingAmount(null)}
                        className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors flex-shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-slate-400 w-4 text-right flex-shrink-0">
                        {amtIndex + 1}.
                      </span>
                      <span className="text-sm font-medium text-slate-700 dark:text-slate-300 tabular-nums flex-1">
                        {currencySymbol}{amt.toFixed(2)}
                      </span>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => setEditingAmount({ rowIndex: row.rowIndex, amtIndex, value: String(amt) })}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteAmount(row, amtIndex)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Footer total — padded above home indicator */}
        {!loading && rows && rows.length > 0 && (
          <div className="p-6 border-t border-slate-100 dark:border-slate-700 flex justify-between items-center flex-shrink-0"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}
          >
            <span className="text-xs font-black uppercase tracking-widest text-slate-400">Total</span>
            <span className="text-2xl font-black text-slate-900 dark:text-slate-100 tabular-nums">
              {currencySymbol}{total.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </>
  );
}
