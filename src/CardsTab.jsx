import React, { useEffect, useState, useMemo } from 'react';
import { CreditCard, RefreshCw, Inbox } from 'lucide-react';
import { fetchHistory, formatTxDate, ensureCardsSummarySheet } from './sheetsApi.js';

const SPEND_ACTIONS = new Set(['Added', 'Receipt Scan', 'Import', 'Updated']);

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

export function CardsTab({ sheetId, accessToken, currencySymbol = '$', cards = [] }) {
  const [entries, setEntries]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCard, setSelectedCard] = useState('all');

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      // Ensure the Cards Summary Sheet exists (no-op if already present)
      ensureCardsSummarySheet(sheetId, accessToken).catch(() => {});
      setEntries(await fetchHistory(sheetId, accessToken));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [sheetId]);

  // Only spend actions with a card set (June 2026 onwards)
  const cardEntries = useMemo(() =>
    entries.filter(e => SPEND_ACTIONS.has(e.action) && e.paymentMethod),
    [entries]
  );

  // Per-card totals
  const cardTotals = useMemo(() => {
    const map = {};
    for (const e of cardEntries) {
      const c = e.paymentMethod;
      if (!map[c]) map[c] = { total: 0, count: 0 };
      map[c].total += e.amount ?? 0;
      map[c].count += 1;
    }
    return map;
  }, [cardEntries]);

  // All cards that have at least one transaction
  const activeCards = useMemo(() =>
    [...new Set(cardEntries.map(e => e.paymentMethod))].sort(),
    [cardEntries]
  );

  const displayed = useMemo(() => {
    const list = selectedCard === 'all'
      ? cardEntries
      : cardEntries.filter(e => e.paymentMethod === selectedCard);
    return [...list].sort((a, b) => 0); // already reverse-chronological from fetchHistory
  }, [cardEntries, selectedCard]);

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CreditCard className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-black uppercase tracking-widest text-slate-800 dark:text-slate-100">
            Cards
          </h2>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="p-2 rounded-xl text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Summary chips */}
      {!loading && activeCards.length > 0 && (
        <div className="flex gap-3 flex-wrap">
          <button
            onClick={() => setSelectedCard('all')}
            className={`flex flex-col items-start px-4 py-3 rounded-2xl border transition-all text-left ${
              selectedCard === 'all'
                ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-indigo-300 dark:hover:border-indigo-600'
            }`}
          >
            <span className="text-[10px] font-black uppercase tracking-wider opacity-70">All Cards</span>
            <span className="text-lg font-black tabular-nums mt-0.5">
              {currencySymbol}{Object.values(cardTotals).reduce((s, c) => s + c.total, 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
            </span>
            <span className="text-[10px] opacity-60 mt-0.5">
              {Object.values(cardTotals).reduce((s, c) => s + c.count, 0)} transactions
            </span>
          </button>

          {activeCards.map(card => {
            const totals = cardTotals[card] || { total: 0, count: 0 };
            const active = selectedCard === card;
            return (
              <button
                key={card}
                onClick={() => setSelectedCard(active ? 'all' : card)}
                className={`flex flex-col items-start px-4 py-3 rounded-2xl border transition-all text-left max-w-[200px] ${
                  active
                    ? 'bg-indigo-600 border-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30'
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:border-indigo-300 dark:hover:border-indigo-600'
                }`}
              >
                <span className="text-[10px] font-black uppercase tracking-wider opacity-70 truncate w-full">{card}</span>
                <span className="text-lg font-black tabular-nums mt-0.5">
                  {currencySymbol}{totals.total.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}
                </span>
                <span className="text-[10px] opacity-60 mt-0.5">{totals.count} transaction{totals.count !== 1 ? 's' : ''}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-slate-100 dark:bg-slate-800 rounded-2xl animate-pulse" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && cardEntries.length === 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-16 flex flex-col items-center gap-3">
          <div className="w-12 h-12 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
            <Inbox className="w-6 h-6 text-slate-400" />
          </div>
          <p className="text-sm font-bold text-slate-500 dark:text-slate-400">No card transactions yet</p>
          <p className="text-xs text-slate-400 text-center max-w-xs">
            Transactions with a payment method selected will appear here. Card tracking starts June 2026.
          </p>
        </div>
      )}

      {/* Transaction list */}
      {!loading && displayed.length > 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
          {displayed.map(entry => (
            <div key={entry.id} className="flex items-center gap-3 px-5 py-4 hover:bg-slate-50/50 dark:hover:bg-slate-700/30 transition-colors">

              {/* Card icon */}
              <div className="w-8 h-8 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
                <CreditCard className="w-4 h-4 text-indigo-500" />
              </div>

              {/* Vendor + category */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">
                  {entry.vendor || '—'}
                </p>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  {entry.category && (
                    <span className="text-[10px] font-bold text-slate-400 bg-slate-100 dark:bg-slate-700 px-2 py-0.5 rounded-full">
                      {entry.category}
                    </span>
                  )}
                  <span className="text-[10px] font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-0.5 rounded-full">
                    {entry.paymentMethod}
                  </span>
                </div>
              </div>

              {/* Amount + date */}
              <div className="text-right flex-shrink-0">
                <span className="text-sm font-black text-slate-900 dark:text-slate-100 tabular-nums">
                  {entry.amount != null ? `${currencySymbol}${Number(entry.amount).toFixed(2)}` : '—'}
                </span>
                <p className="text-[10px] text-slate-400 mt-0.5">
                  {entry.txDate ? formatTxDate(entry.txDate) : formatTimestamp(entry.timestamp)}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
