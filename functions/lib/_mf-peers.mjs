/**
 * "Fund vs peers" data job for the household's Indian mutual funds (Invest tab,
 * Phase 2 slice 2). Pure logic + orchestration; the network fetchers live in
 * ./mf-peers/*.mjs and the Sheets I/O in ./_invest-sheets.mjs, both injected so
 * every branch is unit-testable.
 *
 * Tab contract (src/sheetInvest.js INVEST_TABS is pinned equal by a test). Every
 * return / volatility / drawdown / TER figure is a PERCENT number, blank when not
 * computable. The card reads columns by HEADER NAME.
 *
 *   MfPeersConfig   user-editable; seeded from peers.approved.json only while the tab has no
 *                   data rows, never overwritten afterwards. One row per scheme (both plans).
 *   MfPeers         derived. One row per (code, plan); the latest 2 distinct asOf values are
 *                   kept per (code, plan). `asOf` = job run date (IST) of that row's last
 *                   SUCCESSFUL refresh; a failed/stale code keeps its row and only has
 *                   status/reason updated (asOf and fetchedAt are never bumped).
 *   MfTer           derived monthly, replaced as a whole (one row per tracked code and plan).
 *   MfPeersSeries   compact month-end NAVs (61 per code/plan) so the weekly held run can
 *                   recompute the rolling-beat share without refetching ~100 peer series.
 *   MfPeersRun      one row per scope (held | peers | ter): cycle progress for resume + status.
 */
import { SEED_CATEGORIES, BENCHMARK_CODES, KNOWN_NO_TER } from './mf-peers/_seed.mjs';
import {
  cleanSeries, cagrPct, volPct, maxDrawdownPct, qualityFlags, windowMetrics, daysBetween,
  lastCompletedMonthEnd, monthEndNavs, alignMonthEnds, encodeNavs, decodeNavs, rollingBeat, SERIES_MONTHS,
} from './mf-peers/_metrics.mjs';
import { fetchHistory, SeriesError } from './mf-peers/_series.mjs';
import { loadTerIndex, matchTer } from './mf-peers/_ter.mjs';
import { spotCheck } from './mf-peers/_spotcheck.mjs';

export { SEED_CATEGORIES };

export const CONFIG_COLUMNS = ['categoryKey', 'role', 'fundKey', 'amc', 'name', 'directCode', 'regularCode', 'isin', 'launch', 'note', 'weakMatch', 'active', 'comparisonJson'];
export const PEERS_COLUMNS = [
  'asOf', 'categoryKey', 'role', 'fundKey', 'code', 'plan', 'name', 'firstNavDate', 'lastNavDate', 'nav',
  'ret1yPct', 'ret3yPct', 'ret5yPct', 'volPct', 'maxDrawdownPct', 'rollingBeatPeerMedianPct', 'historyDays', 'status', 'reason',
  'rollingWindows', 'windowStartDate', 'retWindowPct', 'windowReturnBasis', 'volWindowPct', 'maxDrawdownWindowPct', 'fetchedAt',
];
export const TER_COLUMNS = ['asOf', 'code', 'plan', 'name', 'terPct', 'berPct', 'matchedName', 'matched', 'terDate', 'reason'];
export const SERIES_COLUMNS = ['code', 'plan', 'asOf', 'lastMonthEnd', 'n', 'navsCsv'];
export const RUN_COLUMNS = ['scope', 'cycle', 'startedAt', 'finishedAt', 'done', 'total', 'cursorNote', 'lastError'];

export const SCOPES = ['held', 'peers', 'ter'];
export const ROLES = ['held', 'peer', 'benchmark'];
export const STATUSES = ['ok', 'stale', 'failed', 'insufficient-history'];
export const PLANS = ['direct', 'regular'];

export const TAB = { config: 'MfPeersConfig', peers: 'MfPeers', ter: 'MfTer', series: 'MfPeersSeries', run: 'MfPeersRun' };
export const LIMITS = { config: 200, peers: 1000, ter: 400, series: 400, run: 20 };
/** Checkpoint the sheet after this many freshly-fetched codes (a crash loses at most this many). */
const CHECKPOINT_EVERY = 25;
/** Scheduled slice budget; the 540 s timeout leaves room for the in-flight code (<= ~70 s) and the TER pass. */
export const DEFAULT_BUDGET_MS = 360_000;
const MIN_HISTORY_DAYS = 365;

