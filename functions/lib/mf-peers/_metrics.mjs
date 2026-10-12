/**
 * Pure NAV-series metrics for the Fund-vs-peers job. No I/O, deterministic.
 * Dates are ISO calendar days (YYYY-MM-DD); a series is [{ date, nav }].
 * Every figure is a PERCENT number (13.71, not 0.1371).
 *
 * Cleaning (cleanSeries): rows with a bad date or a non-finite / <= 0 NAV are
 * dropped; duplicate dates keep the LAST occurrence; the result is sorted
 * ascending. There is NO forward-fill: AMFI publishes NAVs on business days
 * only, and every lookup uses "the NAV on or before the date" (the same rule
 * AMFI uses for its own point-to-point returns).
 *
 * CAGR convention: start NAV = the NAV on or before the SAME calendar day N
 * years before the last NAV date; annualised as (end/start)^(365/days) - 1.
 */
const DAY = 86_400_000;
const ms = (iso) => Date.parse(`${iso}T00:00:00Z`);
const isoOf = (t) => new Date(t).toISOString().slice(0, 10);
/** A real calendar day (V8 rolls 2026-02-30 over to March, so round-trip it). */
export const isIsoDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(ms(d)) && isoOf(ms(d)) === d;
export const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY);

export const MAX_GAP_DAYS = 7;
export const MAX_JUMP_PCT = 15;
export const TRADING_DAYS = 252;
/** Rolling-window design: 25 monthly-stepped 1y windows over the last 3 years. */
export const ROLLING_WINDOWS = 25;
export const MIN_ROLLING_WINDOWS = 12;
export const MIN_ROLLING_PEERS = 3;
export const SERIES_MONTHS = 61;

export function cleanSeries(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const nav = Number(r?.nav);
    if (!isIsoDay(r?.date)) continue;
    if (!Number.isFinite(nav) || nav <= 0) continue;
    by.set(r.date, nav);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, nav]) => ({ date, nav }));
}

/** Same calendar day n years earlier (29 Feb → 28 Feb). */
export function subYears(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const x = new Date(Date.UTC(y - n, m - 1, d));
  if (x.getUTCMonth() !== m - 1) x.setUTCDate(0);
  return x.toISOString().slice(0, 10);
}

/** Index of the last point with date <= `date`, or -1. */
export function indexOnOrBefore(s, date) {
  let lo = 0; let hi = s.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Annualised return (%) over `years` ending at the last NAV; null (never 0) when
 * the series starts after the start date or the start NAV is more than
 * MAX_GAP_DAYS before it.
 */
export function cagrPct(s, years) {
  if (!s.length) return null;
  const end = s[s.length - 1];
  const startDate = subYears(end.date, years);
  const i = indexOnOrBefore(s, startDate);
  if (i < 0 || daysBetween(s[i].date, startDate) > MAX_GAP_DAYS) return null;
  const days = daysBetween(s[i].date, end.date);
  if (days <= 0) return null;
  return (Math.pow(end.nav / s[i].nav, 365 / days) - 1) * 100;
}

/** Points on or after (last date − years). Older points never influence a windowed metric. */
export function windowOf(s, years) {
  if (!s.length) return [];
  const from = subYears(s[s.length - 1].date, years);
  return s.filter((p) => p.date >= from);
}

function stdevLog(points) {
  const r = [];
  for (let i = 1; i < points.length; i++) r.push(Math.log(points[i].nav / points[i - 1].nav));
  if (r.length < 2) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v) * Math.sqrt(TRADING_DAYS) * 100;
}

function drawdown(points) {
  let peak = points[0].nav; let mdd = 0;
  for (const p of points) { if (p.nav > peak) peak = p.nav; mdd = Math.min(mdd, p.nav / peak - 1); }
  return mdd * 100;
}

/** Annualised stdev (%) of daily log returns (n-1) over the last `years`; null when the window spans < minDays. */
export function volPct(s, years = 3, minDays = 365) {
  const w = windowOf(s, years);
  if (w.length < 3 || daysBetween(w[0].date, w[w.length - 1].date) < minDays) return null;
  return stdevLog(w);
}

/** Max drawdown (%, <= 0) over the last `years`; null when the window spans < minDays. */
export function maxDrawdownPct(s, years = 5, minDays = 180) {
  const w = windowOf(s, years);
  if (w.length < 2 || daysBetween(w[0].date, w[w.length - 1].date) < minDays) return null;
  return drawdown(w);
}

/** Data-quality flags inside the last `years`: gaps > MAX_GAP_DAYS and one-day moves > MAX_JUMP_PCT. */
export function qualityFlags(s, years = 5) {
  const w = windowOf(s, years);
  const gaps = []; const jumps = [];
  for (let i = 1; i < w.length; i++) {
    const g = daysBetween(w[i - 1].date, w[i].date);
    if (g > MAX_GAP_DAYS) gaps.push({ from: w[i - 1].date, to: w[i].date, days: g });
    const j = (w[i].nav / w[i - 1].nav - 1) * 100;
    if (Math.abs(j) > MAX_JUMP_PCT) jumps.push({ date: w[i].date, pct: j });
  }
  return { gaps, jumps };
}

