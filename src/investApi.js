// ════════════════════════════════════════════════════════════════════════════
// investApi.js — one-shot client fetchers for the Candidate Check dialog (NOT a
// polling hook like useQuotes). ETF look-through is cache-first (EtfHoldings tab,
// quarterly-fresh) then /api/etf-holdings; market factors hit /api/quotes with
// the kind the dialog needs; CUSIP↔ticker reconciliation layers a cache-derived
// map, the durable CusipMap tab, and the OpenFIGI proxy (bounded).
// ════════════════════════════════════════════════════════════════════════════
import {
  readEtfHoldings, writeEtfHoldings, isHoldingsFresh, ensureInvestTabs,
  readCusipMap, writeCusipMap,
} from './sheetInvest.js';
import { buildCusipTickerMap } from './investInsights.js';

const CUSIP_RE = /^[0-9A-Z]{9}$/;

/** POST /api/quotes for one kind. Returns the per-symbol data object (or {}). */
export async function fetchQuoteKind(kind, symbols, accessToken) {
  const list = [...new Set((symbols || []).map((s) => String(s || '').trim().toUpperCase()))].filter(Boolean);
  if (!list.length || !accessToken) return {};
  try {
    const res = await fetch('/api/quotes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ symbols: list, kind }),
    });
    if (!res.ok) return {};
    const json = await res.json();
    return json.data || {};
  } catch {
    return {};
  }
}

/** Market factors for one symbol: { quote, metric, recommendation } (any may be null). */
export async function fetchMarketFactors(symbol, accessToken) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym || !accessToken) return { quote: null, metric: null, recommendation: null };
  const [q, m, r] = await Promise.all([
    fetchQuoteKind('quote', [sym], accessToken),
    fetchQuoteKind('metric', [sym], accessToken),
    fetchQuoteKind('recommendation', [sym], accessToken),
  ]);
  return { quote: q[sym] ?? null, metric: m[sym] ?? null, recommendation: r[sym] ?? null };
}

/**
 * Look-through holdings for an ETF ticker, cache-first. Returns the normalized
 * shape { ticker, asOf, source, holdings:[{name,cusip,ticker,weight}] }. Throws
 * with a readable message when the ticker has no N-PORT filing.
 */
export async function fetchEtfHoldings(sheetId, accessToken, ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (sheetId) {
    try {
      const cached = await readEtfHoldings(sheetId, accessToken, sym);
      if (cached && cached.holdings?.length && isHoldingsFresh(cached.asOf)) return cached;
    } catch { /* fall through to network */ }
  }
  const res = await fetch(`/api/etf-holdings?ticker=${encodeURIComponent(sym)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Holdings lookup failed (${res.status})`);
  }
  const data = await res.json();
  if (sheetId && data.holdings?.length) {
    try {
      await ensureInvestTabs(sheetId, accessToken);
      await writeEtfHoldings(sheetId, accessToken, sym, { asOf: data.asOf, holdings: data.holdings });
    } catch { /* cache write is best-effort */ }
  }
  return data;
}

/**
 * Build the CUSIP→ticker reconciliation map (two tiers, cheap first):
 *   1. cache-derived — from the holdings sets already in hand (megacaps carry a
 *      best-effort ticker beside the CUSIP), plus the durable CusipMap sheet.
 *   2. OpenFIGI proxy — for still-unmapped `wantedCusips`, bounded to `maxResolve`;
 *      new resolutions are persisted to CusipMap so a CUSIP is resolved once.
 * Degrades gracefully end-to-end: any failure just leaves CUSIPs unmapped, so
 * overlap/concentration fall back to PR1's CUSIP keys (understated, never wrong).
 *
 * @param {object} args
 * @param {Array}  args.cacheRows      holdings objects ({cusip,ticker|holdingTicker})
 * @param {Array}  args.wantedCusips   CUSIPs worth resolving via the proxy
 */
export async function resolveCusipTickers({
  sheetId, accessToken, cacheRows = [], wantedCusips = [], useProxy = true, maxResolve = 50,
} = {}) {
  const map = buildCusipTickerMap(cacheRows); // tier 1a
  if (sheetId) {
    try {
      const stored = await readCusipMap(sheetId, accessToken); // tier 1b (durable)
      for (const [c, t] of Object.entries(stored)) if (!map.has(c)) map.set(c, t);
    } catch { /* tier 1a still stands */ }
  }
  if (!useProxy || !accessToken) return map;

  const unresolved = [...new Set((wantedCusips || []).map((c) => String(c || '').trim().toUpperCase()))]
    .filter((c) => CUSIP_RE.test(c) && !map.has(c))
    .slice(0, maxResolve);
  if (!unresolved.length) return map;

  let data = {};
  try {
    const res = await fetch('/api/openfigi', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ cusips: unresolved }),
    });
    if (res.ok) data = (await res.json()).data || {};
  } catch { /* leave unresolved */ }

  const newEntries = [];
  for (const [c, t] of Object.entries(data)) {
    if (t) { map.set(c, String(t).toUpperCase()); newEntries.push({ cusip: c, ticker: t, source: 'openfigi' }); }
  }
  if (sheetId && newEntries.length) {
    try { await writeCusipMap(sheetId, accessToken, newEntries); } catch { /* best-effort */ }
  }
  return map;
}
