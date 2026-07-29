import React, { useEffect, useState } from 'react';
import { RefreshCw, Clock, Inbox, Undo2, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { fetchHistory, undoHistoryEntry, formatTxDate } from './sheetsApi.js';
import { getEffectiveSheetMap } from './sheetHelpers.js';
import { scanDuplicates, suggestKeeper, deleteTransactions } from './duplicateScan.js';
import { userMessage } from './errorCodes.js';

const ACTION_STYLE = {
  'Added':            { background: 'oklch(70% 0.15 145 / 12%)', color: 'var(--color-success)',       border: '1px solid oklch(70% 0.15 145 / 25%)' },
  'Receipt Scan':     { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)',   border: '1px solid var(--color-accent-border)' },
  'Updated':          { background: 'oklch(65% 0.16 240 / 12%)', color: 'oklch(72% 0.14 240)',        border: '1px solid oklch(65% 0.16 240 / 25%)' },
  'Edited':           { background: 'oklch(78% 0.16 75 / 12%)',  color: 'oklch(78% 0.16 75)',         border: '1px solid oklch(78% 0.16 75 / 25%)'  },
  'Deleted':          { background: 'oklch(62% 0.22 25 / 12%)',  color: 'var(--color-danger)',         border: '1px solid oklch(62% 0.22 25 / 25%)'  },
  'Renamed':          { background: 'oklch(62% 0.20 295 / 12%)', color: 'oklch(72% 0.18 295)',        border: '1px solid oklch(62% 0.20 295 / 25%)' },
  'Moved':            { background: 'oklch(68% 0.15 175 / 12%)', color: 'oklch(72% 0.13 175)',        border: '1px solid oklch(68% 0.15 175 / 25%)' },
  'Undo':             { background: 'var(--sur-8)',      color: 'var(--color-text-muted)',     border: '1px solid var(--sur-12)'     },
  'Category Added':   { background: 'oklch(68% 0.15 175 / 12%)', color: 'oklch(72% 0.13 175)',        border: '1px solid oklch(68% 0.15 175 / 25%)' },
  'Category Deleted': { background: 'oklch(62% 0.22 25 / 12%)',  color: 'var(--color-danger)',         border: '1px solid oklch(62% 0.22 25 / 25%)'  },
  'Category Renamed': { background: 'oklch(62% 0.20 295 / 12%)', color: 'oklch(72% 0.18 295)',        border: '1px solid oklch(62% 0.20 295 / 25%)' },
  'Budget Updated':   { background: 'oklch(70% 0.15 220 / 12%)', color: 'oklch(72% 0.14 220)',        border: '1px solid oklch(70% 0.15 220 / 25%)' },
  'Import':           { background: 'oklch(62% 0.20 295 / 12%)', color: 'oklch(72% 0.18 295)',        border: '1px solid oklch(62% 0.20 295 / 25%)' },
};

// Amount style per action — Deleted = danger, Renamed = muted, others = normal
function amountStyle(action) {
  if (action === 'Deleted') return { color: 'var(--color-danger)' };
  if (action === 'Renamed') return { color: 'var(--color-text-muted)' };
  return { color: 'var(--color-text)' };
}

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

const SORT_OPTIONS = [
  { value: 'newest',   label: 'Newest first' },
  { value: 'oldest',   label: 'Oldest first' },
  { value: 'amount',   label: 'Amount ↓' },
  { value: 'vendor',   label: 'Vendor A–Z' },
  { value: 'action',   label: 'Action type' },
  { value: 'category', label: 'Category' },
];

function sortEntries(entries, sortBy) {
  const copy = [...entries];
  switch (sortBy) {
    case 'oldest':   return copy.reverse();
    case 'amount':   return copy.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    case 'vendor':   return copy.sort((a, b) => (a.vendor || '').localeCompare(b.vendor || ''));
    case 'action':   return copy.sort((a, b) => (a.action || '').localeCompare(b.action || ''));
    case 'category': return copy.sort((a, b) => (a.category || '').localeCompare(b.category || ''));
    default:         return copy; // newest — already reverse-chronological from fetchHistory
  }
}

/**
 * Duplicates review — clusters of transactions that look like the same
 * purchase, with one kept and the rest removed.
 *
 * Scanning costs one request per category tab, so it runs on expand rather
 * than on every History load. Nothing is deleted without an explicit confirm:
 * the keeper is only a pre-selection, and the user can change it or skip the
 * cluster entirely.
 */
function DuplicatesPanel({ sheetId, accessToken, currencySymbol, onDeleted }) {
  const [open, setOpen]         = useState(false);
  const [clusters, setClusters] = useState(null);  // null = never scanned
  const [scanning, setScanning] = useState(false);
  const [keepers, setKeepers]   = useState({});    // cluster index -> key to keep
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');

  const scan = async () => {
    setScanning(true);
    setError('');
    try {
      const found = await scanDuplicates(Object.keys(getEffectiveSheetMap()), accessToken, sheetId);
      setClusters(found);
      // Pre-select the best candidate so the common case is one confirm.
      const picks = {};
      found.forEach((c, i) => { picks[i] = suggestKeeper(c).key; });
      setKeepers(picks);
    } catch (e) {
      setError(e?.message || 'Could not scan for duplicates.');
    } finally {
      setScanning(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && clusters === null) scan();
  };

  const resolveCluster = async (idx) => {
    const cluster = clusters[idx];
    const keepKey = keepers[idx];
    const toDelete = cluster.filter(e => e.key !== keepKey);
    if (toDelete.length === 0) return;

    const keep = cluster.find(e => e.key === keepKey);
    // Name what disappears, not just what survives — the deleted entry can sit
    // under a different vendor spelling and category than the keeper, so
    // "1 duplicate of X" would describe the wrong row.
    const describe = (e) => `${e.vendor} · ${currencySymbol}${Number(e.amount).toFixed(2)} (${e.category}${e.date ? `, ${e.date}` : ''})`;
    if (!window.confirm(
      `Delete:\n${toDelete.map(e => `• ${describe(e)}`).join('\n')}\n\nKeep:\n• ${describe(keep)}`
    )) return;

    setBusy(true);
    setError('');
    try {
      const res = await deleteTransactions(toDelete, accessToken, sheetId);
      if (res.failed.length > 0) {
        setError(`${res.failed.length} row${res.failed.length !== 1 ? 's' : ''} could not be deleted.`);
      }
      if (res.deleted.length > 0) {
        // Drop the resolved cluster; the rest stay so several can be worked
        // through without a full re-scan between each.
        setClusters(prev => prev.filter((_, i) => i !== idx));
        setKeepers(prev => {
          const next = {};
          Object.entries(prev).forEach(([k, v]) => {
            const n = Number(k);
            if (n < idx) next[n] = v;
            else if (n > idx) next[n - 1] = v;
          });
          return next;
        });
        onDeleted?.();
      }
    } finally {
      setBusy(false);
    }
  };

  const count = clusters?.length ?? 0;
  if (clusters !== null && count === 0 && !error) return null;

  return (
    <div className="rounded-3xl overflow-hidden"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
      <button onClick={toggle}
        className="w-full flex items-center gap-3 px-5 py-4 transition-colors hover:bg-[var(--sur-5)]">
        {open ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
              : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />}
        <Copy className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--color-warning)' }} />
        <span className="text-xs font-black flex-1 text-left" style={{ color: 'var(--color-text)' }}>
          Duplicates{clusters !== null ? ` (${count})` : ''}
        </span>
        {scanning && <RefreshCw className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--color-text-muted)' }} />}
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-4">
          <p className="text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
            Same vendor and amount within a few days, across every category. Pick the one to keep.
          </p>

          {scanning && clusters === null && (
            <div className="space-y-2">
              {[...Array(2)].map((_, i) => (
                <div key={i} className="h-20 rounded-xl animate-pulse" style={{ background: 'var(--sur-6)' }} />
              ))}
            </div>
          )}

          {(clusters || []).map((cluster, idx) => (
            <div key={cluster[0].key} className="rounded-2xl p-3 space-y-2"
              style={{ background: 'var(--sur-6)', border: '1px solid var(--sur-10)' }}>
              {cluster.map(entry => (
                <label key={entry.key} className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name={`dup-${idx}`}
                    checked={keepers[idx] === entry.key}
                    onChange={() => setKeepers(p => ({ ...p, [idx]: entry.key }))}
                    className="flex-shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold truncate" style={{ color: 'var(--color-text)' }}>
                      {entry.vendor || '(no description)'}
                    </p>
                    <p className="text-[10px] truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {entry.category}{entry.date ? ` · ${entry.date}` : ''}
                      {entry.paymentMethod ? ` · ${entry.paymentMethod}` : ' · no card'}
                    </p>
                  </div>
                  <span className="text-xs font-black tabular-nums flex-shrink-0" style={{ color: 'var(--color-text)' }}>
                    {currencySymbol}{Number(entry.amount).toFixed(2)}
                  </span>
                </label>
              ))}
              <button
                onClick={() => resolveCluster(idx)}
                disabled={busy}
                className="w-full py-2 rounded-xl text-[11px] font-black transition-colors disabled:opacity-40"
                style={{ background: 'var(--color-accent)', color: 'white' }}
              >
                Keep selected, delete {cluster.length - 1} other{cluster.length - 1 !== 1 ? 's' : ''}
              </button>
            </div>
          ))}

          {error && (
            <p className="text-[11px] font-semibold" style={{ color: 'var(--color-danger)' }}>{error}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function HistoryTab({ sheetId, accessToken, onRefresh, currencySymbol = '$', refreshKey = 0 }) {
  const [entries, setEntries]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [undoing, setUndoing]       = useState(null);
  const [sortBy, setSortBy]         = useState('newest');

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      setEntries(await fetchHistory(sheetId, accessToken));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [sheetId, refreshKey]);

  const handleUndo = async (entry) => {
    setUndoing(entry.id);
    try {
      await undoHistoryEntry(sheetId, accessToken, entry);
      await load(true);
      onRefresh?.();
    } catch (e) {
      alert(`Undo failed: ${userMessage(e, 'BOT-002')}`);
    } finally {
      setUndoing(null);
    }
  };

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
          <h2 className="text-sm font-black uppercase tracking-widest" style={{ color: 'var(--color-text)' }}>
            Transaction History
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="rounded-xl px-3 py-1.5 text-xs font-bold outline-none cursor-pointer"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="p-2 rounded-xl transition-colors disabled:opacity-40 hover:bg-[var(--sur-5)]"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Duplicates review — above the log, since a duplicate is something to
          act on rather than just read. */}
      {!loading && (
        <DuplicatesPanel
          sheetId={sheetId}
          accessToken={accessToken}
          currencySymbol={currencySymbol}
          onDeleted={() => { load(true); onRefresh?.(); }}
        />
      )}

      {/* Loading skeletons */}
      {loading && (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 rounded-2xl animate-pulse" style={{ background: 'var(--sur-6)' }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <div className="rounded-3xl p-16 flex flex-col items-center gap-3"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'var(--sur-8)' }}>
            <Inbox className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} />
          </div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-muted)' }}>No history yet</p>
          <p className="text-xs text-center max-w-xs" style={{ color: 'var(--color-text-muted)' }}>
            Adding, editing, or deleting expenses will appear here.
          </p>
        </div>
      )}

      {/* Entries */}
      {!loading && entries.length > 0 && (
        <div className="rounded-3xl overflow-hidden"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          {sortEntries(entries, sortBy).map((entry, i) => {
            const badgeStyle = ACTION_STYLE[entry.action] ?? ACTION_STYLE['Edited'];
            const isUndoing = undoing === entry.id;
            const NO_UNDO = new Set(['Category Added', 'Category Deleted']);
            const canUndo = !entry.action.startsWith('Undo') && !NO_UNDO.has(entry.action);

            return (
              <div key={entry.id}
                className="flex items-center gap-3 px-5 py-4 transition-colors group hover:bg-[var(--sur-5)] animate-enter"
                style={{ '--enter-delay': `${Math.min(i, 14) * 25}ms`, ...(i > 0 ? { borderTop: '1px solid var(--sur-6)' } : {}) }}>

                {/* Action badge */}
                <span className="flex-shrink-0 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full whitespace-nowrap"
                  style={badgeStyle}>
                  {entry.action}
                </span>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>
                      {entry.vendor || '—'}
                    </span>
                    {entry.category && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}>
                        {entry.category}
                      </span>
                    )}
                    {entry.paymentMethod && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
                        💳 {entry.paymentMethod}
                      </span>
                    )}
                    {entry.nonMonthly && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: 'oklch(78% 0.16 75 / 12%)', color: 'oklch(78% 0.16 75)' }}>
                        non-monthly
                      </span>
                    )}
                  </div>
                  {entry.details && (
                    <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>{entry.details}</p>
                  )}
                </div>

                {/* Amount + timestamp + user */}
                <div className="text-right flex-shrink-0 min-w-[70px]">
                  <span className="text-sm font-black tabular-nums" style={amountStyle(entry.action)}>
                    {entry.amount != null ? `${currencySymbol}${Number(entry.amount).toFixed(2)}` : '—'}
                  </span>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{formatTimestamp(entry.timestamp)}</p>
                  {entry.txDate && (
                    <p className="text-[10px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Tx: {formatTxDate(entry.txDate)}</p>
                  )}
                  {entry.user && (
                    <p className="text-[10px] font-bold mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{entry.user}</p>
                  )}
                </div>

                {/* Undo button */}
                {canUndo && (
                  <button
                    onClick={() => handleUndo(entry)}
                    disabled={isUndoing || undoing !== null}
                    title="Undo this action"
                    className="flex-shrink-0 p-1.5 rounded-lg transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-[var(--sur-5)]"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {isUndoing
                      ? <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/></svg>
                      : <Undo2 className="w-3.5 h-3.5" />
                    }
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