/* ── IST calendar (the AMCs and AMFI publish on Indian days) ──────────────── */
const IST_MS = 5.5 * 3_600_000;
export const istDate = (now) => new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
/** Midnight IST of an ISO date, as a UTC instant (ms). */
const istMidnight = (isoDate) => Date.parse(`${isoDate}T00:00:00Z`) - IST_MS;

/** { cycle, startMs }: held = the IST week (Sunday-based), peers/ter = the IST month. */
export function cycleOf(scope, now) {
  const d = istDate(now);
  if (scope === 'held') {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const sunday = new Date(Date.parse(`${d}T00:00:00Z`) - dow * 86_400_000).toISOString().slice(0, 10);
    return { cycle: `W${sunday}`, startMs: istMidnight(sunday) };
  }
  const first = `${d.slice(0, 7)}-01`;
  return { cycle: d.slice(0, 7), startMs: istMidnight(first) };
}

/* ── value conversion ─────────────────────────────────────────────────────── */
const str = (v) => (v == null ? '' : String(v));
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const out = (v) => (v == null ? '' : v);
const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const bool = (v) => v === true || /^(true|1|yes|y)$/i.test(String(v ?? '').trim());

/** The fundKey of a non-held row (stable per scheme; peers.approved.json has none). */
export const peerFundKey = (directCode) => `peer-${directCode}`;

export function seedConfigValues() {
  const rows = [];
  for (const [categoryKey, c] of Object.entries(SEED_CATEGORIES)) {
    const cmp = c.comparison ? JSON.stringify(c.comparison) : '';
    const h = c.held;
    rows.push([categoryKey, 'held', h.fundKey, h.amc, h.name, h.directCode, h.regularCode, h.isin || '', h.launch, '', false, true, cmp]);
    for (const p of c.peers) {
      const role = BENCHMARK_CODES.has(String(p.directCode)) ? 'benchmark' : 'peer';
      rows.push([categoryKey, role, peerFundKey(p.directCode), p.amc, p.name, p.directCode, p.regularCode, p.isin || '', p.launch, p.note || '', !!p.weakMatch, true, cmp]);
    }
  }
  return rows;
}

export function valuesToConfig(values) {
  const out = [];
  for (const v of values || []) {
    if (!v || !v[0] || !v[5]) continue;
    let comparison = null;
    const raw = str(v[12]).trim();
    if (raw) { try { comparison = JSON.parse(raw); } catch { comparison = null; } }
    out.push({
      categoryKey: str(v[0]).trim(), role: str(v[1]).trim(), fundKey: str(v[2]).trim(), amc: str(v[3]), name: str(v[4]),
      directCode: str(v[5]).trim(), regularCode: str(v[6]).trim(), isin: str(v[7]), launch: str(v[8]), note: str(v[9]),
      weakMatch: bool(v[10]), active: v[11] === '' || v[11] == null ? true : bool(v[11]), comparison,
    });
  }
  return out;
}

export function valuesToPeers(values) {
  return (values || []).filter((v) => v && v[4]).map((v) => {
    const o = {};
    PEERS_COLUMNS.forEach((c, i) => { o[c] = v[i] === undefined ? '' : v[i]; });
    for (const c of ['asOf', 'categoryKey', 'role', 'fundKey', 'code', 'plan', 'name', 'firstNavDate', 'lastNavDate', 'status', 'reason', 'windowStartDate', 'windowReturnBasis', 'fetchedAt']) o[c] = str(o[c]);
    for (const c of ['nav', 'ret1yPct', 'ret3yPct', 'ret5yPct', 'volPct', 'maxDrawdownPct', 'rollingBeatPeerMedianPct', 'historyDays', 'rollingWindows', 'retWindowPct', 'volWindowPct', 'maxDrawdownWindowPct']) o[c] = numOrNull(o[c]);
    return o;
  });
}
export const peersToValues = (rows) => rows.map((r) => PEERS_COLUMNS.map((c) => out(r[c])));

