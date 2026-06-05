import React, { useEffect, useState, useMemo } from 'react';
import { RefreshCw, Inbox, SlidersHorizontal, ArrowUpDown, X, Download, Search, FileText, MessageSquare } from 'lucide-react';
import { getAllCategoryNames, fetchDetailRows, fetchHistory, fuzzyNamesMatch, formatTxDate } from './sheetsApi.js';
import { downloadBlob, downloadCSV, transactionsToJson } from './exportHelpers.js';

const METHOD_LABELS = {
  'Receipt Scan': 'Scan',
  'Import':       'Import',
  'Added':        'Manual',
};

const METHOD_STYLE = {
  'Scan':   { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' },
  'Import': { background: 'oklch(62% 0.20 295 / 15%)', color: 'oklch(72% 0.18 295)', border: '1px solid oklch(62% 0.20 295 / 25%)' },
  'Manual': { background: 'oklch(70% 0.15 145 / 12%)', color: 'var(--color-success)', border: '1px solid oklch(70% 0.15 145 / 25%)' },
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
          method:        match ? (METHOD_LABELS[match.action] || 'Manual') : null,
          // Card lives on the category-sheet row (col F); fall back to the History match
          paymentMethod: row.paymentMethod || match?.paymentMethod || null,
          user:          match?.user || null,
          date:          match?.timestamp || null,
          txDate:        row.date || null,
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

export function LedgerTab({ sheetId, accessToken, currencySymbol = '$', monthName = '', expenses = [], salaryReceived = 0, transactionNotes = {}, onUpdateNote, refreshKey = 0, months = [] }) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);

  const [sortBy, setSortBy]             = useState('date-desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showFilterMenu, setShowFilterMenu] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [allMonthsProgress, setAllMonthsProgress] = useState(null); // { done, total } while fetching
  const [pdfLoading, setPdfLoading]     = useState(false);
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

  // ── Export Option A — Transaction Ledger CSV ─────────────────────────────
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

  // ── Export Option B — Transaction Ledger JSON ─────────────────────────────
  const exportLedgerJson = () => {
    const json = transactionsToJson(displayed);
    downloadBlob(new Blob([json], { type: 'application/json' }), `ledger-${monthName || 'export'}.json`);
    setShowExportMenu(false);
  };

  // ── Export Option C — Monthly Summary CSV ───────────────────────────────
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

  // ── Export Option E — Monthly PDF Report ────────────────────────────────
  const exportPdf = async () => {
    setShowExportMenu(false);
    setPdfLoading(true);
    try {
      const [{ pdf }, { ReportDocument }] = await Promise.all([
        import('@react-pdf/renderer'),
        import('./ReportDocument.jsx'),
      ]);
      const txForPdf = displayed.map(t => ({
        date:     formatTxDate(t.txDate) || formatDate(t.date) || '',
        vendor:   t.vendor,
        category: t.category,
        amount:   t.amount,
      }));
      const blob = await pdf(
        <ReportDocument
          monthName={monthName}
          income={salaryReceived}
          expenses={expenses}
          transactions={txForPdf}
          currencySymbol={currencySymbol}
          generatedDate={new Date().toLocaleDateString()}
        />
      ).toBlob();
      downloadBlob(blob, `fundient-${monthName || 'report'}.pdf`);
    } catch (e) {
      console.error('PDF export failed', e);
    } finally {
      setPdfLoading(false);
    }
  };

  // ── Export Option D — All Months ─────────────────────────────────────────
  const exportAllMonths = async (format) => {
    if (!months.length) return;
    setShowExportMenu(false);
    setAllMonthsProgress({ done: 0, total: months.length });
    const all = [];
    for (const m of months) {
      try {
        const txs = await buildLedger(m.sheetId, accessToken, m.name);
        all.push(...txs.map(t => ({ ...t, month: m.name })));
      } catch {}
      setAllMonthsProgress(p => ({ ...p, done: p.done + 1 }));
    }
    setAllMonthsProgress(null);
    if (format === 'json') {
      const json = transactionsToJson(all);
      downloadBlob(new Blob([json], { type: 'application/json' }), 'fundient-all-months.json');
    } else {
      const headers = ['Month', 'Vendor', 'Category', 'Amount', 'Method', 'User', 'Tx Date', 'Added At'];
      const rows    = all.map(t => [
        t.month, t.vendor, t.category, t.amount.toFixed(2),
        t.method || '', t.user || '',
        formatTxDate(t.txDate) || '', formatDate(t.date) || '',
      ]);
      downloadCSV('fundient-all-months.csv', headers, rows);
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-black uppercase tracking-widest" style={{ color: 'var(--color-text)' }}>Ledger</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{displayed.length} transaction{displayed.length !== 1 ? 's' : ''}</p>
        </div>
        <div className="flex items-center gap-2">

          {/* Export button */}
          <div className="relative">
            <button
              onClick={() => { setShowExportMenu(v => !v); setShowSortMenu(false); setShowFilterMenu(false); }}
              disabled={!!allMonthsProgress || pdfLoading}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors disabled:opacity-50"
              style={{ background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 10%)', color: 'var(--color-text)' }}
            >
              <Download className="w-3.5 h-3.5" />
              {allMonthsProgress ? `Fetching ${allMonthsProgress.done}/${allMonthsProgress.total}…` : pdfLoading ? 'Building PDF…' : 'Export'}
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 glass-medium rounded-2xl overflow-hidden z-20 w-56 animate-dropdown"
                  style={{ border: '1px solid oklch(100% 0 0 / 10%)' }}>
                  <div className="px-4 pt-3 pb-1">
                    <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>This month</p>
                  </div>
                  {[
                    { fn: exportLedger,     label: 'Transaction Ledger', tag: 'CSV',  icon: 'var(--color-accent-text)' },
                    { fn: exportLedgerJson, label: 'Transaction Ledger', tag: 'JSON', icon: 'var(--color-accent-text)' },
                    { fn: exportSummary,    label: 'Monthly Summary',    tag: 'CSV',  icon: 'var(--color-success)' },
                    { fn: exportPdf,        label: 'Monthly Report',     tag: 'PDF',  icon: 'var(--color-danger)' },
                  ].map(({ fn, label, tag, icon }) => (
                    <button key={tag + label} onClick={fn}
                      className="w-full flex items-center justify-between px-4 py-2.5 text-left text-xs font-bold transition-colors hover:bg-white/5"
                      style={{ color: 'var(--color-text)' }}>
                      <div className="flex items-center gap-3">
                        <FileText className="w-4 h-4" style={{ color: icon }} />
                        <span>{label}</span>
                      </div>
                      <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{tag}</span>
                    </button>
                  ))}
                  {months.length > 1 && (
                    <>
                      <div className="h-px mx-4 my-1" style={{ background: 'oklch(100% 0 0 / 8%)' }} />
                      <div className="px-4 pt-2 pb-1">
                        <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>All months</p>
                      </div>
                      {[
                        { fn: () => exportAllMonths('csv'),  tag: 'CSV' },
                        { fn: () => exportAllMonths('json'), tag: 'JSON' },
                      ].map(({ fn, tag }) => (
                        <button key={tag} onClick={fn}
                          className="w-full flex items-center justify-between px-4 py-2.5 last:pb-3 text-left text-xs font-bold transition-colors hover:bg-white/5"
                          style={{ color: 'var(--color-text)' }}>
                          <div className="flex items-center gap-3">
                            <FileText className="w-4 h-4" style={{ color: 'oklch(62% 0.20 295)' }} />
                            <span>Full Year</span>
                          </div>
                          <span className="text-[10px] font-medium" style={{ color: 'var(--color-text-muted)' }}>{tag}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Sort button */}
          <div className="relative">
            <button onClick={() => { setShowSortMenu(v => !v); setShowFilterMenu(false); setShowExportMenu(false); }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
              style={{ background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 10%)', color: 'var(--color-text)' }}>
              <ArrowUpDown className="w-3.5 h-3.5" />
              {SORT_OPTIONS.find(o => o.value === sortBy)?.label}
            </button>
            {showSortMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSortMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 glass-medium rounded-2xl overflow-hidden z-20 w-44 animate-dropdown"
                  style={{ border: '1px solid oklch(100% 0 0 / 10%)' }}>
                  {SORT_OPTIONS.map(o => (
                    <button key={o.value} onClick={() => { setSortBy(o.value); setShowSortMenu(false); }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold transition-colors"
                      style={sortBy === o.value
                        ? { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)' }
                        : { color: 'var(--color-text)' }}
                      onMouseEnter={e => { if (sortBy !== o.value) e.currentTarget.style.background = 'oklch(100% 0 0 / 5%)'; }}
                      onMouseLeave={e => { if (sortBy !== o.value) e.currentTarget.style.background = ''; }}>
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
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
              style={activeFilterCount > 0
                ? { background: 'var(--color-accent)', border: '1px solid var(--color-accent)', color: 'white' }
                : { background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 10%)', color: 'var(--color-text)' }}>
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>
            {showFilterMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowFilterMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 glass-medium rounded-2xl overflow-hidden z-20 w-56 max-h-80 overflow-y-auto animate-dropdown"
                  style={{ border: '1px solid oklch(100% 0 0 / 10%)' }}>
                  <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid oklch(100% 0 0 / 8%)' }}>
                    <span className="text-xs font-black" style={{ color: 'var(--color-text)' }}>Filters</span>
                    {activeFilterCount > 0 && (
                      <button onClick={clearFilters} className="text-[10px] font-bold hover:underline" style={{ color: 'var(--color-danger)' }}>Clear all</button>
                    )}
                  </div>
                  {[
                    { label: 'Category', items: allCategories, setter: setFilterCategories, active: filterCategories },
                    { label: 'Method',   items: allMethods,    setter: setFilterMethods,    active: filterMethods },
                    { label: 'Added by', items: allUsers,      setter: setFilterUsers,      active: filterUsers },
                  ].filter(g => g.items.length > 0).map((group, gi, arr) => (
                    <div key={group.label} className="px-4 py-2" style={gi < arr.length - 1 ? { borderBottom: '1px solid oklch(100% 0 0 / 6%)' } : {}}>
                      <p className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-muted)' }}>{group.label}</p>
                      {group.items.map(item => (
                        <button key={item} onClick={() => toggleFilter(group.setter, item)}
                          className="w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium transition-colors mb-0.5"
                          style={group.active.includes(item)
                            ? { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', fontWeight: 700 }
                            : { color: 'var(--color-text)' }}
                          onMouseEnter={e => { if (!group.active.includes(item)) e.currentTarget.style.background = 'oklch(100% 0 0 / 5%)'; }}
                          onMouseLeave={e => { if (!group.active.includes(item)) e.currentTarget.style.background = ''; }}>
                          {item}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Refresh */}
          <button onClick={() => load(true)} disabled={refreshing}
            className="p-2 rounded-xl transition-colors disabled:opacity-40 hover:bg-white/5"
            style={{ color: 'var(--color-text-muted)' }}>
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          placeholder="Search by vendor, category or amount…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full rounded-2xl pl-10 pr-4 py-2.5 text-sm outline-none transition-all"
          style={{ background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 10%)', color: 'var(--color-text)' }}
        />
        {searchQuery && (
          <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
            style={{ color: 'var(--color-text-muted)' }}>
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Active filter chips */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2">
          {[...filterCategories, ...filterMethods, ...filterUsers].map((val, i) => {
            const setter = i < filterCategories.length ? setFilterCategories
              : i < filterCategories.length + filterMethods.length ? setFilterMethods
              : setFilterUsers;
            return (
              <button key={val} onClick={() => toggleFilter(setter, val)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold"
                style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                {val} <X className="w-3 h-3" />
              </button>
            );
          })}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: 'oklch(100% 0 0 / 6%)' }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && displayed.length === 0 && (
        <div className="rounded-3xl p-16 flex flex-col items-center gap-3"
          style={{ background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 8%)' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'oklch(100% 0 0 / 8%)' }}>
            <Inbox className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} />
          </div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-muted)' }}>
            {searchQuery ? `No results for "${searchQuery}"` : 'No transactions found'}
          </p>
          {(activeFilterCount > 0 || searchQuery) && (
            <button onClick={() => { clearFilters(); setSearchQuery(''); }}
              className="text-xs font-bold hover:underline" style={{ color: 'var(--color-accent-text)' }}>
              Clear search & filters
            </button>
          )}
        </div>
      )}

      {/* Ledger list */}
      {!loading && displayed.length > 0 && (
        <div className="rounded-3xl overflow-hidden"
          style={{ background: 'var(--color-surface)', border: '1px solid oklch(100% 0 0 / 8%)' }}>
          {displayed.map((t, i) => {
            const noteKey = `${sheetId}_${t.category}_${(t.vendor || '').toLowerCase()}_${t.amount.toFixed(2)}`;
            const noteData = transactionNotes[noteKey];
            return (
              <div key={i} className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-white/5 animate-enter"
                style={{ '--enter-delay': `${Math.min(i, 14) * 25}ms`, ...(i > 0 ? { borderTop: '1px solid oklch(100% 0 0 / 6%)' } : {}) }}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{t.vendor}</p>
                  {t.txDate && <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{formatTxDate(t.txDate)}</p>}
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={{ background: 'oklch(100% 0 0 / 8%)', color: 'var(--color-text-muted)' }}>{t.category}</span>
                    {t.method && (
                      <span className="text-[10px] font-black px-2 py-0.5 rounded-full"
                        style={METHOD_STYLE[t.method] || {}}>
                        {t.method}
                      </span>
                    )}
                    {t.paymentMethod && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                        💳 {t.paymentMethod}
                      </span>
                    )}
                    {noteData?.tags?.map(tag => (
                      <span key={tag} className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                        style={{ background: 'oklch(62% 0.20 295 / 15%)', color: 'oklch(72% 0.18 295)' }}>{tag}</span>
                    ))}
                    {noteData?.note && (
                      <span title={noteData.note} style={{ color: 'var(--color-text-muted)' }}>
                        <MessageSquare className="w-3 h-3" />
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-sm font-black tabular-nums" style={{ color: 'var(--color-text)' }}>{currencySymbol}{t.amount.toFixed(2)}</p>
                  {t.date && <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{formatDate(t.date)}</p>}
                  {t.user && <p className="text-[10px] font-bold" style={{ color: 'var(--color-text-muted)' }}>{t.user}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
