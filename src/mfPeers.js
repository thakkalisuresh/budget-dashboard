// ════════════════════════════════════════════════════════════════════════════
// mfPeers.js — pure, deterministic "Fund vs peers" engine for the Indian mutual
// funds: returns, expense ratio, risk and consistency of each held fund against a
// curated peer list, per plan type (Direct vs Direct peers, Regular vs Regular).
// No React, no network, no LLM. Same spirit as mfInsights.js: every number carries
// its as-of date, wording is positional ("3rd of 16", "2.1 points above the median"),
// never a verdict. Rows come from the Invest-sheet tabs MfPeersConfig / MfPeers /
// MfTer (written by the data job, never by the app).
// ════════════════════════════════════════════════════════════════════════════
import { daysBetween } from './mfInsights.js';

export const PEERS_DISCLAIMER = 'Observations from public data, not investment advice.';

/** One home for every tunable. Persisted as settings.mfPeerThresholds (no editing UI yet). */
export const DEFAULT_MF_PEER_THRESHOLDS = Object.freeze({
  staleHeldDays: 14,     // held-fund rows older than this → "may be out of date"
  stalePeerDays: 45,     // peer rows older than this → same
  minPeersForRank: 5,    // comparable funds WITH data (held included) needed to print a rank
  minRollingWindows: 12, // monthly 1-year windows needed to print the consistency figure
});

/** Positive finite numbers survive; everything else falls back to the default. */
export function sanitizeMfPeerThresholds(raw) {
  const out = { ...DEFAULT_MF_PEER_THRESHOLDS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_MF_PEER_THRESHOLDS)) {
      const v = Number(raw[k]);
      if (raw[k] != null && raw[k] !== '' && Number.isFinite(v) && v > 0 && v <= 3650) out[k] = Math.round(v);
    }
  }
  return out;
}

export const MF_PEER_CATEGORIES = ['flexi-cap', 'small-cap', 'conglomerate',
  'retirement-aggressive-hybrid', 'retirement-aggressive', 'retirement-conservative-hybrid', 'retirement-conservative'];

/** Column lists are the contract with the data job (mfPeersApi.test.js pins them); the reader maps by header NAME, so column order may drift. */
export const MF_PEERS_CONFIG_COLUMNS = ['categoryKey', 'role', 'fundKey', 'amc', 'name', 'directCode', 'regularCode', 'isin', 'launch', 'note', 'weakMatch', 'active', 'comparisonJson'];
export const MF_PEERS_COLUMNS = ['asOf', 'categoryKey', 'role', 'fundKey', 'code', 'plan', 'name', 'firstNavDate', 'lastNavDate', 'nav', 'ret1yPct', 'ret3yPct', 'ret5yPct', 'volPct', 'maxDrawdownPct', 'rollingBeatPeerMedianPct', 'historyDays', 'status', 'reason', 'rollingWindows', 'windowStartDate', 'retWindowPct', 'windowReturnBasis', 'volWindowPct', 'maxDrawdownWindowPct', 'fetchedAt'];
export const MF_PEERS_RUN_COLUMNS = ['scope', 'cycle', 'startedAt', 'finishedAt', 'done', 'total', 'cursorNote', 'lastError'];
export const MF_TER_COLUMNS = ['asOf', 'code', 'plan', 'name', 'terPct', 'berPct', 'matchedName', 'matched'];

const PLANS = ['direct', 'regular'];
export const PLAN_LABELS = { direct: 'Direct', regular: 'Regular' };