export function valuesToSeries(values) {
  return (values || []).filter((v) => v && v[0]).map((v) => ({ code: str(v[0]), plan: str(v[1]), asOf: str(v[2]), lastMonthEnd: str(v[3]), n: Number(v[4]) || 0, navsCsv: str(v[5]) }));
}
export const seriesToValues = (rows) => rows.map((r) => [r.code, r.plan, r.asOf, r.lastMonthEnd, r.n, r.navsCsv]);

export function valuesToRun(values) {
  return (values || []).filter((v) => v && v[0]).map((v) => ({
    scope: str(v[0]), cycle: str(v[1]), startedAt: str(v[2]), finishedAt: str(v[3]), done: Number(v[4]) || 0, total: Number(v[5]) || 0, cursorNote: str(v[6]), lastError: str(v[7]),
  }));
}
export const runToValues = (rows) => rows.map((r) => [r.scope, r.cycle, r.startedAt, r.finishedAt, r.done, r.total, r.cursorNote, r.lastError]);

export function valuesToTer(values) {
  return (values || []).filter((v) => v && v[1]).map((v) => ({
    asOf: str(v[0]), code: str(v[1]), plan: str(v[2]), name: str(v[3]), terPct: numOrNull(v[4]), berPct: numOrNull(v[5]),
    matchedName: str(v[6]), matched: bool(v[7]), terDate: str(v[8]), reason: str(v[9]),
  }));
}
export const terToValues = (rows) => rows.map((r) => [r.asOf, r.code, r.plan, r.name, out(r.terPct), out(r.berPct), r.matchedName, !!r.matched, r.terDate, r.reason]);

/* ── targets ──────────────────────────────────────────────────────────────── */

/** SBI sub-plan code → categoryKey (Direct and Regular growth codes). */
export const SBI_CODE_TO_CATEGORY = {
  148683: 'retirement-aggressive', 148698: 'retirement-aggressive',
  148685: 'retirement-aggressive-hybrid', 148695: 'retirement-aggressive-hybrid',
  148690: 'retirement-conservative-hybrid', 148692: 'retirement-conservative-hybrid',
  148688: 'retirement-conservative', 148696: 'retirement-conservative',
};

/** Which SBI retirement category the SipPlans tab pins (by mapped code, else by name), or null. */
export function sbiCategoryFromSip(sipValues) {
  for (const v of sipValues || []) {
    const id = str(v?.[0]).toLowerCase();
    const name = str(v?.[2]);
    if (id !== 'sbi-retirement' && !/sbi\s+retirement/i.test(name)) continue;
    const byCode = SBI_CODE_TO_CATEGORY[str(v[1]).trim()];
    if (byCode) return byCode;
    const n = name.toLowerCase();
    if (/aggressive hybrid/.test(n)) return 'retirement-aggressive-hybrid';
    if (/conservative hybrid/.test(n)) return 'retirement-conservative-hybrid';
    if (/aggressive/.test(n)) return 'retirement-aggressive';
    if (/conservative/.test(n)) return 'retirement-conservative';
  }
  return null;
}

/**
 * Active (category, scheme, plan) targets. A category whose held row is inactive is
 * skipped whole. The SipPlans auto-rule only narrows the retirement categories to the
 * held sub-plan; an explicit active=FALSE in the sheet always wins and is never re-enabled.
 */
export function buildTargets(config, sbiCategory = null) {
  const heldActive = new Set(config.filter((e) => e.role === 'held' && e.active).map((e) => e.categoryKey));
  const cats = new Map(config.filter((e) => e.role === 'held').map((e) => [e.categoryKey, e]));
  const out = [];
  for (const e of config) {
    if (!e.active || !heldActive.has(e.categoryKey) || !ROLES.includes(e.role)) continue;
    if (sbiCategory && e.categoryKey.startsWith('retirement-') && e.categoryKey !== sbiCategory) continue;
    const heldEntry = cats.get(e.categoryKey);
    const weekly = !!(heldEntry?.comparison?.window) || !!(e.comparison?.window); // whole-category weekly (conglomerate)
    for (const plan of PLANS) {
      const code = plan === 'direct' ? e.directCode : e.regularCode;
      if (!code) continue;
      out.push({ categoryKey: e.categoryKey, role: e.role, fundKey: e.fundKey, name: e.name, directCode: e.directCode, plan, code, comparison: heldEntry?.comparison || e.comparison || null, weekly });
    }
  }
  return out;
}

