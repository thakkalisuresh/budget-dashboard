import React, { useState } from 'react';
import { X, Edit2, Check, Trash2, AlertTriangle, MessageSquare, Repeat, Plus } from 'lucide-react';
import { updateVendorName, updateVendorAmounts, updateTransactionDate, unmarkNonMonthly, renameNonMonthly, markNonMonthly, formatTxDate, todayIso } from './sheetsApi.js';

// ── Vendor logo helpers ───────────────────────────────────────────────────────

/** Common vendor name → domain mappings */
const VENDOR_DOMAINS = {
  'walmart':        'walmart.com',
  'safeway':        'safeway.com',
  'whole foods':    'wholefoodsmarket.com',
  'wfm':            'wholefoodsmarket.com',
  'costco':         'costco.com',
  'target':         'target.com',
  'amazon':         'amazon.com',
  'amazon prime':   'amazon.com',
  'netflix':        'netflix.com',
  'spotify':        'spotify.com',
  'walgreens':      'walgreens.com',
  'cvs':            'cvs.com',
  'trader joe':     'traderjoes.com',
  'kroger':         'kroger.com',
  'instacart':      'instacart.com',
  'doordash':       'doordash.com',
  'uber':           'uber.com',
  'lyft':           'lyft.com',
  'airbnb':         'airbnb.com',
  'delta':          'delta.com',
  'southwest':      'southwest.com',
  'chipotle':       'chipotle.com',
  'starbucks':      'starbucks.com',
  'mcdonald':       'mcdonalds.com',
  'comcast':        'comcast.com',
  'at&t':           'att.com',
  'verizon':        'verizon.com',
  'pg&e':           'pge.com',
  'robinhood':      'robinhood.com',
  'apple':          'apple.com',
  'google':         'google.com',
  'microsoft':      'microsoft.com',
  'ikea':           'ikea.com',
  'wayfair':        'wayfair.com',
  'mayuri':         'mayurifoods.com',
  'yellow cab':     'yellowcab.com',
  'seattle yellow': 'yellowcab.com',
};

function vendorDomain(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  for (const [key, domain] of Object.entries(VENDOR_DOMAINS)) {
    if (lower.includes(key)) return domain;
  }
  return null;
}

const CUSTOM_VENDOR_DOMAINS_KEY = 'budget_vendor_domains';

function getCustomVendorDomains() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_VENDOR_DOMAINS_KEY) || '{}'); } catch { return {}; }
}

function setCustomVendorDomain(vendorName, domain) {
  const map = getCustomVendorDomains();
  map[vendorName.toLowerCase()] = domain;
  localStorage.setItem(CUSTOM_VENDOR_DOMAINS_KEY, JSON.stringify(map));
}

function resolveVendorDomain(name) {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  // Check custom overrides first
  const custom = getCustomVendorDomains();
  if (custom[lower]) return custom[lower];
  // Fall back to built-in map
  return vendorDomain(name);
}

