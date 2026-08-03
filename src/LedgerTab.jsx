import React, { useEffect, useState, useMemo } from 'react';
import { List, useDynamicRowHeight } from 'react-window';
import { RefreshCw, Inbox, SlidersHorizontal, ArrowUpDown, X, Download, Search, FileText, MessageSquare, FolderInput } from 'lucide-react';

// Above this many displayed rows, the list is virtualized (react-window) so we
// only render the visible window. Below it, we keep the lightweight .map() render
// with its staggered entrance animation (no perf issue at typical monthly counts).
const VIRTUALIZE_THRESHOLD = 150;
import { getAllCategoryNames, fetchDetailRows, fetchHistory, fuzzyNamesMatch, formatTxDate, moveTransactionCategory } from './sheetsApi.js';
import { downloadBlob, downloadCSV, transactionsToJson } from './exportHelpers.js';
import { CategoryPickerSheet } from './CategoryPickerSheet.jsx';
import { userMessage } from './errorCodes.js';
import { readMemoryCache, loadCachedLedger, storeLedger } from './ledgerCache.js';
import { txNoteKey } from './transactionNotes.js';
import { relearnMovedSplit } from './sheetItemMemory.js';
import { WRITE_ACTIONS, METHOD_LABELS } from './historyActions.js';

const METHOD_STYLE = {
  'Scan':   { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' },
  'Import': { background: 'oklch(62% 0.20 295 / 15%)', color: 'oklch(72% 0.18 295)', border: '1px solid oklch(62% 0.20 295 / 25%)' },
  'Manual': { background: 'oklch(70% 0.15 145 / 12%)', color: 'var(--color-success)', border: '1px solid oklch(70% 0.15 145 / 25%)' },
  'Recurring': { background: 'oklch(66% 0.17 220 / 15%)', color: 'oklch(72% 0.15 220)', border: '1px solid oklch(66% 0.17 220 / 25%)' },
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

  // WRITE_ACTIONS is shared with the writer (historyActions.js) so the two
  // can't drift — a missing action costs the row its date and badge, not its
  // existence, which reads as "my transaction vanished".
  const addEvents = historyEntries.filter(e => WRITE_ACTIONS.includes(e.action));

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
          // Everything a cross-tab category move needs to reconstruct the sheet row
          rowIndex:      row.rowIndex,
          amtIndex:      amtIdx,
          rowAmounts:    row.amounts,
          rowUuids:      row.uuids || [],
          bookingMethod: row.bookingMethod || '',
          _v2:           row._v2 || false,
          _sortDate: row.date
            ? new Date(row.date + 'T00:00:00').getTime()
            : (match?.timestamp ? new Date(match.timestamp).getTime() : 0),
        });
      });
    }
  }
  return transactions;
}