export function targetsOfScope(scope, targets) {
  if (scope === 'held') return targets.filter((t) => t.role === 'held' || t.weekly);
  if (scope === 'peers') return targets.filter((t) => t.role !== 'held' && !t.weekly);
  return targets; // ter: everything tracked
}

/* ── metrics → row ────────────────────────────────────────────────────────── */

const windowStartOf = (comparison) => {
  const m = /^common-since-(\d{4}-\d{2}-\d{2})$/.exec(String(comparison?.window || ''));
  return m ? m[1] : null;
};

/** Build the MfPeers row (without rolling-beat) from a cleaned series. */
export function computeRow(t, series, { today, nowIso }) {
  const first = series[0]; const last = series[series.length - 1];
  const historyDays = daysBetween(first.date, last.date);
  const flags = qualityFlags(series, 5);
  const notes = [];
  if (flags.gaps.length) notes.push(`NAV gap > 7 days: ${flags.gaps.slice(0, 2).map((g) => `${g.from}→${g.to} (${g.days}d)`).join(', ')}${flags.gaps.length > 2 ? ` +${flags.gaps.length - 2} more` : ''}`);
  if (flags.jumps.length) notes.push(`one-day NAV move > 15%: ${flags.jumps.slice(0, 2).map((j) => `${j.date} (${j.pct.toFixed(1)}%)`).join(', ')}${flags.jumps.length > 2 ? ` +${flags.jumps.length - 2} more` : ''}`);
  let status = 'ok';
  if (historyDays < MIN_HISTORY_DAYS) { status = 'insufficient-history'; notes.unshift(`history is ${historyDays} days (< 1 year since ${first.date})`); }
  const wStart = windowStartOf(t.comparison);
  const w = wStart ? windowMetrics(series, wStart) : null;
  if (w && !w.ok) notes.push(`common window: ${w.reason}`);
  return {
    asOf: today, categoryKey: t.categoryKey, role: t.role, fundKey: t.fundKey, code: t.code, plan: t.plan, name: t.name,
    firstNavDate: first.date, lastNavDate: last.date, nav: last.nav,
    ret1yPct: r4(cagrPct(series, 1)), ret3yPct: r4(cagrPct(series, 3)), ret5yPct: r4(cagrPct(series, 5)),
    volPct: r4(volPct(series, 3)), maxDrawdownPct: r4(maxDrawdownPct(series, 5)),
    rollingBeatPeerMedianPct: null, rollingWindows: null,
    historyDays, status, reason: notes.join('; '),
    windowStartDate: w?.ok ? w.windowStartDate : '', retWindowPct: w?.ok ? r4(w.retWindowPct) : null, windowReturnBasis: w?.ok ? w.windowReturnBasis : '',
    volWindowPct: w?.ok ? r4(w.volWindowPct) : null, maxDrawdownWindowPct: w?.ok ? r4(w.maxDrawdownWindowPct) : null,
    fetchedAt: nowIso,
  };
}

/* ── merge / retention ────────────────────────────────────────────────────── */

const keyOf = (code, plan) => `${code}|${plan}`;

/** Map(code|plan → rows[] newest asOf first). */
function groupPeers(rows) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r.code, r.plan); m.set(k, [...(m.get(k) || []), r]); }
  for (const [k, list] of m) m.set(k, list.sort((a, b) => (a.asOf < b.asOf ? 1 : a.asOf > b.asOf ? -1 : 0)));
  return m;
}

