import React, { useEffect, useState } from 'react';
import { RefreshCw, Clock, Inbox, Undo2 } from 'lucide-react';
import { fetchHistory, undoHistoryEntry, formatTxDate } from './sheetsApi.js';

const ACTION_STYLE = {
  'Added':            { background: 'oklch(70% 0.15 145 / 12%)', color: 'var(--color-success)',       border: '1px solid oklch(70% 0.15 145 / 25%)' },
  'Receipt Scan':     { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)',   border: '1px solid var(--color-accent-border)' },
  'Updated':          { background: 'oklch(65% 0.16 240 / 12%)', color: 'oklch(72% 0.14 240)',        border: '1px solid oklch(65% 0.16 240 / 25%)' },
  'Edited':           { background: 'oklch(78% 0.16 75 / 12%)',  color: 'oklch(78% 0.16 75)',         border: '1px solid oklch(78% 0.16 75 / 25%)'  },
  'Deleted':          { background: 'oklch(62% 0.22 25 / 12%)',  color: 'var(--color-danger)',         border: '1px solid oklch(62% 0.22 25 / 25%)'  },
  'Renamed':          { background: 'oklch(62% 0.20 295 / 12%)', color: 'oklch(72% 0.18 295)',        border: '1px solid oklch(62% 0.20 295 / 25%)' },
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
      alert(`Undo failed: ${e.message}`);
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