// Shared row renderer — used by both the animated .map() path and the
// virtualized List path so the markup stays identical. `style`/`animate` differ
// per path: virtualized rows get react-window's absolute-positioning style and
// no entrance animation; animated rows get the staggered --enter-delay.
const LedgerRow = React.memo(function LedgerRow({
  t, index, sheetId, transactionNotes, currencySymbol, style, animate = false, onMove, onOpen,
}) {
  const noteKey = txNoteKey(sheetId, t.category, t.vendor, t.amount);
  const noteData = transactionNotes[noteKey];
  return (
    <div
      className={`flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[var(--sur-5)]${animate ? ' animate-enter' : ''}${onOpen ? ' cursor-pointer' : ''}`}
      style={{
        ...style,
        ...(animate ? { '--enter-delay': `${Math.min(index, 14) * 25}ms` } : {}),
        ...(index > 0 ? { borderTop: '1px solid var(--sur-6)' } : {}),
      }}
      {...(onOpen ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(t),
        // Keyboard parity for the desktop PWA — a div with a click handler is
        // otherwise unreachable without a mouse.
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t); }
        },
      } : {})}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{t.vendor}</p>
        {t.txDate && <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{formatTxDate(t.txDate)}</p>}
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
            style={{ background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}>{t.category}</span>
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
      {onMove && (
        // stopPropagation: the whole row is now clickable, and moving a
        // transaction must not also open the panel behind the picker.
        <button onClick={(e) => { e.stopPropagation(); onMove(t); }}
          className="flex-shrink-0 p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]"
          title="Move to another category" style={{ color: 'var(--color-text-muted)' }}>
          <FolderInput className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
});

// react-window row adapter — receives { index, style, ...rowProps } from <List>.
function VirtualLedgerRow({ index, style, items, sheetId, transactionNotes, currencySymbol, onMove, onOpen }) {
  return (
    <LedgerRow
      t={items[index]}
      index={index}
      style={style}
      sheetId={sheetId}
      transactionNotes={transactionNotes}
      currencySymbol={currencySymbol}
      onMove={onMove}
      onOpen={onOpen}
    />
  );
}

export function LedgerTab({ sheetId, accessToken, currencySymbol = '$', monthName = '', expenses = [], salaryReceived = 0, transactionNotes = {}, onUpdateNote, refreshKey = 0, months = [], onOpen, userId = '' }) {
  const [transactions, setTransactions] = useState([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  // True when a background refresh failed and what's on screen came from cache.
  const [stale, setStale]               = useState(false);

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

  // Move-to-category state: the ledger transaction being moved
  const [movingTx, setMovingTx]   = useState(null);
  const [moveSaving, setMoveSaving] = useState(false);

  // Auto-measured row heights for the virtualized path (rows vary in height as
  // badges/notes wrap). Keyed by sheetId so the measurement cache resets on month switch.
  const rowHeightCache = useDynamicRowHeight({ defaultRowHeight: 76, key: sheetId });

  const load = async (isRefresh = false, silent = false) => {
    // Serve from cache if fresh (unless explicit refresh)
    const cached = readMemoryCache(sheetId);
    if (!isRefresh && cached) {
      setTransactions(cached.data);
      setLoading(false);
      return;
    }
    if (isRefresh) setRefreshing(true);
    else if (!silent) setLoading(true);
    try {
      const data = await buildLedger(sheetId, accessToken, monthName);
      storeLedger(sheetId, data);
      setTransactions(data);
      setStale(false);
    }
    catch {
      if (!silent) setTransactions([]);
      // A silent refresh is the warm-start path: we're already showing cached
      // rows, so blanking them would be worse than keeping them. But failing
      // invisibly is how a stale ledger looks identical to an up-to-date one —
      // flag it so the header can say so and offer a retry.
      else setStale(true);
    }
    finally { setLoading(false); setRefreshing(false); }
  };

  // Warm-start from localStorage cache instantly on sheet change, then refresh in background
  useEffect(() => {
    const cached = loadCachedLedger(sheetId);
    if (cached) {
      setTransactions(cached.data);
      setLoading(false);
      load(false, true);
    } else {
      setTransactions([]);
      load();
    }
  }, [sheetId, refreshKey]);

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

  // Move a single ledger transaction to another category (cross-tab move).
  // For multi-amount V1 rows only the tapped amount moves (amtIndex); a
  // single-amount row moves whole (null) so the source row is fully cleared.
  const doMove = async (targetCategory) => {
    const t = movingTx;
    if (!t) return;
    setMoveSaving(true);
    try {
      await moveTransactionCategory(t.category, targetCategory, {
        rowIndex:      t.rowIndex,
        description:   t.vendor,
        amounts:       t.rowAmounts,
        uuids:         t.rowUuids,
        date:          t.txDate || '',
        paymentMethod: t.paymentMethod || '',
        bookingMethod: t.bookingMethod || '',
        _v2:           t._v2,
      }, accessToken, sheetId, monthName, t.rowAmounts.length > 1 ? t.amtIndex : null);

      // Split-derived transactions carry a splitId in their note: re-teach the
      // line items behind them, and move the note across so a second move is
      // still traceable. Best-effort — the sheet write already succeeded.
      const oldKey = txNoteKey(sheetId, t.category, t.vendor, t.amount);
      const noteData = transactionNotes[oldKey];
      if (noteData?.splitId) {
        relearnMovedSplit({
          userId, accessToken,
          splitId: noteData.splitId,
          fromCategory: t.category,
          toCategory: targetCategory,
        }).catch(() => {});
        onUpdateNote?.(txNoteKey(sheetId, targetCategory, t.vendor, t.amount), noteData);
        onUpdateNote?.(oldKey, { note: '', tags: [] });
      }

      setMovingTx(null);
      await load(true);
    } catch (e) {
      alert(`Move failed: ${userMessage(e, 'SHT-003')}`);
    } finally {
      setMoveSaving(false);
    }
  };

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
              style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}
            >
              <Download className="w-3.5 h-3.5" />
              {allMonthsProgress ? `Fetching ${allMonthsProgress.done}/${allMonthsProgress.total}…` : pdfLoading ? 'Building PDF…' : 'Export'}
            </button>
            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 glass-medium rounded-2xl overflow-hidden z-20 w-56 animate-dropdown"
                  style={{ border: '1px solid var(--sur-10)' }}>
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
                      className="w-full flex items-center justify-between px-4 py-2.5 text-left text-xs font-bold transition-colors hover:bg-[var(--sur-5)]"
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
                      <div className="h-px mx-4 my-1" style={{ background: 'var(--sur-8)' }} />
                      <div className="px-4 pt-2 pb-1">
                        <p className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>All months</p>
                      </div>
                      {[
                        { fn: () => exportAllMonths('csv'),  tag: 'CSV' },
                        { fn: () => exportAllMonths('json'), tag: 'JSON' },
                      ].map(({ fn, tag }) => (
                        <button key={tag} onClick={fn}
                          className="w-full flex items-center justify-between px-4 py-2.5 last:pb-3 text-left text-xs font-bold transition-colors hover:bg-[var(--sur-5)]"
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
              style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}>
              <ArrowUpDown className="w-3.5 h-3.5" />
              {SORT_OPTIONS.find(o => o.value === sortBy)?.label}
            </button>
            {showSortMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowSortMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 glass-medium rounded-2xl overflow-hidden z-20 w-44 animate-dropdown"
                  style={{ border: '1px solid var(--sur-10)' }}>
                  {SORT_OPTIONS.map(o => (
                    <button key={o.value} onClick={() => { setSortBy(o.value); setShowSortMenu(false); }}
                      className="w-full text-left px-4 py-2.5 text-xs font-bold transition-colors"
                      style={sortBy === o.value
                        ? { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)' }
                        : { color: 'var(--color-text)' }}
                      onMouseEnter={e => { if (sortBy !== o.value) e.currentTarget.style.background = 'var(--sur-5)'; }}
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
                : { background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}>
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            </button>
            {showFilterMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowFilterMenu(false)} />
                <div className="absolute right-0 top-full mt-1.5 glass-medium rounded-2xl overflow-hidden z-20 w-56 max-h-80 overflow-y-auto animate-dropdown"
                  style={{ border: '1px solid var(--sur-10)' }}>
                  <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--sur-8)' }}>
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
                    <div key={group.label} className="px-4 py-2" style={gi < arr.length - 1 ? { borderBottom: '1px solid var(--sur-6)' } : {}}>
                      <p className="text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-muted)' }}>{group.label}</p>
                      {group.items.map(item => (
                        <button key={item} onClick={() => toggleFilter(group.setter, item)}
                          className="w-full text-left px-2 py-1.5 rounded-lg text-xs font-medium transition-colors mb-0.5"
                          style={group.active.includes(item)
                            ? { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', fontWeight: 700 }
                            : { color: 'var(--color-text)' }}
                          onMouseEnter={e => { if (!group.active.includes(item)) e.currentTarget.style.background = 'var(--sur-5)'; }}
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
            className="p-2 rounded-xl transition-colors disabled:opacity-40 hover:bg-[var(--sur-5)]"
            style={{ color: 'var(--color-text-muted)' }}>
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Stale notice — a background refresh failed, so these rows came from
          cache and may be missing anything added since. Silent failure is how a
          stale ledger becomes indistinguishable from a current one. */}
      {stale && !refreshing && (
        <button
          onClick={() => load(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-colors"
          style={{
            background: 'oklch(75% 0.15 85 / 12%)',
            color: 'oklch(75% 0.15 85)',
            border: '1px solid oklch(75% 0.15 85 / 25%)',
          }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Showing cached data — tap to retry
        </button>
      )}

      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
        <input
          type="text"
          placeholder="Search by vendor, category or amount…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          className="w-full rounded-2xl pl-10 pr-4 py-2.5 text-sm outline-none transition-all"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}
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
            <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: 'var(--sur-6)' }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && displayed.length === 0 && (
        <div className="rounded-3xl p-16 flex flex-col items-center gap-3"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'var(--sur-8)' }}>
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

      {/* Ledger list — virtualized for large lists, animated .map() otherwise */}
      {!loading && displayed.length > 0 && (
        displayed.length > VIRTUALIZE_THRESHOLD ? (
          <div className="rounded-3xl overflow-hidden"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
            <List
              rowComponent={VirtualLedgerRow}
              rowCount={displayed.length}
              rowHeight={rowHeightCache}
              rowProps={{ items: displayed, sheetId, transactionNotes, currencySymbol, onMove: setMovingTx, onOpen }}
              overscanCount={8}
              style={{ height: 'min(70vh, 760px)' }}
            />
          </div>
        ) : (
          <div className="rounded-3xl overflow-hidden"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
            {displayed.map((t, i) => (
              <LedgerRow
                key={i}
                t={t}
                index={i}
                animate
                sheetId={sheetId}
                transactionNotes={transactionNotes}
                currencySymbol={currencySymbol}
                onMove={setMovingTx}
                onOpen={onOpen}
              />
            ))}
          </div>
        )
      )}

      {/* Move-to-category picker */}
      {movingTx && (
        <CategoryPickerSheet
          title="Move to category"
          subtitle={`${movingTx.vendor} · ${currencySymbol}${movingTx.amount.toFixed(2)}`}
          currentCategory={movingTx.category}
          saving={moveSaving}
          onClose={() => setMovingTx(null)}
          onPick={doMove}
        />
      )}
    </div>
  );
}