/** A fresh success: replaces the same-asOf row (idempotent), drops placeholders, keeps the latest 2 asOf. */
export function upsertSuccess(store, row) {
  const k = keyOf(row.code, row.plan);
  const list = (store.get(k) || []).filter((r) => r.asOf !== row.asOf && r.asOf !== '');
  list.push(row);
  list.sort((a, b) => (a.asOf < b.asOf ? 1 : -1));
  store.set(k, list.slice(0, 2));
}

/** A failed/stale attempt: status + reason updated in place on the latest row (asOf/fetchedAt untouched), or a placeholder. */
export function markProblem(store, t, status, reason) {
  const k = keyOf(t.code, t.plan);
  const list = store.get(k) || [];
  if (list.length) { list[0] = { ...list[0], status, reason }; store.set(k, list); return; }
  store.set(k, [{
    asOf: '', categoryKey: t.categoryKey, role: t.role, fundKey: t.fundKey, code: t.code, plan: t.plan, name: t.name,
    firstNavDate: '', lastNavDate: '', nav: null, ret1yPct: null, ret3yPct: null, ret5yPct: null, volPct: null, maxDrawdownPct: null,
    rollingBeatPeerMedianPct: null, rollingWindows: null, historyDays: null, status, reason,
    windowStartDate: '', retWindowPct: null, windowReturnBasis: '', volWindowPct: null, maxDrawdownWindowPct: null, fetchedAt: '',
  }]);
}

const roleOrder = { held: 0, benchmark: 2, peer: 1 };
export function flattenStore(store, config) {
  const order = new Map(config.map((e, i) => [e.directCode, i]));
  const rows = [];
  for (const list of store.values()) rows.push(...list);
  const dir = (r) => order.get(r.plan === 'direct' ? r.code : (config.find((e) => e.regularCode === r.code)?.directCode)) ?? 9999;
  return rows
    .map((r, i) => ({ r, i, o: dir(r) }))
    .sort((a, b) => a.o - b.o || (a.r.plan < b.r.plan ? -1 : a.r.plan > b.r.plan ? 1 : 0) || (a.r.asOf < b.r.asOf ? 1 : a.r.asOf > b.r.asOf ? -1 : 0) || a.i - b.i)
    .map((x) => x.r);
}

/* ── rolling beat (held rows, from the month-end series tab) ─────────────── */

/** Recompute rollingBeatPeerMedianPct / rollingWindows for held rows of non-windowed categories. */
export function applyRollingBeat(store, seriesStore, targets) {
  for (const t of targets) {
    if (t.role !== 'held' || t.comparison?.window) continue;
    const list = store.get(keyOf(t.code, t.plan));
    const row = list?.[0];
    const hs = seriesStore.get(keyOf(t.code, t.plan));
    if (!row || row.asOf === '' || !hs) continue;
    const heldNavs = decodeNavs(hs.navsCsv);
    const peers = targets
      .filter((p) => p.role === 'peer' && p.categoryKey === t.categoryKey && p.plan === t.plan)
      .map((p) => seriesStore.get(keyOf(p.code, p.plan)))
      .filter(Boolean)
      .map((s) => alignMonthEnds(decodeNavs(s.navsCsv), s.lastMonthEnd, hs.lastMonthEnd));
    const { pct, windows } = rollingBeat(heldNavs, peers);
    list[0] = { ...row, rollingBeatPeerMedianPct: r4(pct), rollingWindows: windows };
  }
}

/* ── orchestration ────────────────────────────────────────────────────────── */

const emptyRun = (scope) => ({ scope, cycle: '', startedAt: '', finishedAt: '', done: 0, total: 0, cursorNote: '', lastError: '' });

/**
 * Run one scope (held | peers | ter) once, within a time budget.
 * @param {object} p
 * @param {object} p.io      { read(), writeConfig(values), writePeers(rows), writeSeries(rows), writeTer(rows), writeRun(rows) }
 * @param {object} p.deps    { client, sleep, getNavAll(): Promise<Map>, clock?: ()=>number }
 * @returns {Promise<{scope, cycle, done:boolean, total, completed, remaining, ok, stale, failed, skipped, failures:Array, error:string}>}
 */
