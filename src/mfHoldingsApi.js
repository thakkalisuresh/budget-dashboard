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

// ── ITI manual ingest ────────────────────────────────────────────────────────
// ITI's listing can't be fetched automatically, so the user pastes the link of
// the monthly file; the holdings service downloads and parses it.
const ITI_HOSTS = new Set(['itiamc.com', 'www.itiamc.com']);
const ITI_PATH_RE = /^\/admin\/pdf\/\d+-ITIMF_Monthly_Portfolio_(\d{2})(\d{2})(\d{4})\.xlsx$/i;

/** → { ok: true, url, asOf } | { ok: false, error }. Client-side shape check before anything is sent. */
export function validateItiUrl(input) {
  const raw = String(input ?? '').trim();
  let u;
  try { u = new URL(raw); } catch { return { ok: false, error: 'That does not look like a link. Paste the full address starting with https://itiamc.com/.' }; }
  if (u.protocol !== 'https:' || !ITI_HOSTS.has(u.hostname) || u.username || u.password || u.port || u.search || u.hash) {
    return { ok: false, error: 'The link must be an https://itiamc.com/ address.' };
  }
  const m = ITI_PATH_RE.exec(u.pathname);
  if (!m) return { ok: false, error: 'This is not a monthly portfolio file link (expected …/admin/pdf/<number>-ITIMF_Monthly_Portfolio_<DDMMYYYY>.xlsx).' };
  const [, dd, mm, yyyy] = m;
  const asOf = `${yyyy}-${mm}-${dd}`;
  if (Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) {
    return { ok: false, error: 'The date in the file name is not a valid date.' };
  }
  return { ok: true, url: u.href, asOf };
}

/**
 * POST /api/mf-holdings { action: 'ingest', house: 'iti', url } (idempotent; the file name's date must be a
 * month-end within the last 3 months, so pasting an older link backfills). Answer is JSON
 * { ok, fundKey, asOf, status: ok|stale|missing|failed, rowCount, weightSum, reason }, HTTP 200 for any run outcome.
 * Never throws: failures come back as { ok: false, error } in plain words.
 */
export async function ingestMfHoldingsUrl(url, accessToken) {
  const v = validateItiUrl(url);
  if (!v.ok) return { ok: false, error: v.error };
  if (!accessToken) return { ok: false, error: 'Sign in again to load holdings.' };
  let res;
  try {
    res = await fetch('/api/mf-holdings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ action: 'ingest', house: 'iti', url: v.url }),
    });
  } catch {
    return { ok: false, error: 'Could not reach the holdings service. Check your connection and try again.' };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.status === 404 || res.status === 405) return { ok: false, error: "The holdings service isn't deployed yet." };
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'Not allowed. Sign in again and retry (viewers cannot load holdings).' };
  if (res.status === 409) return { ok: false, error: json?.retryable ? 'A refresh is already running, try again in a minute.' : (json?.error || 'The Invest sheet is not set up yet. Open the Invest tab once and retry.') };
  if (res.status === 400) return { ok: false, error: json?.reason || json?.error || 'The holdings service rejected that link.' };
  if (!res.ok || !json) return { ok: false, error: json?.error || `The holdings service answered with an error (${res.status}).` };

  const base = { status: json.status || (json.ok ? 'ok' : 'failed'), asOf: json.asOf || v.asOf, rowCount: json.rowCount ?? null, weightSum: json.weightSum ?? null, reason: json.reason || '' };
  if (json.ok === true) return { ok: true, ...base };
  const why = base.reason ? `: ${base.reason}` : '';
  const label = { stale: 'That file is for a different month than expected', missing: 'The file was not found', failed: 'The file could not be loaded' }[base.status] || 'The file could not be loaded';
  return { ok: false, ...base, error: `${label}${why}` };
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** Month-end the monthly files should cover by `today` (they are published about the 10th). null before the 10th. */
export function expectedHoldingsMonth(today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today || '');
  if (!m || Number(m[3]) < 10) return null;
  const end = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 0)); // day 0 = last day of previous month
  return { asOf: end.toISOString().slice(0, 10), label: `${MONTH_NAMES[end.getUTCMonth()]} ${end.getUTCFullYear()}` };
}

const CACHE_MS = 10 * 60_000;
const cache = new Map(); // sheetId → { at, data }
export const _clearHoldingsCacheForTests = () => cache.clear();
export const clearHoldingsCache = (sheetId) => cache.delete(sheetId);

/** { data, loading, error }. Mock mode and a missing sheet never touch the network. */
export function useMfHoldings({ sheetId, accessToken, enabled = true }) {
  const [fetched, setFetched] = useState({ sheetId: null, data: null, error: '' });
  const [tick, setTick] = useState(0);
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
  }, [active, sheetId, accessToken, tick]);
  const refetch = () => { cache.delete(sheetId); setTick(t => t + 1); };
  if (DEV_MOCK) return { data: MOCK_MF_HOLDINGS, loading: false, error: '', refetch };
  const mine = fetched.sheetId === sheetId ? fetched : null;
  return { data: mine?.data || hit?.data || null, loading: active && !hit && !mine, error: mine?.error || '', refetch };
}
