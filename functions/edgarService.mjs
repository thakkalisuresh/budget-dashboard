// Ported from etfray (MIT) — see NOTICE
// ════════════════════════════════════════════════════════════════════════════
// edgarService.mjs — fetch + parse any ETF's real holdings from SEC EDGAR
// N-PORT filings. Library only (no HTTP handler — that is etf-holdings.mjs).
//
// WHY SERVER-SIDE: SEC EDGAR rejects requests without a descriptive
// `User-Agent`, and browsers forbid overriding that header, so the fetch has to
// live in a Cloud Function. The User-Agent is injected by the caller (from the
// EDGAR_USER_AGENT param) rather than hardcoded — see etf-holdings.mjs.
//
// Pipeline (per the SEC fair-access endpoints):
//   1. ticker → fund       https://www.sec.gov/files/company_tickers.json  (stocks +
//      standalone-trust ETFs like SPY/DIA), falling back to the Investment Company
//      Series & Class dataset for MULTI-SERIES ETFs (VOO/QQQ/VTI/… are NOT in
//      company_tickers.json) → { CIK, seriesId }.
//   2. CIK → N-PORT         https://data.sec.gov/submissions/CIK##########.json
//      — latest NPORT-P for a standalone trust; for a multi-series trust, scan
//      recent NPORT-P filings and match the resolved seriesId (early-exit).
//   3. filing → holdings    https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/primary_doc.xml
//
// IDENTITY KEYS: N-PORT identifies a holding by name + CUSIP + LEI and
// FREQUENTLY HAS NO TICKER (most equity ETFs carry only ISIN/CUSIP). So the
// normalized shape exposes BOTH `cusip` (most reliable key) and a best-effort
// `ticker` (only when the filer included a <ticker> identifier). Consumers key
// on CUSIP first, then ticker, then normalized name — see investInsights.js.
//
// Normalized shape (the contract every consumer depends on):
//   { asOf: '2026-06-30', source: 'NPORT-P', cik: '1041130', holdings: [
//     { name: 'Apple Inc', cusip: '037833100', ticker: 'AAPL', weight: 7.12 }, … ] }
//   weights are PERCENT (0–100), renormalized to sum ~100 (partial filings happen).
// ════════════════════════════════════════════════════════════════════════════
import { XMLParser } from 'fast-xml-parser';

const SEC_WWW = 'https://www.sec.gov';
const SEC_DATA = 'https://data.sec.gov';

// parseTagValue:false keeps every text node a STRING — critical because CUSIPs
// like Apple's "037833100" would otherwise be coerced to the number 37833100,
// silently dropping the leading zero and breaking the primary identity key.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });

// ── In-instance caches ───────────────────────────────────────────────────────
// The ticker→CIK map is ~800 KB and changes rarely; cache it for the life of the
// warm instance (the quarterly-filed holdings make a short TTL pointless).
const TICKER_MAP_TTL_MS = 24 * 60 * 60_000;
// Default cap on how many recent NPORT-P filings to scan when resolving a
// specific series inside a multi-series fund-family trust (Vanguard/iShares/…).
// A trust files one NPORT-P per series per quarter, newest first, so the target
// series is normally within the first ~dozen; the scan early-exits on a match.
const DEFAULT_MAX_SERIES_SCAN = 40;

let _tickerMap = null;  // { map: Map<ticker, cik10>, at }
let _seriesCsv = null;  // { map: Map<ticker, {cik10, seriesId, seriesName}>, at }

/** Reset in-instance caches (tests). */
export function _resetEdgarCache() { _tickerMap = null; _seriesCsv = null; }

function arr(x) { return x == null ? [] : Array.isArray(x) ? x : [x]; }
const pad10 = (cik) => String(cik).replace(/\D/g, '').padStart(10, '0');

function secHeaders(userAgent) {
  return { 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate' };
}

/** Quote-aware split of one CSV line into fields. */
function csvSplit(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Resolve a ticker to its zero-padded 10-digit CIK via company_tickers.json.
 * The map is cached in-instance. Throws if the ticker is unknown.
 */
export async function tickerToCik(ticker, { userAgent, fetchFn = fetch } = {}) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) throw new Error('ticker required');

  if (!_tickerMap || Date.now() - _tickerMap.at >= TICKER_MAP_TTL_MS) {
    const res = await fetchFn(`${SEC_WWW}/files/company_tickers.json`, { headers: secHeaders(userAgent) });
    if (!res.ok) throw new Error(`company_tickers.json ${res.status}`);
    const raw = await res.json();
    const map = new Map();
    for (const k in raw) {
      const e = raw[k];
      if (e && e.ticker) map.set(String(e.ticker).toUpperCase(), pad10(e.cik_str));
    }
    _tickerMap = { map, at: Date.now() };
  }

  const cik = _tickerMap.map.get(sym);
  if (!cik) throw new Error(`Unknown ticker: ${sym}`);
  return cik;
}