export async function runScope({ scope, io, deps, now = new Date(), force = false, budgetMs = DEFAULT_BUDGET_MS }) {
  const clock = deps.clock || (() => Date.now());
  const deadline = clock() + budgetMs;
  const today = istDate(now);
  const nowIso = now.toISOString();
  const { cycle, startMs } = cycleOf(scope, now);

  const state = await io.read();
  let config = valuesToConfig(state.config);
  if (!config.length) {
    await io.writeConfig(seedConfigValues());
    config = valuesToConfig(seedConfigValues());
  }
  const targets = buildTargets(config, sbiCategoryFromSip(state.sip));
  const scoped = targetsOfScope(scope, targets);
  const runRows = valuesToRun(state.run);
  const prevRun = runRows.find((r) => r.scope === scope) || emptyRun(scope);
  const startedAt = prevRun.cycle === cycle && prevRun.startedAt ? prevRun.startedAt : nowIso;
  const saveRun = async (patch) => {
    const mine = { ...prevRun, scope, cycle, startedAt, ...patch };
    await io.writeRun([...runRows.filter((r) => r.scope !== scope), mine].sort((a, b) => SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope)));
  };
  const result = { scope, cycle, done: false, total: scoped.length, completed: 0, remaining: 0, ok: 0, stale: 0, failed: 0, skipped: 0, failures: [], error: '' };

  if (scope === 'ter') return runTer({ io, deps, state, config, scoped, today, now, nowIso, cycle, startMs, force, result, saveRun });

  const store = groupPeers(valuesToPeers(state.peers));
  const seriesStore = new Map(valuesToSeries(state.series).map((s) => [keyOf(s.code, s.plan), s]));
  const isDone = (t) => {
    const r = store.get(keyOf(t.code, t.plan))?.[0];
    return !!r && r.fetchedAt !== '' && Date.parse(r.fetchedAt) >= startMs && r.status !== 'failed';
  };

  let navAll;
  try {
    navAll = await deps.getNavAll();
  } catch (e) {
    result.error = `phase=nav-check host=portal.amfiindia.com ${e?.message || e}`;
    await saveRun({ done: 0, total: scoped.length, cursorNote: 'AMFI NAVAll unavailable', lastError: result.error });
    return result;
  }

  const sinceCheckpoint = { n: 0 };
  const persist = async () => {
    applyRollingBeat(store, seriesStore, targets);
    const keepCodes = new Set(config.flatMap((e) => [e.directCode, e.regularCode]));
    for (const k of [...store.keys()]) if (!keepCodes.has(k.split('|')[0])) store.delete(k);
    await io.writePeers(flattenStore(store, config));
    await io.writeSeries([...seriesStore.values()].filter((s) => keepCodes.has(s.code)));
  };

  let budgetHit = false;
  const samples = [];
  for (const t of scoped) {
    if (!force && isDone(t)) { result.skipped++; continue; }
    if (clock() >= deadline) { budgetHit = true; result.remaining++; continue; }
    try {
      const { series } = await fetchHistory(t.code, { navAll, client: deps.client, sleep: deps.sleep });
      const row = computeRow(t, series, { today, nowIso });
      upsertSuccess(store, row);
      const monthEnd = lastCompletedMonthEnd(row.lastNavDate);
      const navs = monthEndNavs(series, monthEnd, SERIES_MONTHS);
      seriesStore.set(keyOf(t.code, t.plan), { code: t.code, plan: t.plan, asOf: today, lastMonthEnd: monthEnd, n: navs.length, navsCsv: encodeNavs(navs) });
      result.ok++;
      if (scope === 'peers' && samples.length < 2 && row.lastNavDate === navAll.get(String(t.code))?.date && (!samples[0] || samples[0].date === row.lastNavDate)) samples.push({ code: t.code, plan: t.plan, date: row.lastNavDate, nav: row.nav });
      if (++sinceCheckpoint.n >= CHECKPOINT_EVERY) { await persist(); sinceCheckpoint.n = 0; }
    } catch (e) {
      const stale = e instanceof SeriesError && e.kind === 'stale';
      const reason = e?.message || String(e);
      markProblem(store, t, stale ? 'stale' : 'failed', reason);
      result[stale ? 'stale' : 'failed']++;
      result.failures.push({ code: t.code, plan: t.plan, status: stale ? 'stale' : 'failed', reason });
    }
  }
  let spotNote = '';
  if (scope === 'peers' && samples.length === 2) {
    const sc = await spotCheck(deps.client, samples);
    spotNote = sc.note;
    for (const m of sc.mismatches) {
      const row = store.get(keyOf(m.code, samples.find((x) => x.code === m.code).plan))?.[0];
      if (row) row.reason = [row.reason, `spot-check: mfapi NAV ${m.mfapi} differs from AMFI ${m.amfi} on ${row.lastNavDate}`].filter(Boolean).join('; ');
    }
  }
  await persist();

  result.completed = scoped.filter(isDone).length;
  result.done = !budgetHit && result.completed === scoped.length;
  const note = [budgetHit ? 'time budget reached; will resume' : '', spotNote, result.failed ? `${result.failed} failed` : '', result.stale ? `${result.stale} stale` : ''].filter(Boolean).join('; ');
  await saveRun({ done: result.completed, total: scoped.length, finishedAt: result.done ? nowIso : '', cursorNote: note, lastError: result.failures[0]?.reason || '' });
  return result;
}