// direction: 'high' = 1st is the highest number; 'low' = 1st is the lowest number.
export const METRICS = [
  { id: 'ret1y', group: 'returns', label: '1-year return', field: 'ret1yPct', direction: 'high', unit: '%' },
  { id: 'ret3y', group: 'returns', label: '3-year return (per year)', field: 'ret3yPct', direction: 'high', unit: '%' },
  { id: 'ret5y', group: 'returns', label: '5-year return (per year)', field: 'ret5yPct', direction: 'high', unit: '%' },
  { id: 'ter', group: 'cost', label: 'Expense ratio (TER)', field: 'terPct', direction: 'low', unit: '%' },
  { id: 'vol', group: 'risk', label: 'Volatility (3-year, annualised)', field: 'volPct', direction: 'low', unit: '%' },
  { id: 'mdd', group: 'risk', label: 'Largest fall (3-year)', field: 'maxDrawdownPct', direction: 'low', unit: '%', magnitude: true },
  { id: 'rolling', group: 'consistency', label: 'Rolling 1-year windows beating the peer median', field: 'rollingBeatPeerMedianPct', direction: 'high', unit: '%', heldOnly: true },
];
// Common-window variants (conglomerate): same units, no ranks.
const WINDOW_METRICS = [
  { id: 'retWindow', label: 'Return over the common window', field: 'retWindowPct', unit: '%' },
  { id: 'volWindow', label: 'Volatility over the common window', field: 'volWindowPct', unit: '%' },
  { id: 'mddWindow', label: 'Largest fall over the common window', field: 'maxDrawdownWindowPct', unit: '%', magnitude: true },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const text = (v) => String(v ?? '').trim();
const numOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
const asPlan = (v) => { const p = text(v).toLowerCase(); return PLANS.includes(p) ? p : null; };
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(text(v));

export function toIsoDate(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(Math.round((v - 25569) * 86_400_000)).toISOString().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(v));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Ordinal for ranks: 1st 2nd 3rd 4th 11th 12th 13th 21st … */
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

/** Competition ranking: rank = 1 + number of funds strictly ahead; tied = another fund has the identical value. */
export function rankOf(value, others, direction) {
  const ahead = others.filter(o => (direction === 'high' ? o > value : o < value)).length;
  return { rank: ahead + 1, of: others.length + 1, tied: others.some(o => o === value) };
}

// ── parsing (rows → objects); mfPeersApi.js reuses these ────────────────────
/** Sheet values (header row first) → objects keyed by header name; unknown headers are kept, missing ones read as undefined. */
export function rowsByHeader(values) {
  const [head, ...rest] = values || [];
  if (!Array.isArray(head)) return [];
  const names = head.map(text);
  return rest.map(r => Object.fromEntries(names.map((n, i) => [n, r?.[i]]))).filter(o => Object.values(o).some(v => text(v) !== ''));
}

const ROLES = ['held', 'peer', 'benchmark'];
const STATUSES = ['ok', 'stale', 'failed', 'insufficient-history'];

export function parseConfigRows(objs) {
  const out = [];
  for (const r of objs || []) {
    const categoryKey = text(r.categoryKey); const role = text(r.role).toLowerCase();
    if (!categoryKey || !ROLES.includes(role)) continue;
    const active = text(r.active);
    let comparison = null;
    if (text(r.comparisonJson)) { try { comparison = JSON.parse(text(r.comparisonJson)); } catch { comparison = null; } }
    out.push({
      categoryKey, role, fundKey: text(r.fundKey), amc: text(r.amc), name: text(r.name), directCode: text(r.directCode), regularCode: text(r.regularCode),
      isin: text(r.isin), launch: toIsoDate(r.launch), note: text(r.note), weakMatch: truthy(r.weakMatch), active: active === '' ? true : truthy(active), comparison,
    });
  }
  return out;
}

export function parsePeerRows(objs) {
  const out = [];
  for (const r of objs || []) {
    const asOf = toIsoDate(r.asOf); const code = text(r.code); const plan = asPlan(r.plan);
    const role = text(r.role).toLowerCase();
    if (!asOf || !code || !plan || !ROLES.includes(role)) continue;
    const status = text(r.status).toLowerCase();
    out.push({
      asOf, categoryKey: text(r.categoryKey), role, fundKey: text(r.fundKey), code, plan, name: text(r.name),
      firstNavDate: toIsoDate(r.firstNavDate), lastNavDate: toIsoDate(r.lastNavDate), nav: numOrNull(r.nav),
      ret1yPct: numOrNull(r.ret1yPct), ret3yPct: numOrNull(r.ret3yPct), ret5yPct: numOrNull(r.ret5yPct), volPct: numOrNull(r.volPct), maxDrawdownPct: numOrNull(r.maxDrawdownPct),
      rollingBeatPeerMedianPct: numOrNull(r.rollingBeatPeerMedianPct), rollingWindows: numOrNull(r.rollingWindows), historyDays: numOrNull(r.historyDays),
      status: STATUSES.includes(status) ? status : 'failed', reason: text(r.reason),
      windowStartDate: toIsoDate(r.windowStartDate), retWindowPct: numOrNull(r.retWindowPct), windowReturnBasis: text(r.windowReturnBasis),
      volWindowPct: numOrNull(r.volWindowPct), maxDrawdownWindowPct: numOrNull(r.maxDrawdownWindowPct), fetchedAt: text(r.fetchedAt),
    });
  }
  return out;
}

export function parseTerRows(objs) {
  const out = [];
  for (const r of objs || []) {
    const asOf = toIsoDate(r.asOf); const code = text(r.code); const plan = asPlan(r.plan);
    if (!asOf || !code || !plan) continue;
    out.push({ asOf, code, plan, name: text(r.name), terPct: numOrNull(r.terPct), berPct: numOrNull(r.berPct), matchedName: text(r.matchedName), matched: truthy(r.matched) });
  }
  return out;
}

/** MfPeersRun rows → { peers: { finishedAt, done, total, lastError } | null, ... } keyed by scope. */
export function parseRunRows(objs) {
  const out = {};
  for (const r of objs || []) {
    const scope = text(r.scope).toLowerCase();
    if (scope) out[scope] = { scope, cycle: text(r.cycle), startedAt: text(r.startedAt), finishedAt: text(r.finishedAt), done: numOrNull(r.done), total: numOrNull(r.total), lastError: text(r.lastError) };
  }
  return out;
}

/** Keep only the latest asOf per (code, plan). */
const latestBy = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows || []) { const k = keyOf(r); const c = m.get(k); if (!c || r.asOf > c.asOf) m.set(k, r); }
  return m;
};

