import React, { useMemo, useState } from 'react';
import { Plus, Upload, RefreshCw, TrendingUp, Search } from 'lucide-react';
import { useInvestData } from './useInvestData.js';
import { useQuotes } from './useQuotes.js';
import { valuePortfolio, blendedApy } from './investMath.js';
import { InvestOrbit } from './InvestOrbit.jsx';
import { InvestTape, InvestSavingsCard, InvestAccountCard, RateWatchCard, InvestEquityRows, InvestSplitDonut, ItemizeNudgeCard } from './InvestParts.jsx';
import { EditAccountDialog, AddActivityDialog, ImportCsvDialog } from './InvestDialogs.jsx';
import { CandidateCheckDialog } from './CandidateCheckDialog.jsx';
import { updateAccount, writeRateWatchDetails } from './sheetInvest.js';
import { ItemizeContributionDialog } from './ItemizeContributionDialog.jsx';
import { pendingItemizations } from './investItemize.js';
import { MfNudges } from './MfNudges.jsx';

// ════════════════════════════════════════════════════════════════════════════
// InvestTab — the approved hybrid layout: ticker tape → orbital hero →
// savings vs $250k FDIC goals → account card with ‹ › switcher → rate watch →
// Apple-Stocks-style equity rows → ETF/stock split donut. Quotes poll only
// while this tab is mounted and the app is visible.
// ════════════════════════════════════════════════════════════════════════════