async function runTer({ io, deps, state, config, scoped, today, nowIso, cycle, force, result, saveRun, startMs }) {
  const prev = valuesToTer(state.ter);
  const prevRun = valuesToRun(state.run).find((r) => r.scope === 'ter');
  if (!force && prevRun && prevRun.cycle === cycle && prevRun.finishedAt && Date.parse(prevRun.finishedAt) >= startMs) {
    result.done = true; result.skipped = scoped.length; result.completed = scoped.length;
    return result;
  }
  const schemes = [...new Map(config.filter((e) => e.active).map((e) => [e.directCode, { name: e.name, directCode: e.directCode }])).values()];
  let loaded;
  try {
    loaded = await loadTerIndex(deps.client, today, schemes);
  } catch (e) {
    loaded = { index: new Map(), notes: [e?.message || String(e)], rowCount: 0 };
  }
  const feedProblem = loaded.rowCount === 0 || loaded.notes.length > 0;
  const prevByKey = new Map(prev.map((r) => [keyOf(r.code, r.plan), r]));
  const rows = [];
  for (const t of scoped) {
    const m = matchTer(loaded.index, { name: t.name, directCode: t.directCode }, t.plan);
    const old = prevByKey.get(keyOf(t.code, t.plan));
    if (!m.matched && feedProblem && old?.matched) { rows.push(old); continue; } // transient outage: keep the last good value (its asOf shows its age)
    const reason = m.matched ? '' : (loaded.rowCount === 0 ? `AMFI TER feed unavailable: ${loaded.notes[0] || 'no rows returned'}` : m.reason);
    rows.push({ asOf: today, code: t.code, plan: t.plan, name: t.name, terPct: m.terPct, berPct: m.berPct, matchedName: m.matchedName, matched: m.matched, terDate: m.terDate, reason });
    if (m.matched) result.ok++;
    else if (loaded.rowCount > 0 && KNOWN_NO_TER.has(String(t.directCode))) result.knownGaps = (result.knownGaps || 0) + 1; // expected: never reported
    else result.failed++;
  }
  const keep = new Set(scoped.map((t) => keyOf(t.code, t.plan)));
  const carried = prev.filter((r) => !keep.has(keyOf(r.code, r.plan)));
  await io.writeTer([...rows, ...carried]);
  result.completed = scoped.length; result.done = true;
  result.error = loaded.rowCount === 0 ? `phase=ter host=www.amfiindia.com ${loaded.notes[0] || 'no rows returned'}` : '';
  await saveRun({ done: scoped.length, total: scoped.length, finishedAt: result.done ? nowIso : '', cursorNote: `${result.ok} matched, ${result.failed} unmatched, ${result.knownGaps || 0} known gaps${loaded.notes.length ? `; ${loaded.notes.length} feed note(s)` : ''}`, lastError: loaded.notes[0] || '' });
  return result;
}