function VendorLogo({ name, size = 22, onEditDomain }) {
  const [failed, setFailed] = useState(false);
  const domain = resolveVendorDomain(name);
  const letter = (name || '?')[0].toUpperCase();

  const avatar = (
    <div
      onClick={onEditDomain}
      className={`rounded-lg flex items-center justify-center text-white font-black flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity ${['bg-indigo-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-violet-500','bg-sky-500'][letter.charCodeAt(0) % 6]}`}
      style={{ width: size, height: size, fontSize: size * 0.5 }}
      title="Tap to set vendor logo"
    >
      {letter}
    </div>
  );

  if (!domain || failed) return avatar;

  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${domain}&sz=64`}
      alt={name}
      onError={() => setFailed(true)}
      onClick={onEditDomain}
      className="rounded-md object-contain flex-shrink-0 cursor-pointer hover:opacity-80 transition-opacity"
      style={{ width: size, height: size }}
      title="Tap to change vendor logo"
    />
  );
}

/**
 * rows: Array of { rowIndex, description, amounts: number[] }
 */
export function DetailPanel({ expense, rows, loading, onClose, accessToken, sheetId, onRefresh, currencySymbol = '$', onVendorRenamed, monthName, transactionNotes = {}, onUpdateNote, nonMonthlyVendors = [], onNonMonthlyChanged, onAddExpense }) {
  const total = rows ? rows.reduce((s, r) => s + r.amounts.reduce((a, b) => a + b, 0), 0) : 0;

  // Editing state
  const [editingVendor, setEditingVendor]   = useState(null);
  const [editingAmount, setEditingAmount]   = useState(null);
  const [deletingVendor, setDeletingVendor] = useState(null);
  const [saving, setSaving]                 = useState(false);
  const [error, setError]                   = useState('');
  const [editingDomain, setEditingDomain]   = useState(null);
  const [, forceLogoRefresh]               = useState(0);
  // Transaction-level note dialog
  const [noteDialog, setNoteDialog]         = useState(null); // { key, vendor, amount, data }
  const [noteDraft, setNoteDraft]           = useState({ note: '', tags: [] });
  const [noteTagInput, setNoteTagInput]     = useState('');

  const txNoteKey = (vendor, amt) =>
    `${sheetId}_${expense}_${(vendor || '').toLowerCase()}_${Number(amt).toFixed(2)}`;

  const openNoteDialog = (vendor, amt) => {
    const key  = txNoteKey(vendor, amt);
    const data = transactionNotes[key] || { note: '', tags: [] };
    setNoteDraft({ ...data });
    setNoteTagInput('');
    setNoteDialog({ key, vendor, amount: amt, data });
  };

  const saveNoteDialog = () => {
    if (!noteDialog) return;
    onUpdateNote?.(noteDialog.key, { ...noteDraft });
    setNoteDialog(null);
  };

  const deleteNoteDialog = () => {
    if (!noteDialog) return;
    onUpdateNote?.(noteDialog.key, { note: '', tags: [] });
    setNoteDialog(null);
  };

  const addNoteTag = () => {
    const tag = noteTagInput.trim().replace(/^#/, '');
    if (tag && !noteDraft.tags.includes(tag)) setNoteDraft(d => ({ ...d, tags: [...d.tags, tag] }));
    setNoteTagInput('');
  };

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

  // ── Vendor name + date edit ──────────────────────────────────────────────
  const saveVendorName = (row) => {
    const newName       = editingVendor?.value?.trim();
    const wasNonMonthly = editingVendor?.wasNonMonthly ?? false;
    const isNonMonthly  = editingVendor?.isNonMonthly  ?? false;
    if (!newName) { setEditingVendor(null); return; }
    withSave(async () => {
      if (newName !== row.description) {
        await updateVendorName(expense, row.rowIndex, newName, accessToken, sheetId, row.description, row._v2);
        await renameNonMonthly(sheetId, accessToken, row.description, newName);
        onVendorRenamed?.(row.description, newName);
      }
      if (row._v2 && editingVendor?.date !== undefined && editingVendor.date !== row.date) {
        await updateTransactionDate(expense, row.rowIndex, editingVendor.date, accessToken, sheetId);
      }
      if (isNonMonthly !== wasNonMonthly) {
        const total = row.amounts.reduce((a, b) => a + b, 0);
        if (isNonMonthly) await markNonMonthly(sheetId, accessToken, newName, total);
        else              await unmarkNonMonthly(sheetId, accessToken, newName);
        onNonMonthlyChanged?.();
      }
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
      await updateVendorAmounts(expense, row.rowIndex, newAmounts, accessToken, sheetId, row.description, prevTotal, row.uuids || [], row._v2);
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
      const newUuids   = (row.uuids || []).filter((_, i) => i !== amtIndex);
      const prevTotal  = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, newAmounts, accessToken, sheetId, row.description, prevTotal, newUuids, row._v2);
      if (newAmounts.length === 0) await unmarkNonMonthly(sheetId, accessToken, row.description);
    });
  };

  // ── Delete entire vendor (all transactions) ─────────────────────────────
  const deleteAllAmounts = (row) => {
    withSave(async () => {
      const prevTotal = row.amounts.reduce((a, b) => a + b, 0);
      await updateVendorAmounts(expense, row.rowIndex, [], accessToken, sheetId, row.description, prevTotal, [], row._v2);
      await unmarkNonMonthly(sheetId, accessToken, row.description);
      setDeletingVendor(null);
    });
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 dark:bg-black/50 z-[55] backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-full max-w-sm bg-white dark:bg-slate-800 z-[60] shadow-2xl flex flex-col">

        {/* Header — padded below notch */}
        <div className="p-6 border-b border-slate-100 dark:border-slate-700 flex justify-between items-center flex-shrink-0"
          style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)' }}
        >
          <div>
            <p className="text-lg font-black text-slate-800 dark:text-slate-100">{expense}</p>
            <p className="text-xs text-slate-400 mt-0.5">Itemised breakdown</p>
          </div>
          <div className="flex items-center gap-2">
            {onAddExpense && (
              <button
                onClick={onAddExpense}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition-colors shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                Add
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
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
                // Editing vendor name (+ date for v2)
                <div className="flex flex-col border-b border-slate-100 dark:border-slate-700/50">
                  <div className="flex items-center gap-2 px-4 py-2.5">
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
                  {/* Date field — v2 only */}
                  {row._v2 && (
                    <div className="px-4 pb-2.5">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1">Date</p>
                      <input
                        type="date"
                        value={editingVendor.date ?? row.date ?? ''}
                        onChange={e => setEditingVendor(ev => ({ ...ev, date: e.target.value }))}
                        className={inputCls}
                        disabled={saving}
                      />
                    </div>
                  )}
                  {/* Non-monthly toggle */}
                  <label className="flex items-center gap-2.5 px-4 pb-3 cursor-pointer group">
                    <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-colors ${editingVendor.isNonMonthly ? 'bg-indigo-600 border-indigo-600' : 'border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-700'}`}
                      onClick={() => setEditingVendor(ev => ({ ...ev, isNonMonthly: !ev.isNonMonthly }))}>
                      {editingVendor.isNonMonthly && <svg className="w-2.5 h-2.5 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                    </div>
                    <span
                      onClick={() => setEditingVendor(ev => ({ ...ev, isNonMonthly: !ev.isNonMonthly }))}
                      className="text-xs font-bold text-slate-500 dark:text-slate-400 group-hover:text-indigo-500 dark:group-hover:text-indigo-400 transition-colors select-none">
                      One-time / non-monthly expense
                    </span>
                  </label>
                </div>
              ) : (
                // Normal vendor row
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-100 dark:border-slate-700/50">
                  <VendorLogo
                    name={row.description}
                    size={22}
                    onEditDomain={() => setEditingDomain({ vendorName: row.description, draft: resolveVendorDomain(row.description) || '' })}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-black text-slate-700 dark:text-slate-200 block truncate">
                      {row.description}
                    </span>
                    {row._v2 && (
                      <span
                        onClick={() => {
                          const nm = nonMonthlyVendors.includes(row.description.toLowerCase());
                          setEditingVendor({ rowIndex: row.rowIndex, value: row.description, date: row.date || todayIso(), isNonMonthly: nm, wasNonMonthly: nm });
                        }}
                        className={`text-[10px] cursor-pointer ${row.date ? 'text-slate-400' : 'text-indigo-400 font-bold'}`}
                      >
                        {row.date ? formatTxDate(row.date) : '— tap to add date'}
                      </span>
                    )}
                    {row.paymentMethod && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 rounded-full">
                        💳 {row.paymentMethod}
                      </span>
                    )}
                  </div>
                  <span className="text-sm font-black text-slate-500 dark:text-slate-400 tabular-nums ml-2 flex-shrink-0">
                    {currencySymbol}{row.amounts.reduce((a, b) => a + b, 0).toFixed(2)}
                  </span>
                  {/* Non-monthly quick-tap toggle */}
                  <button
                    onClick={() => {
                      const isNm = nonMonthlyVendors.includes(row.description.toLowerCase());
                      const total = row.amounts.reduce((a, b) => a + b, 0);
                      withSave(async () => {
                        if (isNm) await unmarkNonMonthly(sheetId, accessToken, row.description);
                        else      await markNonMonthly(sheetId, accessToken, row.description, total);
                        onNonMonthlyChanged?.();
                      });
                    }}
                    disabled={saving}
                    title={nonMonthlyVendors.includes(row.description.toLowerCase()) ? 'Remove one-time flag' : 'Mark as one-time expense'}
                    className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                      nonMonthlyVendors.includes(row.description.toLowerCase())
                        ? 'text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30'
                        : 'text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30'
                    }`}
                  >
                    <Repeat className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      const nm = nonMonthlyVendors.includes(row.description.toLowerCase());
                      setEditingVendor({ rowIndex: row.rowIndex, value: row.description, isNonMonthly: nm, wasNonMonthly: nm });
                    }}
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
                      <div className="flex gap-1 items-center opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Note icon — always visible if note exists */}
                        {(() => {
                          const key  = txNoteKey(row.description, amt);
                          const data = transactionNotes[key];
                          const has  = data?.note || data?.tags?.length > 0;
                          return (
                            <button
                              onClick={() => openNoteDialog(row.description, amt)}
                              className={`p-1.5 rounded-lg transition-colors ${has ? 'text-violet-500 opacity-100' : 'text-slate-400 hover:text-violet-500 hover:bg-violet-50 dark:hover:bg-violet-900/30'}`}
                              title={has ? 'View/edit note' : 'Add note / tag'}
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                            </button>
                          );
                        })()}
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
      {/* Transaction note dialog */}
      {noteDialog && (
        <>
          <div className="fixed inset-0 bg-black/40 z-[60] backdrop-blur-sm" onClick={() => setNoteDialog(null)} />
          <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
            <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700">
              <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden" />
              <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <p className="text-sm font-black text-slate-800 dark:text-slate-100">Note / Tags</p>
                  <p className="text-xs text-slate-400 mt-0.5">{noteDialog.vendor} · {currencySymbol}{Number(noteDialog.amount).toFixed(2)}</p>
                </div>
                <button onClick={() => setNoteDialog(null)} className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-6 py-4 space-y-3">
                <textarea rows={3} placeholder="Add a note…" value={noteDraft.note}
                  onChange={e => setNoteDraft(d => ({ ...d, note: e.target.value }))}
                  className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-800 dark:text-slate-100 rounded-2xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/60 resize-none placeholder:text-slate-400" />
                <div className="flex gap-2">
                  <input type="text" placeholder="Add tag (Enter)"
                    value={noteTagInput} onChange={e => setNoteTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addNoteTag(); } }}
                    className="flex-1 bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-800 dark:text-slate-100 rounded-2xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/60 placeholder:text-slate-400" />
                  <button onClick={addNoteTag} className="px-3 py-2 bg-indigo-600 text-white text-xs font-bold rounded-2xl hover:bg-indigo-700 transition-colors">Add</button>
                </div>
                {noteDraft.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {noteDraft.tags.map(tag => (
                      <span key={tag} onClick={() => setNoteDraft(d => ({ ...d, tags: d.tags.filter(t => t !== tag) }))}
                        className="flex items-center gap-1 text-xs font-bold px-2.5 py-1 bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded-full cursor-pointer">
                        #{tag} ×
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="px-6 pb-6 flex gap-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
                {(noteDialog.data?.note || noteDialog.data?.tags?.length > 0) && (
                  <button onClick={deleteNoteDialog} className="px-4 py-3 rounded-2xl text-sm font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 transition-colors">
                    Delete
                  </button>
                )}
                <button onClick={() => setNoteDialog(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Cancel
                </button>
                <button onClick={saveNoteDialog} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all">
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Domain edit modal */}
      {editingDomain && (
        <>
          <div className="fixed inset-0 bg-black/40 z-[60] backdrop-blur-sm" onClick={() => setEditingDomain(null)} />
          <div className="fixed inset-0 z-[61] flex items-end sm:items-center justify-center sm:p-4">
            <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700">
              <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden" />
              <div className="px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                <div>
                  <p className="text-sm font-black text-slate-800 dark:text-slate-100">Vendor Logo</p>
                  <p className="text-xs text-slate-400 mt-0.5">{editingDomain.vendorName}</p>
                </div>
                <button onClick={() => setEditingDomain(null)} className="p-1.5 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="px-6 py-5 space-y-3">
                <p className="text-xs text-slate-500 dark:text-slate-400">Enter the website domain to use for the logo:</p>
                <input
                  type="text"
                  value={editingDomain.draft}
                  onChange={e => setEditingDomain(d => ({ ...d, draft: e.target.value }))}
                  placeholder="e.g. walmart.com"
                  autoFocus
                  className={inputCls}
                />
                {editingDomain.draft && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <span>Preview:</span>
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${editingDomain.draft}&sz=64`}
                      alt=""
                      className="w-5 h-5 rounded object-contain"
                      onError={e => e.target.style.display = 'none'}
                    />
                    <span>{editingDomain.draft}</span>
                  </div>
                )}
              </div>
              <div className="px-6 pb-6 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
                <button onClick={() => setEditingDomain(null)} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setCustomVendorDomain(editingDomain.vendorName, editingDomain.draft.trim());
                    setEditingDomain(null);
                    forceLogoRefresh(n => n + 1);
                  }}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