export function InvestTab({ user, settings, updateSettings, settingsLoading, currencySymbol = '$', isReadOnly = false }) {
  const invest = useInvestData({ user, settings, updateSettings, settingsLoading });
  const {
    sheetId, loading, provisioning, error, refresh,
    accounts, hysaAccounts, activities, holdings, rateWatch, monthlyContribution, isEmpty,
  } = invest;

  const symbols = useMemo(() => holdings.map(h => h.symbol), [holdings]);
  const { quotes, stale: quotesStale, lastUpdated } = useQuotes(symbols, user.accessToken);

  const portfolio = useMemo(
    () => valuePortfolio(holdings, quotes, settings.investEtfSymbols || []),
    [holdings, quotes, settings.investEtfSymbols]
  );
  // Attach the raw quote to each position for the today-range sparkline.
  const positions = useMemo(
    () => portfolio.positions.map(p => ({ ...p, quote: quotes[p.symbol] || null })),
    [portfolio.positions, quotes]
  );

  // Per-account deposits this month → per-account FDIC pace.
  const hysaWithPace = useMemo(() => {
    const ym = new Date().toISOString().slice(0, 7);
    return hysaAccounts.map(a => ({
      ...a,
      monthContribution: activities
        .filter(x => x.type === 'DEPOSIT' && x.accountId === a.id && String(x.date).startsWith(ym))
        .reduce((s, x) => s + (x.amount || 0), 0),
    }));
  }, [hysaAccounts, activities]);

  const savingsTotal = hysaAccounts.reduce((s, a) => s + a.balance, 0);
  const grandTotal = savingsTotal + portfolio.total;
  const savingsPct = grandTotal > 0 ? (savingsTotal / grandTotal) * 100 : 0;
  const apyBlend = blendedApy(hysaAccounts);

  // Brokerage cash deposits still awaiting itemization (not yet bought-into, not dismissed).
  const pendingItemize = useMemo(
    () => pendingItemizations(activities, accounts, settings.itemizeDismissed || []),
    [activities, accounts, settings.itemizeDismissed]
  );

  const [editAccount, setEditAccount] = useState(null);
  const [showAddActivity, setShowAddActivity] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [itemizeTarget, setItemizeTarget] = useState(null);
  // null = closed; '' = open blank; a ticker string = open pre-filled from a row.
  const [candidateCheck, setCandidateCheck] = useState(null);

  const dismissItemize = (uuid) =>
    updateSettings(prev => ({
      ...prev,
      itemizeDismissed: [...(prev.itemizeDismissed || []), uuid],
    }));

  // Rate-watch proposals: confirming writes the new APY (+ a RateHistory row
  // tagged 'rate-watch'); either button clears the proposal off the latest
  // scan row so the nudge drops. The scan only DETECTS — the tap is consent.
  const canResolveProposal = !isReadOnly && !!sheetId && !!user?.accessToken;
  const clearProposal = async (p) => {
    const latest = rateWatch[0];
    if (!latest?.rowIndex) return;
    const remaining = (latest.proposals || []).filter(x => x.accountId !== p.accountId);
    await writeRateWatchDetails(sheetId, user.accessToken, latest.rowIndex, {
      alternatives: latest.details || [], proposals: remaining,
    });
  };
  const resolveProposal = canResolveProposal ? {
    onConfirmProposal: async (p) => {
      await updateAccount(sheetId, user.accessToken, p.accountId, { apy: p.proposedApy, rateSource: 'rate-watch' });
      await clearProposal(p);
      refresh();
    },
    onDismissProposal: async (p) => {
      await clearProposal(p);
      refresh();
    },
  } : {};

  // ── Provisioning / hard-error states ──────────────────────────────────────
  if (provisioning || (!sheetId && !error)) {
    return (
      <div className="rounded-3xl p-16 flex flex-col items-center gap-3 animate-fade-in"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
        <RefreshCw className="w-6 h-6 animate-spin" style={{ color: 'var(--color-accent-text)' }} />
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-muted)' }}>Setting up your Investments sheet…</p>
        <p className="text-xs text-center max-w-xs" style={{ color: 'var(--color-text-muted)' }}>
          One-time: creates a "Fundient Investments" spreadsheet and shares it with the household.
        </p>
      </div>
    );
  }

  if (error && !accounts.length) {
    return (
      <div className="rounded-3xl p-12 text-center animate-fade-in" style={{ background: 'var(--color-surface)', border: '1px solid oklch(62% 0.22 25 / 25%)' }}>
        <p className="text-sm font-bold" style={{ color: 'var(--color-danger)' }}>{error}</p>
        <button onClick={refresh} className="mt-4 px-5 py-2.5 rounded-2xl text-sm font-bold text-white" style={{ background: 'var(--color-accent)' }}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-in">

      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
          <h2 className="text-sm font-black uppercase tracking-widest" style={{ color: 'var(--color-text)' }}>Invest</h2>
        </div>
        <div className="flex items-center gap-2">
          {/* Check is read-only analysis → always available, even in view-only mode. */}
          <button onClick={() => setCandidateCheck('')}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
            style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}>
            <Search className="w-3.5 h-3.5" /> Check
          </button>
          {!isReadOnly && (
            <>
              <button onClick={() => setShowImport(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-colors"
                style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)', color: 'var(--color-text)' }}>
                <Upload className="w-3.5 h-3.5" /> Import
              </button>
              <button onClick={() => setShowAddActivity(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white transition-colors"
                style={{ background: 'var(--color-accent)' }}>
                <Plus className="w-3.5 h-3.5" /> Activity
              </button>
              <button onClick={refresh} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Loading skeleton (no cached data yet) */}
      {loading && !accounts.length && (
        <div className="space-y-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-28 rounded-3xl animate-pulse" style={{ background: 'var(--sur-6)' }} />
          ))}
        </div>
      )}

      {/* First-run empty state */}
      {isEmpty && !isReadOnly && (
        <div className="rounded-3xl p-10 text-center space-y-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>Let's seed your portfolio</p>
          <p className="text-xs max-w-sm mx-auto leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
            Tap a savings gauge to set its balance and APY, import your Fidelity CSV for holdings,
            or add activities one by one. From August, Investment-category expenses flow in automatically.
          </p>
          <div className="flex gap-2 justify-center">
            <button onClick={() => setShowImport(true)} className="px-4 py-2.5 rounded-2xl text-xs font-bold" style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
              Import Fidelity CSV
            </button>
            <button onClick={() => setShowAddActivity(true)} className="px-4 py-2.5 rounded-2xl text-xs font-bold text-white" style={{ background: 'var(--color-accent)' }}>
              Add activity
            </button>
          </div>
        </div>
      )}

      {/* Ticker tape */}
      <InvestTape positions={positions} blendedApyPct={apyBlend} quotesStale={quotesStale} />

      {/* Orbital hero */}
      {(savingsTotal > 0 || positions.length > 0) && (
        <InvestOrbit
          hysaAccounts={hysaAccounts}
          positions={positions}
          totalInvested={grandTotal}
          dayChange={portfolio.dayChange}
          savingsPct={savingsPct}
          currencySymbol={currencySymbol}
        />
      )}

      {/* Savings vs $250k FDIC goals */}
      {hysaAccounts.length > 0 && (
        <InvestSavingsCard
          hysaAccounts={hysaWithPace}
          monthlyContribution={monthlyContribution}
          currencySymbol={currencySymbol}
          onEditAccount={isReadOnly ? () => {} : setEditAccount}
        />
      )}

      {/* Account card with ‹ › switcher */}
      {savingsTotal > 0 && (
        <InvestAccountCard
          hysaAccounts={hysaWithPace}
          currencySymbol={currencySymbol}
          rateWatch={rateWatch}
          onEditAccount={isReadOnly ? () => {} : setEditAccount}
        />
      )}

      {/* Rate watch */}
      {hysaAccounts.length > 0 && (
        <RateWatchCard rateWatch={rateWatch} hysaAccounts={hysaAccounts} currencySymbol={currencySymbol} {...resolveProposal} />
      )}

      {/* Itemize-contribution nudge (brokerage cash awaiting buys) */}
      {!isReadOnly && (
        <ItemizeNudgeCard
          pending={pendingItemize}
          currencySymbol={currencySymbol}
          onItemize={setItemizeTarget}
          onDismiss={dismissItemize}
        />
      )}

      {/* Indian MF: transfer planner, INR-received + SIP confirm nudges */}
      <MfNudges
        sheetId={sheetId}
        accessToken={user.accessToken}
        accounts={accounts}
        activities={activities}
        settings={settings}
        updateSettings={updateSettings}
        onSaved={refresh}
        isReadOnly={isReadOnly}
      />

      {/* Equities */}
      <InvestEquityRows positions={positions} currencySymbol={currencySymbol} lastUpdated={lastUpdated} quotesStale={quotesStale} onCheck={(sym) => setCandidateCheck(sym)} />

      {/* ETF / stock split donut */}
      <InvestSplitDonut portfolio={portfolio} currencySymbol={currencySymbol} />

      {/* Dialogs */}
      {editAccount && (
        <EditAccountDialog
          account={editAccount}
          sheetId={sheetId}
          accessToken={user.accessToken}
          onClose={() => setEditAccount(null)}
          onSaved={refresh}
        />
      )}
      {showAddActivity && (
        <AddActivityDialog
          accounts={accounts}
          sheetId={sheetId}
          accessToken={user.accessToken}
          onClose={() => setShowAddActivity(false)}
          onSaved={refresh}
        />
      )}
      {showImport && (
        <ImportCsvDialog
          sheetId={sheetId}
          accessToken={user.accessToken}
          onClose={() => setShowImport(false)}
          onSaved={refresh}
        />
      )}
      {itemizeTarget && !isReadOnly && (
        <ItemizeContributionDialog
          pending={itemizeTarget}
          sheetId={sheetId}
          accessToken={user.accessToken}
          currencySymbol={currencySymbol}
          onClose={() => setItemizeTarget(null)}
          onSaved={refresh}
        />
      )}
      {candidateCheck != null && (
        <CandidateCheckDialog
          holdings={holdings}
          positions={positions}
          portfolioTotal={portfolio.total}
          quotes={quotes}
          settings={settings}
          sheetId={sheetId}
          accessToken={user.accessToken}
          prefillTicker={candidateCheck}
          onClose={() => setCandidateCheck(null)}
        />
      )}
    </div>
  );
}
