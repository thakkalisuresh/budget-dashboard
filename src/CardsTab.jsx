import React, { useEffect, useState, useMemo } from 'react';
import { CreditCard, RefreshCw, Inbox, Award, TrendingUp } from 'lucide-react';
import { fetchHistory, formatTxDate, ensureCardsSummarySheet, CATEGORIES } from './sheetsApi.js';
import {
  calculateRewards, rewardsDollarValue, bestCardTable, cardEarnsRewards,
  resolveMCC, getEffectiveRates, UR_POINT_VALUE_CSR, UR_POINT_VALUE_CFU,
} from './cardRewards.js';

const SPEND_ACTIONS = new Set(['Added', 'Receipt Scan', 'Import', 'Updated', 'WhatsApp Receipt', 'Telegram Receipt']);
const AMEX = 'American Express Blue Cash Preferred';

function formatTimestamp(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return iso; }
}

// 'YYYY-MM-DD' or ISO timestamp → 'Jun 2026'
function monthKeyOf(entry) {
  const src = entry.txDate || entry.timestamp;
  if (!src) return 'Unknown';
  const d = new Date(entry.txDate ? entry.txDate + 'T00:00:00' : entry.timestamp);
  if (isNaN(d)) return 'Unknown';
  return d.toLocaleString('en-US', { month: 'short', year: 'numeric' });
}

