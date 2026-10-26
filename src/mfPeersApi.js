// ════════════════════════════════════════════════════════════════════════════
// mfPeersApi.js — reads the Invest-sheet tabs `MfPeersConfig`, `MfPeers`, `MfTer`
// and `MfPeersRun` (written by the peer-data job, never by the app). Columns are
// mapped by HEADER NAME from row 1, so the job may reorder or append columns.
// A missing or empty tab is a normal state ("peer data is not available yet").
// Never reads MfPeersSeries (the job's own working tab).
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from 'react';
import { apiFetch as rawApiFetch } from './sheetApi.js';
import { withRetry429 } from './sheetInvest.js';
import { rowsByHeader, parseConfigRows, parsePeerRows, parseTerRows, parseRunRows } from './mfPeers.js';
import { MOCK_MF_PEERS } from './mockMfPeers.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

const EMPTY = { config: [], peerRows: [], terRows: [], run: {}, missing: true };

async function readTab(sheetId, accessToken, tab, lastCol, lastRow) {
  const range = encodeURIComponent(`'${tab}'!A1:${lastCol}${lastRow}`);
  try {
    const json = await withRetry429(() => rawApiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }));
    return json.values || [];
  } catch (e) {
    if (e?.code === 'AUTH-005') throw e;  // a real sign-in problem is not "no peer data yet"
    return [];                            // tab absent (Sheets answers 400) or unreadable
  }
}

/** → { config, peerRows, terRows, run, missing }. Never throws for an absent tab. */
export async function fetchMfPeers(sheetId, accessToken) {
  if (!sheetId || !accessToken) return { ...EMPTY };
  const [cv, pv, tv, rv] = await Promise.all([
    readTab(sheetId, accessToken, 'MfPeersConfig', 'M', 200),
    readTab(sheetId, accessToken, 'MfPeers', 'AB', 1000),
    readTab(sheetId, accessToken, 'MfTer', 'H', 1000),
    readTab(sheetId, accessToken, 'MfPeersRun', 'H', 20),
  ]);
  const config = parseConfigRows(rowsByHeader(cv));
  const peerRows = parsePeerRows(rowsByHeader(pv));
  const terRows = parseTerRows(rowsByHeader(tv));
  const run = parseRunRows(rowsByHeader(rv));
  return { config, peerRows, terRows, run, missing: config.length === 0 || peerRows.length === 0 };
}

const CACHE_MS = 10 * 60_000;
const cache = new Map(); // sheetId → { at, data }
export const _clearPeersCacheForTests = () => cache.clear();
export const clearPeersCache = (sheetId) => cache.delete(sheetId);

/** { data, loading, error }. Mock mode and a missing sheet never touch the network. */
export function useMfPeers({ sheetId, accessToken, enabled = true }) {
  const [fetched, setFetched] = useState({ sheetId: null, data: null, error: '' });
  const hit = cache.get(sheetId); // shown while a stale entry refreshes
  const active = !DEV_MOCK && enabled && !!sheetId && !!accessToken;
  useEffect(() => {
    if (!active) return undefined;
    const cached = cache.get(sheetId);
    if (cached && Date.now() - cached.at < CACHE_MS) return undefined;
    let alive = true;
    fetchMfPeers(sheetId, accessToken)
      .then((data) => { cache.set(sheetId, { at: Date.now(), data }); if (alive) setFetched({ sheetId, data, error: '' }); })
      .catch((e) => { if (alive) setFetched({ sheetId, data: null, error: e?.message || 'Could not read peer data' }); });
    return () => { alive = false; };
  }, [active, sheetId, accessToken]);
  if (DEV_MOCK) return { data: MOCK_MF_PEERS, loading: false, error: '' };
  const mine = fetched.sheetId === sheetId ? fetched : null;
  return { data: mine?.data || hit?.data || null, loading: active && !hit && !mine, error: mine?.error || '' };
}
