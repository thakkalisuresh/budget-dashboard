import React, { useEffect, useState, useMemo } from 'react';
import { Users, RefreshCw, Inbox } from 'lucide-react';
import { fetchHistory, ensurePersonSplitSheet } from './sheetsApi.js';
import { ownerForCard, ownerLabel, DEFAULT_CARD_OWNERS, DEFAULT_PEOPLE } from './cardOwners.js';

const SPEND_ACTIONS = new Set(['Added', 'Receipt Scan', 'Import', 'Updated', 'WhatsApp Receipt', 'Telegram Receipt']);

const money = (n, sym) => `${sym}${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// One person's column: total, transaction count, and a per-category breakdown.
function PersonColumn({ name, accent, data, grandMax, currencySymbol }) {
  const cats = Object.entries(data.byCategory).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-3xl p-5 space-y-4 flex-1 min-w-0"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-black truncate" style={{ color: accent }}>{name}</h3>
        <span className="text-[10px] font-bold flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
          {data.count} transaction{data.count !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="text-3xl font-black tabular-nums" style={{ color: 'var(--color-text)' }}>
        {money(data.total, currencySymbol)}
      </p>
      <div className="space-y-2">
        {cats.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No spending yet.</p>
        )}
        {cats.map(([cat, amt]) => (
          <div key={cat} className="flex items-center gap-3">
            <span className="text-[11px] font-bold w-24 flex-shrink-0 truncate" style={{ color: 'var(--color-text-muted)' }}>{cat}</span>
            <div className="flex-1 h-5 rounded-lg overflow-hidden" style={{ background: 'var(--sur-6)' }}>
              <div className="h-full rounded-lg flex items-center justify-end px-2"
                style={{ width: `${Math.max(8, (amt / grandMax) * 100)}%`, background: accent }}>
                <span className="text-[10px] font-black text-white tabular-nums">{money(amt, currencySymbol)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SplitTab({ sheetId, accessToken, currencySymbol = '$', settings = null }) {
  const [entries, setEntries]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const cardOwners = settings?.cardOwners || DEFAULT_CARD_OWNERS;
  const people     = settings?.people     || DEFAULT_PEOPLE;

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      // Build/refresh the per-month "By Person" sheet tab (no-op if unchanged)
      ensurePersonSplitSheet(sheetId, accessToken, cardOwners, people).catch(() => {});
      setEntries(await fetchHistory(sheetId, accessToken));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [sheetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Aggregate spend per person; owner derived live from each card.
  const { me, wife, unassigned } = useMemo(() => {
    const blank = () => ({ total: 0, count: 0, byCategory: {} });
    const acc = { me: blank(), wife: blank(), unassigned: blank() };
    for (const e of entries) {
      if (!SPEND_ACTIONS.has(e.action) || !e.paymentMethod) continue;
      const owner = ownerForCard(e.paymentMethod, cardOwners) || 'unassigned';
      const bucket = acc[owner];
      const amt = e.amount ?? 0;
      const cat = e.category || 'Misc';
      bucket.total += amt;
      bucket.count += 1;
      bucket.byCategory[cat] = (bucket.byCategory[cat] || 0) + amt;
    }
    return acc;
  }, [entries, cardOwners]);

  const meName   = ownerLabel('me', people);
  const wifeName = ownerLabel('wife', people);
  const combined = me.total + wife.total;
  const diff     = me.total - wife.total;
  const mePct    = combined > 0 ? (me.total / combined) * 100 : 50;
  const grandMax = Math.max(1, ...Object.values(me.byCategory), ...Object.values(wife.byCategory));

  const ME_ACCENT   = 'var(--color-accent)';
  const WIFE_ACCENT = 'oklch(62% 0.20 295)'; // violet, to contrast the accent

  return (
    <div className="space-y-5 animate-fade-in">

      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
          <h2 className="text-sm font-black uppercase tracking-widest" style={{ color: 'var(--color-text)' }}>Split</h2>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="p-2 rounded-xl transition-colors disabled:opacity-40 hover:bg-[var(--sur-5)]"
          style={{ color: 'var(--color-text-muted)' }}
        >
          <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: 'var(--sur-6)' }} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && combined === 0 && unassigned.total === 0 && (
        <div className="rounded-3xl p-16 flex flex-col items-center gap-3"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: 'var(--sur-8)' }}>
            <Inbox className="w-6 h-6" style={{ color: 'var(--color-text-muted)' }} />
          </div>
          <p className="text-sm font-bold" style={{ color: 'var(--color-text-muted)' }}>No card spending yet</p>
          <p className="text-xs text-center max-w-xs" style={{ color: 'var(--color-text-muted)' }}>
            Transactions are split by who owns the card. Assign cards to people in Settings → People.
          </p>
        </div>
      )}

      {/* Comparison + columns */}
      {!loading && (combined > 0 || unassigned.total > 0) && (
        <>
          {/* Totals comparison bar */}
          <div className="rounded-3xl p-5 space-y-3"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
            <div className="flex items-center justify-between text-xs font-black">
              <span style={{ color: ME_ACCENT }}>{meName} · {money(me.total, currencySymbol)}</span>
              <span style={{ color: WIFE_ACCENT }}>{money(wife.total, currencySymbol)} · {wifeName}</span>
            </div>
            <div className="flex h-6 rounded-lg overflow-hidden" style={{ background: 'var(--sur-6)' }}>
              <div className="h-full" style={{ width: `${mePct}%`, background: ME_ACCENT }} />
              <div className="h-full flex-1" style={{ background: WIFE_ACCENT }} />
            </div>
            <p className="text-[11px] text-center font-semibold" style={{ color: 'var(--color-text-muted)' }}>
              {diff === 0
                ? 'Even split'
                : `${diff > 0 ? meName : wifeName} spent ${money(Math.abs(diff), currencySymbol)} more`}
            </p>
          </div>

          {/* Side-by-side category breakdowns */}
          <div className="flex flex-col sm:flex-row gap-4">
            <PersonColumn name={meName}   accent={ME_ACCENT}   data={me}   grandMax={grandMax} currencySymbol={currencySymbol} />
            <PersonColumn name={wifeName} accent={WIFE_ACCENT} data={wife} grandMax={grandMax} currencySymbol={currencySymbol} />
          </div>

          {/* Unassigned note — cards with no owner (e.g. Cash) */}
          {unassigned.total > 0 && (
            <div className="rounded-2xl px-5 py-3 text-xs"
              style={{ background: 'oklch(78% 0.16 75 / 10%)', border: '1px solid oklch(78% 0.16 75 / 25%)', color: 'var(--color-warning)' }}>
              {money(unassigned.total, currencySymbol)} from {unassigned.count} unassigned transaction{unassigned.count !== 1 ? 's' : ''} (cards with no owner — assign them in Settings → People).
            </div>
          )}
        </>
      )}
    </div>
  );
}