/**
 * Fallback ticker resolver for MULTI-SERIES fund-family ETFs (VOO, QQQ, VTI,
 * IVV, SCHD, …), which are NOT in company_tickers.json — that file only lists
 * operating companies and standalone-trust ETFs (SPY, DIA). ETF share-class
 * tickers live in SEC's Investment Company Series & Class dataset, which maps a
 * class ticker → its trust CIK + series id. Cached in-instance.
 *
 * Returns { cik10, seriesId, seriesName } or null when the ticker isn't listed
 * (or the dataset is unreachable — callers treat null as "unknown ticker").
 */
export async function fetchSeriesClass(ticker, { userAgent, fetchFn = fetch } = {}) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return null;

  if (!_seriesCsv || Date.now() - _seriesCsv.at >= TICKER_MAP_TTL_MS) {
    const year = new Date().getUTCFullYear();
    const url = (y) => `${SEC_WWW}/files/investment/data/other/investment-company-series-class-information/investment-company-series-class-${y}.csv`;
    let res = await fetchFn(url(year), { headers: secHeaders(userAgent) }).catch(() => null);
    if (!res || !res.ok) res = await fetchFn(url(year - 1), { headers: secHeaders(userAgent) }).catch(() => null);
    if (!res || !res.ok) return null; // dataset unreachable → let caller 404

    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const header = csvSplit(lines[0] || '');
    const col = (name) => header.findIndex((h) => h.toLowerCase() === name);
    const iCik = col('cik number'), iSid = col('series id'), iSName = col('series name'), iTick = col('class ticker');
    const map = new Map();
    if (iCik >= 0 && iTick >= 0) {
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const f = csvSplit(lines[i]);
        const t = (f[iTick] || '').toUpperCase();
        if (t && !map.has(t)) {
          map.set(t, { cik10: pad10(f[iCik]), seriesId: (f[iSid] || '').trim(), seriesName: (iSName >= 0 ? f[iSName] : '') || '' });
        }
      }
    }
    _seriesCsv = { map, at: Date.now() };
  }
  return _seriesCsv.map.get(sym) || null;
}

/**
 * Resolve a ticker to its fund: { cik, seriesId, seriesName }. Tries
 * company_tickers.json first (fast path, standalone-trust ETFs + stocks), then
 * the Series & Class dataset (multi-series ETFs). seriesId is '' for a
 * standalone trust; non-empty means the CIK hosts many series and the exact one
 * must be matched among its NPORT-P filings. Throws `Unknown ticker` if neither
 * source lists it.
 */
export async function resolveFund(ticker, { userAgent, fetchFn = fetch } = {}) {
  const sym = String(ticker || '').trim().toUpperCase();
  try {
    const cik = await tickerToCik(sym, { userAgent, fetchFn });
    return { cik, seriesId: '', seriesName: '' };
  } catch (e) {
    if (!/Unknown ticker/i.test(e?.message || '')) throw e;
  }
  const sc = await fetchSeriesClass(sym, { userAgent, fetchFn });
  if (sc) return { cik: sc.cik10, seriesId: sc.seriesId, seriesName: sc.seriesName };
  throw new Error(`Unknown ticker: ${sym}`);
}

/** All NPORT-P filings for a CIK, newest first: [{ accession, accessionNoDashes, filingDate }]. */
export async function listNportFilings(cik, { userAgent, fetchFn = fetch } = {}) {
  const cik10 = pad10(cik);
  const res = await fetchFn(`${SEC_DATA}/submissions/CIK${cik10}.json`, { headers: secHeaders(userAgent) });
  if (!res.ok) throw new Error(`submissions ${res.status}`);
  const sub = await res.json();
  const r = sub?.filings?.recent || {};
  const forms = r.form || [];
  const out = [];
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] === 'NPORT-P') {
      out.push({ accession: r.accessionNumber[i], accessionNoDashes: r.accessionNumber[i].replace(/-/g, ''), filingDate: r.filingDate?.[i] || '' });
    }
  }
  return out;
}

/**
 * Most recent NPORT-P filing for a CIK → { accession, accessionNoDashes, filingDate }.
 * Mirrors the brief's "pick most recent form === 'NPORT-P'". NOTE: for a
 * multi-series fund-family trust, the latest NPORT-P for the CIK may be a
 * sibling series rather than the exact ticker; a single-series ETF trust (the
 * common case) resolves exactly. Throws if the fund has no NPORT-P on file.
 */
export async function cikToLatestNport(cik, { userAgent, fetchFn = fetch } = {}) {
  const cik10 = pad10(cik);
  const res = await fetchFn(`${SEC_DATA}/submissions/CIK${cik10}.json`, { headers: secHeaders(userAgent) });
  if (!res.ok) throw new Error(`submissions ${res.status}`);
  const sub = await res.json();
  const r = sub?.filings?.recent || {};
  const forms = r.form || [];
  const idx = forms.findIndex((f) => f === 'NPORT-P');
  if (idx < 0) throw new Error(`No NPORT-P filing for CIK ${cik10}`);
  const accession = r.accessionNumber[idx];
  return { accession, accessionNoDashes: accession.replace(/-/g, ''), filingDate: r.filingDate?.[idx] || '' };
}

