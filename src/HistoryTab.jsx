import React, { useEffect, useState } from 'react';
import { RefreshCw, Clock, Inbox, Undo2 } from 'lucide-react';
import { fetchHistory, undoHistoryEntry } from './sheetsApi.js';

const ACTION_STYLES = {
  'Added':           { bg: 'bg-emerald-50 dark:bg-emerald-900/30', text: 'text-emerald-700 dark:text-emerald-300' },
  'Receipt Scan':    { bg: 'bg-indigo-50 dark:bg-indigo-900/30',   text: 'text-indigo-700 dark:text-indigo-300'  },
  'Updated':         { bg: 'bg-blue-50 dark:bg-blue-900/30',       text: 'text-blue-700 dark:text-blue-300'      },
  'Edited':          { bg: 'bg-amber-50 dark:bg-amber-900/30',     text: 'text-amber-700 dark:text-amber-300'    },
  'Deleted':         { bg: 'bg-rose-50 dark:bg-rose-900/30',       text: 'text-rose-700 dark:text-rose-300'      },
  'Renamed':         { bg: 'bg-violet-50 dark:bg-violet-900/30',   text: 'text-violet-700 dark:text-violet-300'  },
  'Undo':            { bg: 'bg-slate-100 dark:bg-slate-700',       text: 'text-slate-500 dark:text-slate-400'    },
  'Category Added':   { bg: 'bg-teal-50 dark:bg-teal-900/30',       text: 'text-teal-700 dark:text-teal-300'      },
  'Category Deleted': { bg: 'bg-rose-50 dark:bg-rose-900/30',        text: 'text-rose-700 dark:text-rose-300'       },
  'Category Renamed': { bg: 'bg-violet-50 dark:bg-violet-900/30',    text: 'text-violet-700 dark:text-violet-300'   },
  'Budget Updated':   { bg: 'bg-sky-50 dark:bg-sky-900/30',          text: 'text-sky-700 dark:text-sky-300'         },
  'Import':           { bg: 'bg-purple-50 dark:bg-purple-900/30',     text: 'text-purple-700 dark:text-purple-300'   },
};

// Amount colour per action — Deleted = rose, Renamed = muted, others = normal
function amountColor(action) {
  if (action === 'Deleted') return 'text-rose-500 dark:text-rose-400';
  if (action === 'Renamed') return 'text-slate-400 dark:text-slate-500';
  return 'text-slate-900 dark:text-slate-100';
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
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-slate-100">
            Transaction History
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 rounded-xl px-3 py-1.5 text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer"
          >
            {SORT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="p-2 rounded-xl text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="space-y-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-16 bg-slate-100 dark:bg-slate-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && entries.length === 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-16 flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
            <Inbox className="w-6 h-6 text-slate-400" />
          </div>
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">No history yet</p>
          <p className="text-xs text-slate-400 text-center max-w-xs">
            Adding, editing, or deleting expenses will appear here.
          </p>
        </div>
      )}

      {/* Entries */}
      {!loading && entries.length > 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
          {sortEntries(entries, sortBy).map((entry) => {
            const style = ACTION_STYLES[entry.action] ?? ACTION_STYLES['Edited'];
            const isUndoing = undoing === entry.id;
            const NO_UNDO = new Set(['Category Added', 'Category Deleted']);
            const canUndo = !entry.action.startsWith('Undo') && !NO_UNDO.has(entry.action);

            return (
              <div key={entry.id} className="flex items-center gap-3 px-5 py-4 hover:bg-slate-50/50 dark:hover:bg-slate-700/30 transition-colors group">

                {/* Action badge */}
                <span className={`flex-shrink-0 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full whitespace-nowrap ${style.bg} ${style.text}`}>
                  {entry.action}
                </span>

                {/* Main info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
                      {entry.vendor || '—'}
                    </span>
                    {entry.category && (
                      <span className="text-[10px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full flex-shrink-0">
                        {entry.category}
                      </span>
                    )}
                    {entry.nonMonthly && (
                      <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 rounded-full flex-shrink-0">
                        non-monthly
                      </span>
                    )}
                  </div>
                  {entry.details && (
                    <p className="text-xs text-slate-400 mt-0.5 truncate">{entry.details}</p>
                  )}
                </div>

                {/* Amount + timestamp + user */}
                <div className="text-right flex-shrink-0 min-w-[70px]">
                  <span className={`text-sm font-black tabular-nums ${amountColor(entry.action)}`}>
                    {entry.amount != null ? `${currencySymbol}${Number(entry.amount).toFixed(2)}` : '—'}
                  </span>
                  <p className="text-[10px] text-slate-400 mt-0.5">{formatTimestamp(entry.timestamp)}</p>
                  {entry.user && (
                    <p className="text-[10px] font-bold text-slate-400 mt-0.5">{entry.user}</p>
                  )}
                </div>

                {/* Undo button */}
                {canUndo && (
                  <button
                    onClick={() => handleUndo(entry)}
                    disabled={isUndoing || undoing !== null}
                    title="Undo this action"
                    className="flex-shrink-0 p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed"
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