// ── per-category comparison ──────────────────────────────────────────────────
function buildEntry({ cfgPeer, row, plan, ter, thresholds, today }) {
  const stale = row ? (daysBetween(row.asOf, today) > (row.role === 'held' ? thresholds.staleHeldDays : thresholds.stalePeerDays)) || row.status === 'stale' : false;
  const values = {};
  for (const m of METRICS) {
    if (m.id === 'ter') { values.ter = ter && ter.matched !== false && ter.terPct != null ? ter.terPct : null; continue; }
    let v = row ? row[m.field] : null;
    if (v != null && m.magnitude) v = Math.abs(v);
    if (m.id === 'rolling' && v != null && !(row.rollingWindows >= thresholds.minRollingWindows)) v = null;
    values[m.id] = v;
  }
  const win = {};
  for (const m of WINDOW_METRICS) { let v = row ? row[m.field] : null; if (v != null && m.magnitude) v = Math.abs(v); win[m.id] = v; }
  const failed = !row || row.status === 'failed';
  return {
    code: row?.code || (plan === 'direct' ? cfgPeer?.directCode : cfgPeer?.regularCode) || '', name: cfgPeer?.name || row?.name || '', amc: cfgPeer?.amc || '',
    role: cfgPeer?.role || row?.role, plan, note: cfgPeer?.note || '', weakMatch: !!cfgPeer?.weakMatch,
    status: failed ? 'failed' : row.status, reason: row?.reason || (row ? '' : 'no data row'), asOf: row?.asOf || null, lastNavDate: row?.lastNavDate || null,
    firstNavDate: row?.firstNavDate || null, windowReturnBasis: row?.windowReturnBasis || '', stale, values, window: win, windowStartDate: row?.windowStartDate || null, rollingWindows: row?.rollingWindows ?? null,
  };
}

