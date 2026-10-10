/**
 * Monthly mutual-fund holdings pipeline for the household's funds (Invest tab,
 * Phase 2 "portfolio health"). Pure logic + orchestration; the network fetchers
 * live in ./mf-holdings/{absl,sbi,iti}.mjs and the Sheets I/O in
 * ./_invest-sheets.mjs, both injected so every branch here is unit-testable.
 *
 * Contract with the client / insights engine (src/sheetInvest.js INVEST_TABS):
 *   MfHoldings        asOf | fundKey | isin | name | industry | assetClass | weightPct | marketValueInrLakh | sourceFile
 *   MfHoldingsStatus  fundKey | asOf | status | checkedAt | rowCount | weightSum | reason | sourceFile
 * weightPct is PERCENT (0-100) of the scheme's NAV, normalised at parse time.
 * `industry` holds the credit rating for debt rows. The latest and previous asOf
 * per fund are kept. Status is ok | stale | failed | missing; a fund's status
 * `asOf` is the asOf of the rows currently stored for it.
 */
import { FUND_REGISTRY, FUND_KEYS, HOUSES, fundsOfHouse } from './mf-holdings/_registry.mjs';
import { MfFetchError } from './mf-holdings/_errors.mjs';

export { FUND_REGISTRY, FUND_KEYS, HOUSES };

export const HOLDINGS_COLUMNS = ['asOf', 'fundKey', 'isin', 'name', 'industry', 'assetClass', 'weightPct', 'marketValueInrLakh', 'sourceFile'];
export const STATUS_COLUMNS = ['fundKey', 'asOf', 'status', 'checkedAt', 'rowCount', 'weightSum', 'reason', 'sourceFile'];
export const ASSET_CLASSES = ['equity', 'debt', 'cash', 'derivative', 'other'];

/** Weight-sum acceptance band (percent of NAV, derivative notional excluded). */
export const WEIGHT_SUM_MIN = 90;
export const WEIGHT_SUM_MAX = 102;
/** More than this share of weight sitting in unclassified lines fails a fund. */
export const MAX_UNCLASSIFIED_PCT = 5;
/** Months of history a backfill may reach (target month + 2 earlier). */
const BACKFILL_MONTHS = 3;

export { MfFetchError };

/* ── Date logic (IST calendar: AMC files are published in India) ──────────── */

const IST_OFFSET_MS = 5.5 * 3_600_000;
const istParts = (now) => {
  const d = new Date(now.getTime() + IST_OFFSET_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
};
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The month-end portfolio date the job is after: last day of the previous (IST) month. */
export function targetAsOf(now = new Date()) {
  const { y, m } = istParts(now);
  return iso(Date.UTC(y, m, 0));
}

/** Days 8-12 of the (IST) month: the window in which the scheduled job does any work. */
export function inRunWindow(now = new Date()) {
  const { day } = istParts(now);
  return day >= 8 && day <= 12;
}

/** A manual / backfill as-of must be a real month-end, not after the target, within 3 months. */
export function validateAsOf(asOf, now = new Date()) {
  if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return { ok: false, reason: 'asOf must be YYYY-MM-DD' };
  const t = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(t) || iso(t) !== asOf) return { ok: false, reason: 'asOf is not a valid date' };
  if (iso(t + 86_400_000).slice(8) !== '01') return { ok: false, reason: 'asOf must be a month-end' };
  const target = targetAsOf(now);
  if (asOf > target) return { ok: false, reason: `asOf is after the latest month-end (${target})` };
  const [ty, tm] = target.split('-').map(Number);
  const earliest = iso(Date.UTC(ty, tm - BACKFILL_MONTHS, 0)); // month-end of (target month − 3)
  if (asOf <= earliest) return { ok: false, reason: `asOf is more than ${BACKFILL_MONTHS} months back` };
  return { ok: true };
}

/* ── Sanity checks ────────────────────────────────────────────────────────── */

const round = (n, dp) => { const f = 10 ** dp; return Math.round(n * f) / f; };
export const weightSumOf = (rows) => round((rows || []).filter(r => r.assetClass !== 'derivative').reduce((s, r) => s + (Number(r.weightPct) || 0), 0), 4);

/**
 * Validate one parsed fund. status: ok | stale (a valid file for another month,
 * i.e. the AMC has not published the target month yet) | failed.
 */
