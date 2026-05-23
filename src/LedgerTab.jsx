import React, { useEffect, useState, useMemo } from 'react';
import { RefreshCw, Inbox, SlidersHorizontal, ArrowUpDown, X, Download, Search, FileText, MessageSquare } from 'lucide-react';
import { getAllCategoryNames, fetchDetailRows, fetchHistory, fuzzyNamesMatch, formatTxDate } from './sheetsApi.js';

const METHOD_LABELS = {
  'Receipt Scan': 'Scan',
  'Import':       'Import',
  'Added':        'Manual',
};

const METHOD_STYLES = {
  'Scan':   'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300',
  'Import': 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300',
  'Manual': 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
};

const SORT_OPTIONS = [
  { value: 'date-desc',   label: 'Date (newest)' },
  { value: 'date-asc',    label: 'Date (oldest)' },
  { value: 'name-asc',    label: 'Name (A→Z)' },
  { value: 'name-desc',   label: 'Name (Z→A)' },
  { value: 'amount-desc', label: 'Amount (high→low)' },
  { value: 'amount-asc',  label: 'Amount (low→high)' },
];

function formatDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return null; }
}

// ── CSV download utility ──────────────────────────────────────────────────────
function downloadCSV(filename, headers, rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [
    headers.map(escape).join(','),
    ...rows.map(r => r.map(escape).join(',')),
  ].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM for Excel
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function buildLedger(sheetId, accessToken, monthName = '') {
  const categories = getAllCategoryNames();
  const [historyEntries, ...categoryRows] = await Promise.all([
    fetchHistory(sheetId, accessToken),
    ...categories.map(cat =>
      fetchDetailRows(cat, accessToken, sheetId, monthName)
        .then(rows => ({ cat, rows }))
        .catch(() => ({ cat, rows: [] }))
    ),
  ]);

  const addEvents = historyEntries.filter(e =>
    ['Added', 'Receipt Scan', 'Import'].includes(e.action)
  );

  const transactions = [];
  for (const { cat, rows } of categoryRows) {
    for (const row of rows) {
      row.amounts.forEach((amt, amtIdx) => {
        if (amt <= 0) return;
        const txUuid = row.uuids?.[amtIdx] || '';
        // UUID-first match (precise) — fuzzy fallback for old rows without UUIDs
        const match = (txUuid
          ? addEvents.find(h => h.uuid && h.uuid === txUuid)
          : null)
          ?? addEvents.find(h => {
              const amtMatch  = Math.abs(Number(h.amount) - amt) < 0.05;
              const nameMatch = fuzzyNamesMatch(h.vendor || '', row.description || '');
              const catMatch  = (h.category || '').toLowerCase() === cat.toLowerCase();
              return amtMatch && nameMatch && catMatch;
            });
        transactions.push({
          vendor:    row.description,
          category:  cat,
          amount:    amt,
          uuid:      txUuid,
          method:    match ? (METHOD_LABELS[match.action] || 'Manual') : null,
          user:      match?.user || null,
          date:      match?.timestamp || null,
          txDate:    row.date || null,
          _sortDate: row.date
            ? new Date(row.date + 'T00:00:00').getTime()
            : (match?.timestamp ? new Date(match.timestamp).getTime() : 0),
        });
      });
    }
  }
  return transactions;
}

const CACHE_MS = 2 * 60 * 1000; // 2 minutes
export const ledgerCache = new Map(); // sheetId → { data, fetchedAt }

export function LedgerTab({ sheetId, accessToken, currencySymbol = '$', monthName = '', expenses = [], salaryReceived = 0, transactionNotes = {}, onUpdateNote, refreshKey = 0 }) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);

  const [sortBy, setSortBy]             = useState('date-desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [searchQuery, setSearchQuery]   = useState('');

  const [filterCategories, setFilterCategories] = useState([]);
  const [filterMethods, setFilterMethods]       = useState([]);
  const [filterUsers, setFilterUsers]           = useState([]);

  const load = async (isRefresh = false) => {
    // Serve from cache if fresh (unless explicit refresh)
    const cached = ledgerCache.get(sheetId);
    if (!isRefresh && cached && (Date.now() - cached.fetchedAt < CACHE_MS)) {
      setTransactions(cached.data);
      setLoading(false);
      return;
    }
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const data = await buildLedger(sheetId, accessToken, monthName);
      ledgerCache.set(sheetId, { data, fetchedAt: Date.now() });
      setTransactions(data);
    }
    catch { setTransactions([]); }
    finally { setLoading(false); setRefreshing(false); }
  };

  useEffect(() => { load(); }, [sheetId, refreshKey]);

  const allCategories = useMemo(() => [...new Set(transactions.map(t => t.category))].sort(), [transactions]);
  const allMethods    = useMemo(() => [...new Set(transactions.map(t => t.method).filter(Boolean))].sort(), [transactions]);
  const allUsers      = useMemo(() => [...new Set(transactions.map(t => t.user).filter(Boolean))].sort(), [transactions]);

  const activeFilterCount = filterCategories.length + filterMethods.length + filterUsers.length;

  const displayed = useMemo(() => {
    let list = transactions.filter(t => {
      if (filterCategories.length && !filterCategories.includes(t.category)) return false;
      if (filterMethods.length   && !filterMethods.includes(t.method))       return false;
      if (filterUsers.length     && !filterUsers.includes(t.user))           return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (t.vendor || '').toLowerCase().includes(q) ||
               (t.category || '').toLowerCase().includes(q) ||
               t.amount.toFixed(2).includes(q) ||
               String(Math.floor(t.amount)).includes(q);
      }
      return true;
    });
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'date-desc':   return (b._sortDate || 0) - (a._sortDate || 0);
        case 'date-asc':    return (a._sortDate || 0) - (b._sortDate || 0);
        case 'name-asc':    return (a.vendor || '').localeCompare(b.vendor || '');
        case 'name-desc':   return (b.vendor || '').localeCompare(a.vendor || '');
        case 'amount-desc': return b.amount - a.amount;
        case 'amount-asc':  return a.amount - b.amount;
        default: return 0;
      }
    });
  }, [transactions, sortBy, filterCategories, filterMethods, filterUsers, searchQuery]);

  const toggleFilter = (setter, value) =>
    setter(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);

  const clearFilters = () => { setFilterCategories([]); setFilterMethods([]); setFilterUsers([]); };

  // ── Export Option A — Transaction Ledger ─────────────────────────────────
  const exportLedger = () => {
    const headers = ['Vendor', 'Category', 'Amount', 'Method', 'User', 'Tx Date', 'Added At'];
    const rows    = displayed.map(t => [
      t.vendor, t.category, t.amount.toFixed(2),
      t.method || '', t.user || '',
      formatTxDate(t.txDate) || '', formatDate(t.date) || '',
    ]);
    downloadCSV(`ledger-${monthName || 'export'}.csv`, headers, rows);
    setShowExportMenu(false);
  };

  // ── Export Option B — Monthly Summary ───────────────────────────────────
  const exportSummary = () => {
    const totalActual  = expenses.reduce((s, e) => s + e.actual, 0);
    const totalBudget  = expenses.reduce((s, e) => s + e.budget, 0);
    const headers = ['Category', 'Budget', 'Actual Spent', 'Remaining', 'Status'];
    const rows    = [
      ...expenses.map(e => [
        e.name,
        e.budget.toFixed(2),
        e.actual.toFixed(2),
        e.remaining.toFixed(2),
        e.remaining < 0 ? 'Over' : e.remaining === 0 ? 'Exact' : 'Under',
      ]),
      ['', '', '', '', ''],
      ['TOTAL', totalBudget.toFixed(2), totalActual.toFixed(2), (totalBudget - totalActual).toFixed(2), ''],
      ['Income', salaryReceived.toFixed(2), '', '', ''],
      ['Remaining Income', (salaryReceived - totalActual).toFixed(2), '', '', ''],
    ];
    downloadCSV(`summary-${monthName || 'export'}.csv`, headers, rows);
    setShowExportMenu(false);
  };

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-slate-100">Ledger</p>
          <p className="text-xs text-slate-400 mt-0.5">{displayed.length} transaction{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">

          {/* Export button */}
          <div className="relative">
            <button
              onClick={() => { setShowExportMenu(v => !v); setShowSortMenu(false); setShowFilterMenu(false); }}
              className="flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-bold hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors shadow-sm"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl overflow-hidden z-20 w-52">
                  <button onClick={exportLedger}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                    <FileText className="w-4 h-4 text-indigo-500" />
                    <div>
                      <p>Transaction Ledger</p>
                      <p className="text-[10px] text-slate-400 font-medium mt-0.5">All transactions this month</p>
                    </div>
                  </button>
                  <div className="h-px bg-slate-100 dark:bg-slate-700" />
                  <button onClick={exportSummary}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left text-xs font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors">
                    <FileText className="w-4 h-4 text-emerald-500" />
                    <div>
                      <p>Monthly Summary</p>
                      <p className="text-[10px] text-slate-400 font-medium mt-0.5">Budget vs actual by category</p>
                    </div>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* Sort button */}
          <div className="relative">
            <button onClick={() => { setShowSortMenu(v => !v); setShowFilterMenu(false); setShowExportMenu(false); }}
              className="flex items-center gap-1.5 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 rounded-xl text-xs font-bold hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors shadow-sm">
              <ArrowUpDown className="w-3.5 h-3.5" />
              {SORT_OPTIONS.find(o => o.value === sortBy)?.label}
            </button>
            {showSortMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSortMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl overflow-hidden z-20 w-44">
                  {SORT_OPTIONS.map(o => (
                    <button key={o.value} onClick={() => { setSortBy(o.value); setShowSortMenu(false); }}
                      className={`w-full text-left px-4 py-2.5 text-xs font-bold transition-colors ${sortBy === o.value ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Filter button */}
          <div className="relative">
            <button onClick={() => { setShowFilterMenu(v => !v); setShowSortMenu(false); setShowExportMenu(false); }}
              className={`flex items-center gap-1.5 px-3 py-2 border rounded-xl text-xs font-bold transition-colors shadow-sm ${activeFilterCount > 0 ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-300 dark:hover:border-indigo-600'}`}>
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>
            {showFilterMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowFilterMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl overflow-hidden z-20 w-56 max-h-80 overflow-y-auto">
                  <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between">
                    <span className="text-xs font-black text-slate-700 dark:text-slate-200">Filters</span>
                    {activeFilterCount > 0 && <button onClick={clearFilters} className="text-[10px] font-bold text-rose-500 hover:underline">Clear all</button>}
                  </div>
                  {allCategories.length > 0 && (
                    <div className="px-4 py-2 border-b border-slate-50 dark:border-slate-700/50">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Category</p>
                      {allCategories.map(c => (
                        <button key={c} onClick={() => toggleFilter(setFilterCategories, c)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium transition-colors mb-0.5 ${filterCategories.includes(c) ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  {allMethods.length > 0 && (
                    <div className="px-4 py-2 border-b border-slate-50 dark:border-slate-700/50">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Method</p>
                      {allMethods.map(m => (
                        <button key={m} onClick={() => toggleFilter(setFilterMethods, m)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium transition-colors mb-0.5 ${filterMethods.includes(m) ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                  {allUsers.length > 0 && (
                    <div className="px-4 py-2">
                      <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Added by</p>
                      {allUsers.map(u => (
                        <button key={u} onClick={() => toggleFilter(setFilterUsers, u)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium transition-colors mb-0.5 ${filterUsers.includes(u) ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 font-bold' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                          {u}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Refresh */}
          <button onClick={() => load(true)} disabled={refreshing}
            className="p-2 rounded-xl text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-40">
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          placeholder="Search by vendor, category or amount…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-100 rounded-2xl pl-10 pr-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 transition-all placeholder:text-slate-400"
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Active filter chips */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2">
          {filterCategories.map(c => (
            <button key={c} onClick={() => toggleFilter(setFilterCategories, c)}
              className="flex items-center gap-1 px-2.5 py-1 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 rounded-full text-xs font-bold">
              {c} <X className="w-3 h-3" />
            </button>
          ))}
          {filterMethods.map(m => (
            <button key={m} onClick={() => toggleFilter(setFilterMethods, m)}
              className="flex items-center gap-1 px-2.5 py-1 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 rounded-full text-xs font-bold">
              {m} <X className="w-3 h-3" />
            </button>
          ))}
          {filterUsers.map(u => (
            <button key={u} onClick={() => toggleFilter(setFilterUsers, u)}
              className="flex items-center gap-1 px-2.5 py-1 bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 rounded-full text-xs font-bold">
              {u} <X className="w-3 h-3" />
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => <div key={i} className="h-16 bg-slate-100 dark:bg-slate-800 rounded-2xl animate-pulse" />)}
        </div>
      )}

      {/* Empty state */}
      {!loading && displayed.length === 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-16 flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
            <Inbox className="w-6 h-6 text-slate-400" />
          </div>
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">
            {searchQuery ? `No results for "${searchQuery}"` : 'No transactions found'}
          </p>
          {(activeFilterCount > 0 || searchQuery) && (
            <button onClick={() => { clearFilters(); setSearchQuery(''); }} className="text-xs font-bold text-indigo-500 hover:underline">
              Clear search & filters
            </button>
          )}
        </div>
      )}

      {/* Ledger list */}
      {!loading && displayed.length > 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
          {displayed.map((t, i) => {
            const noteKey = `${sheetId}_${t.category}_${(t.vendor || '').toLowerCase()}_${t.amount.toFixed(2)}`;
            const noteData = transactionNotes[noteKey];
            return (
              <div key={i} className="flex items-center gap-3 px-5 py-4 hover:bg-slate-50/50 dark:hover:bg-slate-700/30 transition-colors">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{t.vendor}</p>
                  {t.txDate && <p className="text-[10px] text-slate-400 mt-0.5">{formatTxDate(t.txDate)}</p>}
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-[10px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">{t.category}</span>
                    {t.method && <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${METHOD_STYLES[t.method] || ''}`}>{t.method}</span>}
                    {/* Tags */}
                    {noteData?.tags?.map(tag => (
                      <span key={tag} className="text-[10px] font-bold px-2 py-0.5 bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 rounded-full">{tag}</span>
                    ))}
                    {/* Note indicator */}
                    {noteData?.note && (
                      <span title={noteData.note} className="text-slate-400">
                        <MessageSquare className="w-3 h-3" />
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-black text-slate-900 dark:text-slate-100 tabular-nums">{currencySymbol}{t.amount.toFixed(2)}</p>
                  {t.date && <p className="text-[10px] text-slate-400 mt-0.5">{formatDate(t.date)}</p>}
                  {t.user && <p className="text-[10px] font-bold text-slate-400">{t.user}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
