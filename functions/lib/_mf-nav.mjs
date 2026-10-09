/**
 * Indian mutual-fund NAV data layer for /api/mf-nav (functions/mf-nav.mjs).
 *
 *  - AMFI's official daily file (NAVAll.txt) → parsed once, cached for hours,
 *    shared in-flight so a cold start downloads it exactly once.
 *  - Scheme search over that list (Direct/Regular × Growth/IDCW inferred).
 *  - Historical NAVs: mfapi.in (free, unofficial) first; AMFI's own
 *    history report as a short-window fallback.
 * Files in lib/ are shared modules, not standalone deployed functions.
 */

const NAVALL_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
const MFAPI_URL = 'https://api.mfapi.in/mf';
const AMFI_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx';

const LIST_TTL_MS = 6 * 60 * 60_000;
const REFRESH_BACKOFF_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const MFAPI_TIMEOUT_MS = 15_000;
const AMFI_HISTORY_MAX_DAYS = 7;
export const MAX_SEARCH_RESULTS = 50;
export const MAX_RANGE_DAYS = 366;
export const HISTORY_LOOKBACK_DAYS = 10;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── Date helpers (all UTC; dates are calendar days, not instants) ───────────
export function isValidIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** 09-Oct-2026 → 2026-10-09 (null if unparseable). */
function amfiDateToIso(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec((s || '').trim());
  if (!m) return null;
  const mi = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/** 2026-10-09 → 09-Oct-2026 */
function isoToAmfiDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

/** 30-09-2026 → 2026-09-30 (mfapi.in). */
function mfapiDateToIso(s) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s || '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// ── NAVAll.txt parsing ──────────────────────────────────────────────────────
function inferPlan(planCol, name) {
  const t = `${planCol || ''}`;
  if (/direct/i.test(t)) return 'direct';
  if (/regular/i.test(t)) return 'regular';
  if (/\bdirect\b/i.test(name)) return 'direct';
  if (/\bregular\b/i.test(name)) return 'regular';
  return null;
}

function inferOption(optionCol, name) {
  // The Option column is authoritative; names like "Dividend Yield Fund" would
  // misfire, so the name is only consulted when the column is blank.
  const t = (optionCol || '').trim() || name;
  if (/idcw|dividend|income distribution|payout|reinvest/i.test(t)) return 'idcw';
  if (/growth/i.test(t)) return 'growth';
  return 'other';
}

/** Parse AMFI's semicolon file into [{ code, name, amc, plan, option, openEnded, nav, date }]. */
export function parseNavAll(text) {
  const out = [];
  let amc = '';
  let openEnded = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.includes(';')) {
      // Section lines: "Open Ended Schemes(...)" or an AMC name.
      if (/^(open|close|interval)\s*ended/i.test(line)) openEnded = /^open/i.test(line);
      else amc = line;
      continue;
    }
    const p = line.split(';');
    if (p.length < 8 || !/^\d+$/.test(p[0].trim())) continue; // header row / junk
    const nav = parseFloat(p[6]);
    const name = p[3].trim();
    out.push({
      code: p[0].trim(),
      name,
      amc,
      plan: inferPlan(p[4], name),
      option: inferOption(p[5], name),
      openEnded,
      nav: Number.isFinite(nav) && nav > 0 ? nav : null, // "N.A." → null
      date: amfiDateToIso(p[7]),
    });
  }
  return out;
}

// ── Scheme list cache (per instance) ────────────────────────────────────────
let state = { data: null, at: 0, failedAt: 0, inflight: null };
let loadWaitMs = 25_000;

export function _resetForTests() { state = { data: null, at: 0, failedAt: 0, inflight: null }; loadWaitMs = 25_000; }
export function _expireForTests() { state.at = 0; state.failedAt = 0; }
export function _setLoadWaitMs(ms) { loadWaitMs = ms; }

export class MfLoadingError extends Error {}

async function download() {
  const res = await fetch(NAVALL_URL, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`AMFI NAVAll failed: ${res.status}`);
  const list = parseNavAll(await res.text());
  if (!list.length) throw new Error('AMFI NAVAll parsed empty');
  return { list, byCode: new Map(list.map(s => [s.code, s])) };
}

function startRefresh() {
  if (state.inflight) return state.inflight;
  const p = (async () => {
    try {
      const data = await download();
      state.data = data;
      state.at = Date.now();
      state.failedAt = 0;
    } catch (e) {
      state.failedAt = Date.now();
      throw e;
    } finally {
      state.inflight = null;
    }
  })();
  p.catch(() => {}); // a caller that timed out must not leave an unhandled rejection
  state.inflight = p;
  return p;
}

function withTimeout(p, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new MfLoadingError('still loading')), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