/** Fetch the raw primary_doc.xml for a filing. */
export async function fetchHoldingsXml(cik, accessionNoDashes, { userAgent, fetchFn = fetch } = {}) {
  const cikNum = String(parseInt(pad10(cik), 10));
  const url = `${SEC_WWW}/Archives/edgar/data/${cikNum}/${accessionNoDashes}/primary_doc.xml`;
  const res = await fetchFn(url, { headers: { 'User-Agent': userAgent, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`primary_doc.xml ${res.status}`);
  return res.text();
}

/**
 * PURE: parse an N-PORT primary_doc.xml string into the normalized shape.
 * No network — unit-tested against a saved fixture. Weights are renormalized
 * against the actual pctVal column sum (partial filings don't sum to 100).
 */
export function parseNportXml(xml) {
  const doc = parser.parse(xml);
  const sub = doc?.edgarSubmission || doc?.['nport:edgarSubmission'] || {};
  const formData = sub.formData || {};
  const genInfo = formData.genInfo || {};
  const cik = String(genInfo.regCik || sub?.headerData?.filerInfo?.filer?.issuerCredentials?.cik || '').replace(/^0+/, '') || '';
  const asOf = String(genInfo.repPdDate || '').trim();
  const seriesId = String(genInfo.seriesId || '').trim(); // '' for a standalone trust

  const secs = arr(formData.invstOrSecs?.invstOrSec);
  const raw = secs.map((s) => {
    const idents = s.identifiers || {};
    // Best-effort ticker: only present when the filer supplied a <ticker> id.
    const tickerVal = idents.ticker?.['@_value'] ?? idents.ticker?.value ?? '';
    const cusip = String(s.cusip ?? '').trim();
    const pct = Number(String(s.pctVal ?? '').trim()) || 0;
    return {
      name: String(s.name ?? s.title ?? '').trim(),
      cusip: cusip && !/^0+$/.test(cusip) ? cusip : '',
      ticker: tickerVal ? String(tickerVal).trim().toUpperCase() : '',
      pct: pct > 0 ? pct : 0,
    };
  }).filter((h) => h.name || h.cusip || h.ticker);

  const total = raw.reduce((s, h) => s + h.pct, 0);
  const holdings = raw.map((h) => ({
    name: h.name,
    cusip: h.cusip,
    ticker: h.ticker,
    weight: total > 0 ? Math.round((h.pct / total) * 100 * 1e6) / 1e6 : 0,
  }));

  return { asOf, source: 'NPORT-P', cik, seriesId, holdings };
}

/**
 * End-to-end: ticker → normalized holdings.
 *
 * `userAgent` is required (SEC fair-access). `fetchFn` is injectable for tests,
 * but tests MUST use a saved fixture — never hit data.sec.gov live.
 *
 * Standalone-trust ETFs (SPY, DIA): one CIK = one fund, so the latest NPORT-P is
 * the right filing. Multi-series trusts (VOO, QQQ, …): the CIK hosts many series,
 * so scan recent NPORT-P filings (up to `maxSeriesScan`, newest first) and pick
 * the one whose genInfo.seriesId matches the resolved series — early-exiting on
 * the match. Each scanned filing is one primary_doc.xml fetch; the endpoint's
 * 24h cache makes this a rare cost.
 */
export async function getEtfHoldings(ticker, { userAgent, fetchFn = fetch, maxSeriesScan = DEFAULT_MAX_SERIES_SCAN } = {}) {
  if (!userAgent) throw new Error('userAgent required (SEC fair-access policy)');
  const sym = String(ticker || '').toUpperCase();
  const { cik, seriesId } = await resolveFund(sym, { userAgent, fetchFn });

  let parsed;
  if (!seriesId) {
    // Standalone trust — latest NPORT-P is the fund.
    const { accessionNoDashes } = await cikToLatestNport(cik, { userAgent, fetchFn });
    const xml = await fetchHoldingsXml(cik, accessionNoDashes, { userAgent, fetchFn });
    parsed = parseNportXml(xml);
  } else {
    // Multi-series trust — find the filing for THIS series.
    const filings = await listNportFilings(cik, { userAgent, fetchFn });
    for (const f of filings.slice(0, maxSeriesScan)) {
      const p = parseNportXml(await fetchHoldingsXml(cik, f.accessionNoDashes, { userAgent, fetchFn }));
      if (p.seriesId === seriesId) { parsed = p; break; }
    }
    if (!parsed) throw new Error(`No NPORT-P filing for series ${seriesId} (CIK ${pad10(cik)}) within ${maxSeriesScan} recent filings`);
  }

  return { ...parsed, ticker: sym, cik: parsed.cik || String(parseInt(cik, 10)) };
}