export function checkFund(f, { target }) {
  const weightSum = weightSumOf(f.rows);
  const out = (status, reason = '') => ({ status, reason, weightSum });
  if (f.error) return out('failed', f.error);
  if (!f.asOf) return out('failed', 'portfolio date not found in the sheet');
  if (f.asOf !== target) return out('stale', `file is dated ${f.asOf}, expected ${target}`);
  if (!Array.isArray(f.rows) || f.rows.length === 0) return out('failed', 'no rows parsed');
  const neg = f.rows.find(r => r.weightPct < 0 && r.assetClass !== 'cash' && r.assetClass !== 'derivative');
  if (neg) return out('failed', `negative weight on ${neg.assetClass} row ${neg.isin || neg.name}`);
  if (weightSum < WEIGHT_SUM_MIN || weightSum > WEIGHT_SUM_MAX) {
    return out('failed', `weights sum to ${weightSum}%, expected ${WEIGHT_SUM_MIN}-${WEIGHT_SUM_MAX}%`);
  }
  if ((f.unclassifiedPct || 0) > MAX_UNCLASSIFIED_PCT) {
    return out('failed', `classification coverage too low (${round(f.unclassifiedPct, 2)}% of weight unclassified)`);
  }
  return out('ok');
}

/* ── Sheet value conversion ───────────────────────────────────────────────── */

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v) => (v == null ? '' : String(v));

export function holdingsToValues(rows) {
  return rows.map(r => [r.asOf, r.fundKey, r.isin, r.name, r.industry, r.assetClass, r.weightPct, r.marketValueInrLakh ?? '', r.sourceFile]);
}

export function valuesToHoldings(values) {
  return (values || [])
    .filter(v => v && v[0] && v[1])
    .map(v => ({
      asOf: str(v[0]), fundKey: str(v[1]), isin: str(v[2]), name: str(v[3]), industry: str(v[4]), assetClass: str(v[5]),
      weightPct: Number(v[6]) || 0, marketValueInrLakh: num(v[7]), sourceFile: str(v[8]),
    }));
}

export function statusToValues(rows) {
  return rows.map(s => [s.fundKey, s.asOf, s.status, s.checkedAt, s.rowCount, s.weightSum, s.reason, s.sourceFile]);
}

export function valuesToStatus(values) {
  return (values || [])
    .filter(v => v && v[0])
    .map(v => ({
      fundKey: str(v[0]), asOf: str(v[1]), status: str(v[2]), checkedAt: str(v[3]),
      rowCount: Number(v[4]) || 0, weightSum: Number(v[5]) || 0, reason: str(v[6]), sourceFile: str(v[7]),
    }));
}

/* ── Merge / retention ────────────────────────────────────────────────────── */

const fundOrder = (k) => { const i = FUND_KEYS.indexOf(k); return i < 0 ? FUND_KEYS.length : i; };

/**
 * Fold freshly-validated funds into the stored rows. Per fund: any rows already
 * stored for the same asOf are replaced (idempotent re-run), then only the
 * latest two distinct asOf values are kept. Funds not in `fresh` are untouched.
 * @param {Array} existing  stored row objects
 * @param {Record<string,{asOf:string, rows:Array, sourceFile:string}>} fresh
 */
export function mergeHoldings(existing, fresh) {
  let rows = existing.filter(r => !(fresh[r.fundKey] && fresh[r.fundKey].asOf === r.asOf));
  for (const [fundKey, f] of Object.entries(fresh)) {
    for (const r of f.rows) {
      rows.push({
        asOf: f.asOf, fundKey, isin: r.isin || '', name: r.name || '', industry: r.industry || '', assetClass: r.assetClass,
        weightPct: r.weightPct, marketValueInrLakh: r.marketValueInrLakh ?? null, sourceFile: f.sourceFile,
      });
    }
  }
  const keep = new Map();
  for (const fundKey of new Set(rows.map(r => r.fundKey))) {
    const asOfs = [...new Set(rows.filter(r => r.fundKey === fundKey).map(r => r.asOf))].sort().reverse().slice(0, 2);
    keep.set(fundKey, new Set(asOfs));
  }
  rows = rows.filter(r => keep.get(r.fundKey).has(r.asOf));
  // Stable: registry order, newest month first, source order within a month.
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => fundOrder(a.r.fundKey) - fundOrder(b.r.fundKey) || (a.r.asOf < b.r.asOf ? 1 : a.r.asOf > b.r.asOf ? -1 : 0) || a.i - b.i)
    .map(x => x.r);
}

/** The status row describing what is currently stored for a fund. */
function statusFromStored(fundKey, holdings, prev, { status, reason, now }) {
  const mine = holdings.filter(r => r.fundKey === fundKey);
  const latest = mine.reduce((m, r) => (r.asOf > m ? r.asOf : m), '');
  const latestRows = mine.filter(r => r.asOf === latest);
  return {
    fundKey, asOf: latest, status, checkedAt: now.toISOString(),
    rowCount: latestRows.length, weightSum: latest ? weightSumOf(latestRows) : 0,
    reason: reason || '', sourceFile: latestRows[0]?.sourceFile || prev?.sourceFile || '',
  };
}