/**
 * → { list, byCode, stale }. Throws MfLoadingError when nothing is cached and
 * the first download is still running / has failed (caller answers 503 retryable).
 */
export async function getSchemes() {
  const fresh = state.data && Date.now() - state.at < LIST_TTL_MS;
  if (fresh) return { ...state.data, stale: false };

  if (state.data) {
    // Expired: try to refresh, but never lose the previous parse.
    if (state.failedAt && Date.now() - state.failedAt < REFRESH_BACKOFF_MS) return { ...state.data, stale: true };
    try {
      await withTimeout(startRefresh(), loadWaitMs);
      return { ...state.data, stale: false };
    } catch {
      return { ...state.data, stale: true };
    }
  }

  try {
    await withTimeout(startRefresh(), loadWaitMs);
  } catch (e) {
    throw e instanceof MfLoadingError ? e : new MfLoadingError(e.message);
  }
  return { ...state.data, stale: false };
}

// ── Search ──────────────────────────────────────────────────────────────────
function rank(s) {
  if (s.plan === 'direct') return s.option === 'growth' ? 0 : 1;
  if (s.plan === 'regular') return s.option === 'growth' ? 2 : 3;
  return 4;
}

export function toPublic(s) {
  return { schemeCode: s.code, name: s.name, amc: s.amc, plan: s.plan, option: s.option, nav: s.nav, date: s.date };
}

export function searchSchemes(list, query) {
  const q = String(query).trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const hits = [];
  for (const s of list) {
    const exact = s.code === q || s.name.toLowerCase() === q;
    if (!exact && !(s.plan && s.openEnded)) continue;
    const hay = `${s.name} ${s.amc}`.toLowerCase();
    if (exact || tokens.every(t => hay.includes(t))) hits.push(s);
  }
  hits.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.code.localeCompare(b.code));
  return hits.slice(0, MAX_SEARCH_RESULTS).map(s => ({
    code: s.code, name: s.name, amc: s.amc, plan: s.plan, option: s.option, nav: s.nav, date: s.date,
  }));
}

// ── Historical NAV ──────────────────────────────────────────────────────────
async function mfapiSeries(code, from, to) {
  const res = await fetch(`${MFAPI_URL}/${code}?startDate=${from}&endDate=${to}`, { signal: AbortSignal.timeout(MFAPI_TIMEOUT_MS) });
  if (res.status === 404) return []; // unknown scheme
  if (!res.ok) throw new Error(`mfapi failed: ${res.status}`);
  const json = await res.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  const series = [];
  for (const r of rows) {
    const date = mfapiDateToIso(r?.date);
    const nav = parseFloat(r?.nav);
    if (date && date >= from && date <= to && Number.isFinite(nav) && nav > 0) series.push({ date, nav });
  }
  return series.sort((a, b) => a.date.localeCompare(b.date));
}

async function amfiSeries(code, from, to) {
  const url = `${AMFI_HISTORY_URL}?frmdt=${isoToAmfiDate(from)}&todt=${isoToAmfiDate(to)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`AMFI history failed: ${res.status}`);
  const series = [];
  for (const line of (await res.text()).split(/\r?\n/)) {
    const p = line.split(';');
    if (p.length < 8 || p[0].trim() !== code) continue;
    const nav = parseFloat(p[6]);
    const date = amfiDateToIso(p[7]);
    if (date && Number.isFinite(nav) && nav > 0) series.push({ date, nav });
  }
  return series.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * NAV series for [from, to] (ISO dates), ascending. mfapi.in first; if it is
 * down, AMFI's history report — which returns every scheme, so only for short
 * windows (`fallbackFrom`, ≤7 days). Throws when no source could answer.
 */
export async function fetchSeries(code, from, to, fallbackFrom = null) {
  try {
    return { series: await mfapiSeries(code, from, to), source: 'mfapi' };
  } catch (primaryErr) {
    const ff = fallbackFrom || from;
    if (daysBetween(ff, to) + 1 > AMFI_HISTORY_MAX_DAYS) throw primaryErr;
    return { series: await amfiSeries(code, ff, to), source: 'amfi' };
  }
}

/** NAV on `date`, else the latest earlier one (fellBack). */
export async function navOnDate(code, date) {
  const { series, source } = await fetchSeries(code, addDays(date, -HISTORY_LOOKBACK_DAYS), date, addDays(date, -(AMFI_HISTORY_MAX_DAYS - 1)));
  const hit = series.filter(p => p.date <= date).pop() || null;
  return {
    schemeCode: code, date,
    resolvedDate: hit ? hit.date : null,
    fellBack: hit ? hit.date !== date : false,
    nav: hit ? hit.nav : null,
    source,
  };
}