function compare(held, peers, thresholds) {
  const usable = peers.filter(p => p.status !== 'failed');
  const metrics = {};
  for (const m of METRICS) {
    const value = held.values[m.id];
    if (m.heldOnly) { metrics[m.id] = { id: m.id, label: m.label, direction: m.direction, value, state: value == null ? 'no-history' : 'ok' }; continue; }
    const others = usable.map(p => p.values[m.id]).filter(v => v != null);
    const all = value != null ? [value, ...others] : others;
    const med = median(others); // peer median: peers only, held fund excluded
    const entry = {
      id: m.id, label: m.label, direction: m.direction, value,
      peerMedian: med == null ? null : round(med), min: all.length ? round(Math.min(...all)) : null, max: all.length ? round(Math.max(...all)) : null,
      withData: all.length, deltaVsMedian: value != null && med != null ? round(value - med) : null,
      position: value == null || med == null ? null : value > med ? 'above' : value < med ? 'below' : 'at',
      rank: null, of: null, tied: false, state: 'ok',
    };
    if (value == null) entry.state = 'no-history';
    else if (all.length < thresholds.minPeersForRank) entry.state = others.length ? 'too-few' : 'no-peers';
    else Object.assign(entry, rankOf(value, others, m.direction));
    metrics[m.id] = entry;
  }
  return metrics;
}

/**
 * @param funds   held funds: [{ planId, name, fundKey|null, plan: 'direct'|'regular'|null }] (fundKey from mfInsights.fundKeyFor)
 * @param config  parseConfigRows output     @param peerRows parsePeerRows output     @param terRows parseTerRows output
 */