/* ── Orchestration ────────────────────────────────────────────────────────── */

/**
 * Run the pipeline once.
 * @param {object} p
 * @param {{read(): Promise<{holdings:Array,status:Array}>, write(d): Promise<void>}} p.io
 * @param {Record<string,{fetch:Function, parse:Function}>} p.impl  per-house fetch + parse
 * @param {Date} [p.now]
 * @param {string} [p.asOf]      backfill a specific month-end (default: previous month-end)
 * @param {string[]} [p.houses]  limit to these fund houses
 * @param {boolean} [p.force]    re-ingest even if the month is already stored
 * @param {object} [p.params]    extra per-house fetch inputs (e.g. { itiUrl })
 * @returns {Promise<{target, houses: Record<string,{status, funds: Record<string,string>}>, wrote: boolean}>}
 */
export async function runMfHoldings({ io, impl, now = new Date(), asOf, houses, force = false, fetchImpl, sleep, params = {} }) {
  if (asOf !== undefined) {
    const v = validateAsOf(asOf, now);
    if (!v.ok) throw new Error(`invalid asOf: ${v.reason} (must be a month-end within the last ${BACKFILL_MONTHS} months)`);
  }
  const target = asOf || targetAsOf(now);
  const wanted = (houses && houses.length ? houses : HOUSES).filter(h => HOUSES.includes(h));

  const stored = await io.read();
  let holdings = stored.holdings;
  const statusByKey = new Map(stored.status.map(s => [s.fundKey, s]));
  const result = { target, houses: {}, wrote: false };
  let dirty = false;

  const hasRows = (fundKey) => holdings.some(r => r.fundKey === fundKey && r.asOf === target);
  const latestStored = (fundKey) => holdings.filter(r => r.fundKey === fundKey).reduce((m, r) => (r.asOf > m ? r.asOf : m), '');

  /** Record a non-ingesting outcome for a fund (status only; rows untouched). */
  const markFund = (fundKey, status, reason) => {
    if (latestStored(fundKey) > target) return;            // backfill never disturbs the live status
    statusByKey.set(fundKey, statusFromStored(fundKey, holdings, statusByKey.get(fundKey), { status, reason, now }));
    dirty = true;
  };

  for (const house of wanted) {
    const funds = fundsOfHouse(house).filter(f => force || !hasRows(f.fundKey));
    if (funds.length === 0) { result.houses[house] = { status: 'skipped', funds: {} }; continue; }
    const outcomes = {};
    const impls = impl[house];
    let parsed = null;
    try {
      const file = await impls.fetch({ asOf: target, now, fetchImpl, sleep, ...params });
      parsed = impls.parse(file.buffer, { fileName: file.fileName, fundKeys: funds.map(f => f.fundKey) });
    } catch (e) {
      const kind = e instanceof MfFetchError ? e.kind : 'failed';
      const reason = e?.message || String(e);
      for (const f of funds) { markFund(f.fundKey, kind, reason); outcomes[f.fundKey] = kind; }
      result.houses[house] = { status: kind, funds: outcomes, reason };
      continue;
    }

    const fresh = {};
    for (const f of funds) {
      const p = parsed[f.fundKey] || { fundKey: f.fundKey, error: 'fund missing from the parsed workbook' };
      const check = checkFund(p, { target });
      if (check.status === 'ok') {
        fresh[f.fundKey] = { asOf: p.asOf, rows: p.rows, sourceFile: p.sourceFile };
        outcomes[f.fundKey] = 'ok';
      } else {
        outcomes[f.fundKey] = check.status;
        markFund(f.fundKey, check.status, check.reason);
      }
    }
    if (Object.keys(fresh).length) {
      holdings = mergeHoldings(holdings, fresh);
      dirty = true;
      for (const fundKey of Object.keys(fresh)) {
        // A backfill of an older month leaves the live status row as it was.
        if (latestStored(fundKey) > target) continue;
        statusByKey.set(fundKey, statusFromStored(fundKey, holdings, statusByKey.get(fundKey), { status: 'ok', reason: '', now }));
      }
    }
    const vals = Object.values(outcomes);
    result.houses[house] = { status: vals.every(v => v === 'ok') ? 'done' : vals.some(v => v === 'ok') ? 'partial' : 'failed', funds: outcomes };
  }

  if (dirty) {
    const status = FUND_KEYS.filter(k => statusByKey.has(k)).map(k => statusByKey.get(k));
    await io.write({ holdings, status });
    result.wrote = true;
  }
  return result;
}