/**
 * Metrics over a fixed common window [startDate, last NAV] (conglomerate card).
 * Requires a NAV on or before startDate (the series must really cover the whole
 * window); otherwise everything is blank with a reason, never a shorter window.
 * retWindowPct is annualised only when the window spans >= 365 days, else the
 * plain cumulative return (windowReturnBasis says which).
 */
export function windowMetrics(s, startDate, { minPoints = 20 } = {}) {
  const blank = (reason) => ({ ok: false, reason, windowStartDate: '', retWindowPct: null, windowReturnBasis: '', volWindowPct: null, maxDrawdownWindowPct: null });
  if (!s.length) return blank('no NAV history');
  const i = indexOnOrBefore(s, startDate);
  if (i < 0) return blank(`history starts ${s[0].date}, after the window start ${startDate}`);
  const last = s[s.length - 1];
  const days = daysBetween(startDate, last.date);
  if (days <= 0) return blank('window is empty');
  const pts = s.slice(i);
  const cum = last.nav / s[i].nav;
  const annualised = days >= 365;
  return {
    ok: true,
    reason: '',
    windowStartDate: startDate,
    retWindowPct: ((annualised ? Math.pow(cum, 365 / days) : cum) - 1) * 100,
    windowReturnBasis: annualised ? 'annualised' : 'cumulative',
    volWindowPct: pts.length >= minPoints ? stdevLog(pts) : null,
    maxDrawdownWindowPct: pts.length >= 2 ? drawdown(pts) : null,
  };
}

/* ── month-end grid (rolling beat) ─────────────────────────────────────── */

/** The last calendar month-end that is <= date. */
export function lastCompletedMonthEnd(date) {
  const [y, m] = date.split('-').map(Number);
  const eom = Date.UTC(y, m, 0);
  return ms(date) >= eom ? isoOf(eom) : isoOf(Date.UTC(y, m - 1, 0));
}

/** `count` month-ends ending at endMonthEnd, oldest → newest. */
export function monthEndsBack(endMonthEnd, count = SERIES_MONTHS) {
  const [y, m] = endMonthEnd.split('-').map(Number);
  const out = [];
  for (let k = count - 1; k >= 0; k--) out.push(isoOf(Date.UTC(y, m - k, 0)));
  return out;
}

/** Month-end NAVs (oldest → newest); null before the first NAV or when the NAV on or before is > 31 days stale. */
export function monthEndNavs(s, endMonthEnd, count = SERIES_MONTHS) {
  return monthEndsBack(endMonthEnd, count).map((d) => {
    const i = indexOnOrBefore(s, d);
    return i < 0 || daysBetween(s[i].date, d) > 31 ? null : s[i].nav;
  });
}

export function median(a) {
  const b = [...a].sort((x, y) => x - y); const n = b.length;
  return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}

/**
 * Share (%) of monthly-stepped rolling 1-year windows (the last ROLLING_WINDOWS
 * month-ends) in which the held fund's return beat the median of the peers'
 * returns for the same window. `held` and each peer are month-end NAV arrays
 * aligned oldest → newest, same length. Windows with fewer than MIN_ROLLING_PEERS
 * peer returns are skipped; fewer than MIN_ROLLING_WINDOWS usable → { pct: null }.
 * @returns {{ pct: number|null, windows: number }}
 */
export function rollingBeat(held, peers) {
  const n = held.length;
  let wins = 0; let total = 0;
  for (let e = Math.max(12, n - ROLLING_WINDOWS); e < n; e++) {
    const hs = held[e - 12]; const he = held[e];
    if (hs == null || he == null) continue;
    const pr = [];
    for (const p of peers) if (p[e - 12] != null && p[e] != null) pr.push(p[e] / p[e - 12] - 1);
    if (pr.length < MIN_ROLLING_PEERS) continue;
    total++;
    if (he / hs - 1 > median(pr)) wins++;
  }
  return { pct: total < MIN_ROLLING_WINDOWS ? null : (wins / total) * 100, windows: total };
}

/** Re-express a stored month-end array (ending at `fromEnd`) on a grid ending at `toEnd` (same length). */
export function alignMonthEnds(navs, fromEnd, toEnd) {
  const n = navs.length;
  const grid = monthEndsBack(toEnd, n);
  const src = new Map(monthEndsBack(fromEnd, n).map((d, i) => [d, navs[i]]));
  return grid.map((d) => (src.has(d) ? src.get(d) : null));
}

export function encodeNavs(navs) {
  return navs.map((v) => (v == null ? '' : String(Math.round(v * 1e6) / 1e6))).join(',');
}
export function decodeNavs(csv) {
  return String(csv ?? '').split(',').map((x) => (x === '' ? null : (Number.isFinite(Number(x)) ? Number(x) : null)));
}