export function buildMfPeers({ funds = [], config = [], peerRows = [], terRows = [], run = {}, thresholds = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const t = sanitizeMfPeerThresholds(thresholds);
  const notes = [];
  const rows = latestBy(peerRows, r => `${r.code}|${r.plan}`);
  const ters = latestBy(terRows, r => `${r.code}|${r.plan}`);
  const activeCfg = config.filter(c => c.active !== false);
  const out = [];
  const asOfAll = [];

  if (!activeCfg.length || !rows.size) {
    return { today, thresholds: t, status: 'unavailable', funds: [], notes: [{ id: 'unavailable', kind: 'unavailable', message: 'Peer data is not available yet.' }], asOf: [], disclaimer: PEERS_DISCLAIMER };
  }

  for (const f of funds) {
    if (!f.fundKey) {
      const sbi = /sbi/i.test(`${f.name} ${f.planId}`) && /retirement/i.test(`${f.name} ${f.planId}`);
      notes.push({ id: `unknown-${f.planId}`, kind: 'unknown', message: sbi
        ? `${f.name}: SBI sub-plan not confirmed, so the peer comparison is skipped for it.`
        : `${f.name}: not matched to a fund with a peer list, so the peer comparison is skipped for it.` });
      continue;
    }
    const heldCfg = activeCfg.find(c => c.role === 'held' && c.fundKey === f.fundKey);
    if (!heldCfg) { notes.push({ id: `nolist-${f.fundKey}`, kind: 'unknown', message: `${f.name}: no peer list is set up for this fund yet.` }); continue; }
    const catKey = heldCfg.categoryKey;
    const cfgs = activeCfg.filter(c => c.categoryKey === catKey);
    const peersCfg = cfgs.filter(c => c.role === 'peer');
    const benchCfg = cfgs.find(c => c.role === 'benchmark');
    const comparison = cfgs.map(c => c.comparison).find(Boolean) || null;
    const isConglomerate = catKey === 'conglomerate' || !!comparison?.window;
    const codeFor = (c, plan) => (plan === 'direct' ? c.directCode : c.regularCode);
    const mk = (c, plan) => { const code = codeFor(c, plan); return buildEntry({ cfgPeer: c, row: rows.get(`${code}|${plan}`), plan, ter: ters.get(`${code}|${plan}`), thresholds: t, today }); };

    const plans = {};
    for (const plan of PLANS) {
      const held = mk(heldCfg, plan);
      const peers = peersCfg.map(c => mk(c, plan));
      const bench = benchCfg ? mk(benchCfg, plan) : null;
      if (held.asOf) asOfAll.push(held.asOf);
      peers.forEach(p => p.asOf && asOfAll.push(p.asOf));
      const peersNotLoaded = peers.length > 0 && !peers.some(p => p.asOf);
      const excluded = peersNotLoaded ? [] : peers.filter(p => p.status === 'failed').map(p => ({ name: p.name, reason: p.reason || 'no data' }));
      plans[plan] = {
        plan, held, peers, benchmark: bench, excluded, peersNotLoaded,
        metrics: isConglomerate ? null : compare(held, peers, t),
        peerCount: peers.length, peersWithData: peers.filter(p => p.status !== 'failed').length,
        peerStale: peers.some(p => p.stale),
      };
    }

    // Direct vs Regular cost gap, per INR 1 lakh invested per year.
    const dTer = plans.direct.held.values.ter, rTer = plans.regular.held.values.ter;
    const gap = dTer != null && rTer != null ? { directPct: dTer, regularPct: rTer, gapPct: round(rTer - dTer), inrPerLakhPerYear: Math.round((rTer - dTer) * 1000) } : null;

    const peerMedianTer = {};
    for (const plan of PLANS) peerMedianTer[plan] = plans[plan].metrics?.ter?.peerMedian ?? null;

    const fundNotes = [];
    if (/^retirement-/.test(catKey)) fundNotes.push({ id: 'lock-in', kind: 'lock-in', message: 'NAV returns ignore the lock-in. SBI units are locked for 5 years from each instalment or until age 65, and the peers’ lock-in ages differ.' });
    if (isConglomerate) fundNotes.push({ id: 'weak', kind: 'weak', message: `Weak comparability, under 2 years of history: no ranks are shown. ${comparison?.window ? `Figures cover the common window ${windowLabel(comparison.window, plans.direct.held.windowStartDate)}.` : ''}`.trim() });
    for (const c of peersCfg) if (c.note && !isConglomerate) fundNotes.push({ id: `peer-note-${c.name}`, kind: 'peer-note', message: `${c.name}: ${c.note}.` });

    out.push({
      fundKey: f.fundKey, planId: f.planId, label: f.name, categoryKey: catKey, categoryLabel: heldCfg.name || catKey,
      heldPlan: asPlan(f.plan), heldPlanConfirmed: !!asPlan(f.plan), defaultPlan: asPlan(f.plan) || 'direct',
      kind: isConglomerate ? 'common-window' : 'ranked',
      windowBasis: isConglomerate ? windowBasisOf(plans) : null,
      window: isConglomerate ? { label: windowLabel(comparison?.window, plans.direct.held.windowStartDate), startDate: plans.direct.held.windowStartDate || windowStart(comparison?.window), benchmarkProxyCode: comparison?.benchmarkProxyCode || benchCfg?.directCode || '' } : null,
      plans, costGap: gap, peerMedianTer, notes: fundNotes,
    });
  }

  const asOf = [...new Set(asOfAll)].sort();
  const pr = run?.peers || null;
  const peersProgress = pr && pr.total != null && pr.done != null && pr.done < pr.total ? { done: pr.done, total: pr.total } : null;
  const peersFinishedAt = pr?.finishedAt ? pr.finishedAt.slice(0, 10) : null;
  return { today, thresholds: t, status: out.length ? 'ok' : 'no-funds', funds: out, notes, asOf, peersProgress, peersFinishedAt, disclaimer: PEERS_DISCLAIMER };
}

/** 'cumulative' | 'annualised' when every row with a window return agrees; 'mixed' (never shown side by side) otherwise; '' when none. */
function windowBasisOf(plans) {
  const set = new Set();
  for (const p of Object.values(plans)) for (const e of [p.held, ...p.peers, p.benchmark]) if (e && e.window.retWindow != null && e.windowReturnBasis) set.add(e.windowReturnBasis);
  return set.size === 0 ? '' : set.size === 1 ? [...set][0] : 'mixed';
}
function windowStart(w) { const m = /(\d{4}-\d{2}-\d{2})/.exec(String(w || '')); return m ? m[1] : ''; }
function windowLabel(w, start) { const s = start || windowStart(w); return s ? `since ${s}` : 'common window'; }
