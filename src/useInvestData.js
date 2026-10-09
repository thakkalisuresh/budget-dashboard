// ════════════════════════════════════════════════════════════════════════════
// useInvestData.js — the Invest tab's data spine. Provisions the Investments
// spreadsheet on first use, then loads accounts + activities + rate-watch log
// with a warm-start localStorage cache (same pattern as the Ledger tab) so the
// tab paints instantly on reopen while a background refresh runs.
// ════════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ensureInvestSheet, ensureRateHistoryTab, ensureInvestMf, fetchAccounts, fetchActivities, fetchRateWatch,
} from './sheetInvest.js';
import { deriveHoldings, monthlyDeposits } from './investMath.js';
import { MOCK_INVEST } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

const CACHE_MS = 2 * 60 * 1000;                     // in-memory freshness
const LOCAL_MAX_AGE_MS = 60 * 60 * 1000;            // SEC-05 convention: 1h cap
export const investCache = new Map();               // sheetId → { data, fetchedAt }
const cacheKey = (sheetId) => `budget_invest_cache_${sheetId}`;

function loadLocalCache(sheetId) {
  try {
    const raw = localStorage.getItem(cacheKey(sheetId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data || Date.now() - parsed.fetchedAt > LOCAL_MAX_AGE_MS) return null;
    return parsed;
  } catch { return null; }
}

export function useInvestData({ user, settings, updateSettings, settingsLoading }) {
  const [data, setData] = useState(() => (DEV_MOCK ? MOCK_INVEST : null)); // { accounts, activities, rateWatch }
  const [loading, setLoading] = useState(!DEV_MOCK);
  const [provisioning, setProvisioning] = useState(false);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const provisionOnce = useRef(false);
  const ensuredHistoryFor = useRef(null);
  const ensuredMfFor = useRef(null);

  const sheetId = DEV_MOCK ? 'mock-invest' : (settings.investSheetId || null);
  const refresh = useCallback(() => setTick(t => t + 1), []);

  // ── Provision the spreadsheet on first ever open ──────────────────────────
  useEffect(() => {
    if (DEV_MOCK) return;
    if (settingsLoading || sheetId || provisionOnce.current) return;
    if (!user?.accessToken) return;
    provisionOnce.current = true;
    setProvisioning(true);
    ensureInvestSheet({
      settings, updateSettings,
      accessToken: user.accessToken,
      allowedEmails: user.allowedEmails || [],
    })
      .catch(e => setError(e.message || 'Could not create the Investments sheet.'))
      .finally(() => setProvisioning(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoading, sheetId, user?.accessToken]);

  // ── Load (warm-start → background refresh) ────────────────────────────────
  useEffect(() => {
    if (DEV_MOCK) return;
    if (!sheetId || !user?.accessToken) return;
    let cancelled = false;

    // Self-heal sheets provisioned before RateHistory shipped: idempotent, once
    // per sheet per session, fire-and-forget (a missing tab must not block load).
    if (ensuredHistoryFor.current !== sheetId) {
      ensuredHistoryFor.current = sheetId;
      ensureRateHistoryTab(sheetId, user.accessToken).catch(() => {});
    }

    // Upgrade older sheets to the Indian-MF schema (tabs, columns, seed rows)
    // BEFORE the first fetch so the new ranges resolve; failure is non-fatal.
    const upgrade = ensuredMfFor.current === sheetId
      ? Promise.resolve()
      : ensureInvestMf(sheetId, user.accessToken)
          .then(() => { ensuredMfFor.current = sheetId; })
          .catch(e => console.warn('MF schema upgrade failed (non-fatal):', e?.message));

    const mem = investCache.get(sheetId);
    if (mem && Date.now() - mem.fetchedAt < CACHE_MS && tick === 0) {
      setData(mem.data);
      setLoading(false);
      return;
    }
    const local = loadLocalCache(sheetId);
    if (local && !data) {
      setData(local.data);
      setLoading(false);
    }

    (async () => {
      try {
        await upgrade;
        const [accounts, activities, rateWatch] = await Promise.all([
          fetchAccounts(sheetId, user.accessToken),
          fetchActivities(sheetId, user.accessToken),
          fetchRateWatch(sheetId, user.accessToken).catch(() => []),
        ]);
        if (cancelled) return;
        const fresh = { accounts, activities, rateWatch };
        const fetchedAt = Date.now();
        investCache.set(sheetId, { data: fresh, fetchedAt });
        try { localStorage.setItem(cacheKey(sheetId), JSON.stringify({ data: fresh, fetchedAt })); } catch { /* quota */ }
        setData(fresh);
        setError('');
      } catch (e) {
        if (!cancelled && !data) setError(e.message || 'Failed to load investments.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId, user?.accessToken, tick]);

  // ── Derivations ───────────────────────────────────────────────────────────
  const accounts = data?.accounts || [];
  const activities = data?.activities || [];
  const rateWatch = data?.rateWatch || [];

  const hysaAccounts = useMemo(() => accounts.filter(a => a.type === 'hysa'), [accounts]);
  const brokerageIds = useMemo(
    () => new Set(accounts.filter(a => a.type === 'brokerage').map(a => a.id)),
    [accounts]
  );
  const holdings = useMemo(
    () => deriveHoldings(activities.filter(a => brokerageIds.has(a.accountId))),
    [activities, brokerageIds]
  );
  // This month's USD DEPOSIT flow into any account (feeds "on pace" projections).
  // mf_in USD deposits count; INR_RECEIVED / INR-denominated rows never do.
  const monthlyContribution = useMemo(
    () => monthlyDeposits(activities, new Date().toISOString().slice(0, 7)),
    [activities]
  );

  const isEmpty = !loading && accounts.every(a => !(a.balance > 0)) && activities.length === 0;

  return {
    sheetId, loading, provisioning, error, refresh,
    accounts, hysaAccounts, activities, holdings, rateWatch,
    monthlyContribution, isEmpty,
  };
}