export function CardsTab({ sheetId, accessToken, currencySymbol = '$', cards = [], settings = null }) {
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

  const rates = useMemo(() => getEffectiveRates(settings), [settings]);

  // Rewards: process oldest-first so the Amex grocery cap accumulates correctly
  const rewards = useMemo(() => {
    const chrono = [...cardEntries].reverse();
    let urPoints = 0, cashBack = 0; // UR (CSR+CFU) and cash ($ Amex+Quicksilver) — kept separate
    let amexGroceryYtd = 0;         // qualifying supermarket spend (MCCs 5411/5422) for the $6k cap
    const monthly = {};             // 'Jun 2026' → estimated $ value
    const perCard = {};             // card → { points, cash, type }

    for (const e of chrono) {
      const card = e.paymentMethod;
      if (!cardEarnsRewards(card, rates)) continue;
      const cat = e.category || 'Misc';
      const amt = e.amount ?? 0;
      const mcc = resolveMCC(e.vendor, cat);
      // Only Amex supermarket MCCs contribute to the $6k annual cap
      const qualifiesAmexCap = card === AMEX && (mcc === '5411' || mcc === '5422');
      const r = calculateRewards(card, mcc, amt, qualifiesAmexCap ? amexGroceryYtd : 0, 'portal', rates);
      if (qualifiesAmexCap) amexGroceryYtd += amt;

      if (!perCard[card]) perCard[card] = { points: 0, cash: 0, type: r.type };
      if (r.type === 'points')        { urPoints += r.value; perCard[card].points += r.value; }
      else if (r.type === 'cashback') { cashBack += r.value; perCard[card].cash  += r.value; }

      const mk = monthKeyOf(e);
      monthly[mk] = (monthly[mk] || 0) + rewardsDollarValue(card, r, rates);
    }

    const monthlyList = Object.entries(monthly)
      .map(([month, value]) => ({ month, value }))
      .sort((a, b) => new Date('1 ' + a.month) - new Date('1 ' + b.month));

    return { urPoints, cashBack, amexGroceryYtd, monthlyList, perCard };
  }, [cardEntries, rates]);

  const hasRewards = rewards.urPoints > 0 || rewards.cashBack > 0;
  const maxMonthly = Math.max(1, ...rewards.monthlyList.map(m => m.value));
  const bestTable  = useMemo(() => bestCardTable(CATEGORIES, rates), [rates]);

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

      {/* Rewards earned to date */}
      {!loading && hasRewards && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-500" />
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">Rewards Earned</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {/* UR points */}
            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl p-4">
              <p className="text-[10px] font-black uppercase tracking-wider text-indigo-400">Chase UR Points</p>
              <p className="text-2xl font-black text-indigo-700 dark:text-indigo-300 tabular-nums mt-1">
                {Math.round(rewards.urPoints).toLocaleString()}
              </p>
              <p className="text-[10px] text-slate-400 mt-1">
                ≈ {currencySymbol}{(rewards.urPoints * UR_POINT_VALUE_CFU).toFixed(0)}–{(rewards.urPoints * UR_POINT_VALUE_CSR).toFixed(0)} (1–1.5¢/pt)
              </p>
            </div>
            {/* Cash back */}
            <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl p-4">
              <p className="text-[10px] font-black uppercase tracking-wider text-emerald-500">Cash Back</p>
              <p className="text-2xl font-black text-emerald-700 dark:text-emerald-300 tabular-nums mt-1">
                {currencySymbol}{rewards.cashBack.toFixed(2)}
              </p>
              <p className="text-[10px] text-slate-400 mt-1">Amex + Quicksilver</p>
            </div>
          </div>

          {/* Per-card cash-back breakdown */}
          {Object.entries(rewards.perCard).filter(([, v]) => v.cash > 0).length > 0 && (
            <div className="space-y-1.5">
              {Object.entries(rewards.perCard)
                .filter(([, v]) => v.cash > 0)
                .sort((a, b) => b[1].cash - a[1].cash)
                .map(([card, v]) => (
                  <div key={card} className="flex items-center justify-between text-xs">
                    <span className="text-slate-500 dark:text-slate-400 truncate">{card}</span>
                    <span className="font-bold text-slate-700 dark:text-slate-200 tabular-nums">{currencySymbol}{v.cash.toFixed(2)}</span>
                  </div>
                ))}
            </div>
          )}

          {/* Amex grocery cap indicator */}
          {rewards.amexGroceryYtd > 0 && (
            <div className="pt-1">
              <div className="flex items-center justify-between text-[10px] font-bold text-slate-400 mb-1">
                <span>Amex grocery 6% cap (yearly)</span>
                <span>{currencySymbol}{Math.round(rewards.amexGroceryYtd).toLocaleString()} / {currencySymbol}6,000</span>
              </div>
              <div className="h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${rewards.amexGroceryYtd >= 6000 ? 'bg-rose-400' : 'bg-emerald-400'}`}
                  style={{ width: `${Math.min(100, (rewards.amexGroceryYtd / 6000) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Monthly rewards trend */}
      {!loading && rewards.monthlyList.length > 0 && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-indigo-500" />
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">Monthly Rewards Value</h3>
          </div>
          <div className="space-y-2">
            {rewards.monthlyList.map(({ month, value }) => (
              <div key={month} className="flex items-center gap-3">
                <span className="text-[10px] font-bold text-slate-400 w-16 flex-shrink-0">{month}</span>
                <div className="flex-1 h-5 bg-slate-50 dark:bg-slate-700/40 rounded-lg overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-indigo-400 to-indigo-500 rounded-lg flex items-center justify-end px-2"
                    style={{ width: `${Math.max(8, (value / maxMonthly) * 100)}%` }}
                  >
                    <span className="text-[10px] font-black text-white tabular-nums">{currencySymbol}{value.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-400">Estimated value — points at 1.5¢ (CSR) / 1¢ (CFU), cash back as-is.</p>
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

      {/* Best card per category — always visible, static recommendation */}
      {!loading && (
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Award className="w-4 h-4 text-amber-500" />
            <h3 className="text-xs font-black uppercase tracking-widest text-slate-700 dark:text-slate-200">Best Card per Category</h3>
          </div>
          <div className="divide-y divide-slate-50 dark:divide-slate-700/50">
            {bestTable.map(({ category, card, label }) => (
              <div key={category} className="flex items-center justify-between gap-3 py-2">
                <span className="text-xs font-bold text-slate-600 dark:text-slate-300 flex-shrink-0 w-24">{category}</span>
                <span className="text-xs text-slate-700 dark:text-slate-200 font-semibold truncate flex-1 text-right">{card}</span>
                <span className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap">{label}</span>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-slate-400">Points compared at 1.5¢ (CSR) / 1¢ (CFU) to rank against cash-back cards. Note: Amex's 6% groceries excludes warehouse clubs &amp; superstores (Costco, Walmart, Target) — those earn 1%.</p>
        </div>
      )}
    </div>
  );
}
