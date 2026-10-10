// ════════════════════════════════════════════════════════════════════════════
// mfHoldingsApi.js — reads the Invest-sheet tabs `MfHoldings` and
// `MfHoldingsStatus` (written by the holdings pipeline, never by the app).
// A missing or empty tab is a normal state ("no holdings yet"), not an error.
// Column lists are the contract with the pipeline; mfHoldingsApi.test.js pins them.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { apiFetch as rawApiFetch } from './sheetApi.js';
import { withRetry429 } from './sheetInvest.js';
import { MOCK_MF_HOLDINGS } from './mockMfHoldings.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

export const MF_HOLDINGS_COLUMNS = ['asOf', 'fundKey', 'isin', 'name', 'industry', 'assetClass', 'weightPct', 'marketValueInrLakh', 'sourceFile'];
export const MF_HOLDINGS_STATUS_COLUMNS = ['fundKey', 'asOf', 'status', 'checkedAt', 'rowCount', 'weightSum', 'reason', 'sourceFile'];

const ASSET_CLASSES = new Set(['equity', 'debt', 'cash', 'derivative', 'other']);
const STATUSES = new Set(['ok', 'stale', 'failed', 'missing']);
const EMPTY = { rows: [], statusByFund: {}, asOfByFund: {}, missing: true };

/** Sheets date serial (UNFORMATTED_VALUE on a date cell) or text → 'YYYY-MM-DD' ('' if unreadable). */
export function toIsoDate(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? '').trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

const text = (v) => String(v ?? '').trim();
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

export function parseHoldingsRows(values) {
  const rows = [];
  for (const r of values || []) {
    const asOf = toIsoDate(r[0]);
    const fundKey = text(r[1]);
    const weightPct = numOrNull(r[6]);
    if (!asOf || !fundKey || weightPct == null) continue;
    const assetClass = text(r[5]).toLowerCase();
    rows.push({
      asOf, fundKey, isin: text(r[2]).toUpperCase(), name: text(r[3]), industry: text(r[4]),
      assetClass: ASSET_CLASSES.has(assetClass) ? assetClass : 'other',
      weightPct, marketValueInrLakh: numOrNull(r[7]), sourceFile: text(r[8]),
    });
  }
  return rows;
}

export function parseStatusRows(values) {
  const out = {};
  for (const r of values || []) {
    const fundKey = text(r[0]);
    if (!fundKey) continue;
    const status = text(r[2]).toLowerCase();
    out[fundKey] = {
      fundKey, asOf: toIsoDate(r[1]), status: STATUSES.has(status) ? status : 'missing', checkedAt: text(r[3]),
      rowCount: numOrNull(r[4]), weightSum: numOrNull(r[5]), reason: text(r[6]), sourceFile: text(r[7]),
    };
  }
  return out;
}

async function readTab(sheetId, accessToken, tab, lastCol, lastRow) {
  const range = encodeURIComponent(`'${tab}'!A2:${lastCol}${lastRow}`);
  try {
    const json = await withRetry429(() => rawApiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }));
    return json.values || [];
  } catch (e) {
    if (e?.code === 'AUTH-005') throw e;  // a real sign-in problem is not "no holdings yet"
    return [];                            // tab absent (Sheets answers 400) or unreadable
  }
}

/** → { rows, statusByFund, asOfByFund, missing }. Never throws for an absent tab. */
export async function fetchMfHoldings(sheetId, accessToken) {
  if (!sheetId || !accessToken) return { ...EMPTY };
  const [hv, sv] = await Promise.all([
    readTab(sheetId, accessToken, 'MfHoldings', 'I', 5000),
    readTab(sheetId, accessToken, 'MfHoldingsStatus', 'H', 50),
  ]);
  const rows = parseHoldingsRows(hv);
  const statusByFund = parseStatusRows(sv);
  const asOfByFund = {};
  for (const r of rows) if (!asOfByFund[r.fundKey] || r.asOf > asOfByFund[r.fundKey]) asOfByFund[r.fundKey] = r.asOf;
  return { rows, statusByFund, asOfByFund, missing: rows.length === 0 };
}

const CACHE_MS = 10 * 60_000;
const cache = new Map(); // sheetId → { at, data }
export const _clearHoldingsCacheForTests = () => cache.clear();

/** { data, loading, error }. Mock mode and a missing sheet never touch the network. */
export function useMfHoldings({ sheetId, accessToken, enabled = true }) {
  const [fetched, setFetched] = useState({ sheetId: null, data: null, error: '' });
  const hit = cache.get(sheetId); // shown while a stale entry refreshes
  const active = !DEV_MOCK && enabled && !!sheetId && !!accessToken;
  useEffect(() => {
    if (!active) return undefined;
    const cached = cache.get(sheetId);
    if (cached && Date.now() - cached.at < CACHE_MS) return undefined;
    let alive = true;
    fetchMfHoldings(sheetId, accessToken)
      .then((data) => { cache.set(sheetId, { at: Date.now(), data }); if (alive) setFetched({ sheetId, data, error: '' }); })
      .catch((e) => { if (alive) setFetched({ sheetId, data: null, error: e?.message || 'Could not read holdings' }); });
    return () => { alive = false; };
  }, [active, sheetId, accessToken]);
  if (DEV_MOCK) return { data: MOCK_MF_HOLDINGS, loading: false, error: '' };
  const mine = fetched.sheetId === sheetId ? fetched : null;
  return { data: mine?.data || hit?.data || null, loading: active && !hit && !mine, error: mine?.error || '' };
}
