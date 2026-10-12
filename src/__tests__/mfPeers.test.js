import { describe, it, expect } from 'vitest';
import { buildMfPeers, parseConfigRows, parsePeerRows, parseTerRows, parseRunRows, rowsByHeader, rankOf, median, ordinal, sanitizeMfPeerThresholds,
  MF_PEERS_COLUMNS, MF_PEERS_CONFIG_COLUMNS, MF_TER_COLUMNS } from '../mfPeers.js';

const TODAY = '2026-10-10';
const cfg = (o) => ({ categoryKey: 'flexi-cap', role: 'peer', fundKey: '', amc: '', name: '', directCode: '', regularCode: '', note: '', weakMatch: false, active: true, comparison: null, ...o });
const row = (o) => ({ asOf: '2026-10-09', categoryKey: 'flexi-cap', role: 'peer', fundKey: '', code: '', plan: 'direct', name: '', firstNavDate: '2013-01-02', lastNavDate: '2026-10-08',
  ret1yPct: null, ret3yPct: null, ret5yPct: null, volPct: null, maxDrawdownPct: null, rollingBeatPeerMedianPct: null, rollingWindows: null, status: 'ok', reason: '', windowStartDate: '', retWindowPct: null, volWindowPct: null, maxDrawdownWindowPct: null, ...o });
const ter = (code, plan, terPct, o = {}) => ({ asOf: '2026-10-09', code, plan, name: '', terPct, berPct: null, matched: true, ...o });

// held h(D=1,R=2) + 6 peers p1..p6 (D=11..16, R=21..26)
function flexi({ peerRet3 = [10, 12, 8, 14, 9, 11], heldRet3 = 13 } = {}) {
  const config = [cfg({ role: 'held', fundKey: 'absl-flexi-cap', name: 'ABSL Flexi Cap', directCode: '1', regularCode: '2' }),
    ...peerRet3.map((_, i) => cfg({ name: `Peer ${i + 1}`, directCode: String(11 + i), regularCode: String(21 + i) }))];
  const peerRows = [
    row({ role: 'held', fundKey: 'absl-flexi-cap', code: '1', plan: 'direct', ret3yPct: heldRet3, volPct: 15, maxDrawdownPct: -20, rollingBeatPeerMedianPct: 62, rollingWindows: 25 }),
    row({ role: 'held', fundKey: 'absl-flexi-cap', code: '2', plan: 'regular', ret3yPct: heldRet3 - 1, volPct: 15, maxDrawdownPct: -20 }),
    ...peerRet3.flatMap((r, i) => [
      row({ code: String(11 + i), plan: 'direct', ret3yPct: r, volPct: 12 + i, maxDrawdownPct: -15 - i }),
      row({ code: String(21 + i), plan: 'regular', ret3yPct: r - 1, volPct: 12 + i, maxDrawdownPct: -15 - i }),
    ])];
  const terRows = [ter('1', 'direct', 0.91), ter('2', 'regular', 1.68), ...peerRet3.flatMap((_, i) => [ter(String(11 + i), 'direct', 0.6 + i * 0.1), ter(String(21 + i), 'regular', 1.5 + i * 0.1)])];
  return { config, peerRows, terRows };
}
const heldFund = { planId: 'birla-flexi', name: 'ABSL Flexi Cap', fundKey: 'absl-flexi-cap', plan: null };
const run = (d, extra = {}) => buildMfPeers({ funds: [heldFund], ...d, today: TODAY, ...extra });

describe('contract', () => {
  it('pins the column lists agreed with the data job', () => {
    expect(MF_PEERS_CONFIG_COLUMNS).toEqual(['categoryKey', 'role', 'fundKey', 'amc', 'name', 'directCode', 'regularCode', 'isin', 'launch', 'note', 'weakMatch', 'active', 'comparisonJson']);
    expect(MF_PEERS_COLUMNS).toEqual(['asOf', 'categoryKey', 'role', 'fundKey', 'code', 'plan', 'name', 'firstNavDate', 'lastNavDate', 'nav', 'ret1yPct', 'ret3yPct', 'ret5yPct', 'volPct', 'maxDrawdownPct', 'rollingBeatPeerMedianPct', 'historyDays', 'status', 'reason', 'rollingWindows', 'windowStartDate', 'retWindowPct', 'windowReturnBasis', 'volWindowPct', 'maxDrawdownWindowPct', 'fetchedAt']);
    expect(MF_TER_COLUMNS).toEqual(['asOf', 'code', 'plan', 'name', 'terPct', 'berPct', 'matchedName', 'matched']);
  });
});

describe('helpers', () => {
  it('ranks with competition ties', () => {
    expect(rankOf(13, [10, 12, 8, 14], 'high')).toEqual({ rank: 2, of: 5, tied: false });
    expect(rankOf(12, [12, 8], 'high')).toEqual({ rank: 1, of: 3, tied: true });
    expect(rankOf(0.9, [0.6, 0.9, 1.2], 'low')).toEqual({ rank: 2, of: 4, tied: true });
  });
  it('median, ordinals', () => {
    expect(median([1, 3, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBeNull();
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 103].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '103rd']);
  });
  it('sanitises thresholds', () => {
    expect(sanitizeMfPeerThresholds({ staleHeldDays: 7, stalePeerDays: -1, minPeersForRank: 'x' })).toMatchObject({ staleHeldDays: 7, stalePeerDays: 45, minPeersForRank: 5, minRollingWindows: 12 });
  });
});

describe('ranked comparison', () => {
  it('ranks within the same plan type, with median and delta', () => {
    const r = run(flexi());
    const f = r.funds[0];
    expect(f.kind).toBe('ranked');
    const m = f.plans.direct.metrics.ret3y;
    expect(m).toMatchObject({ value: 13, rank: 2, of: 7, peerMedian: 10.5, deltaVsMedian: 2.5, position: 'above', state: 'ok' });
    expect(f.plans.regular.metrics.ret3y).toMatchObject({ value: 12, rank: 2, of: 7 });
  });
  it('uses 1st = lowest for TER, volatility and drawdown (magnitude)', () => {
    const f = run(flexi()).funds[0];
    expect(f.plans.direct.metrics.ter).toMatchObject({ rank: 5, of: 7, direction: 'low' }); // four peers at 0.6-0.9 are lower
    expect(f.plans.direct.metrics.vol).toMatchObject({ rank: 4, of: 7 });
    expect(f.plans.direct.metrics.mdd).toMatchObject({ value: 20, rank: 6, tied: true }); // largest fall as a magnitude
  });
  it('direct vs regular gap in rupees per lakh', () => {
    const f = run(flexi()).funds[0];
    expect(f.costGap).toEqual({ directPct: 0.91, regularPct: 1.68, gapPct: 0.77, inrPerLakhPerYear: 770 });
  });
  it('a plan never ranks against the other plan type', () => {
    const d = flexi(); d.peerRows = d.peerRows.filter(r => r.plan === 'direct' || r.role === 'held');
    const f = run(d).funds[0];
    expect(f.plans.regular.metrics.ret3y.state).toBe('no-peers');
  });
});

describe('edge cases', () => {
  it('missing TER shows as null and is left out of the median', () => {
    const d = flexi(); d.terRows = d.terRows.filter(t => t.code !== '11' && t.code !== '12');
    const m = run(d).funds[0].plans.direct.metrics.ter;
    expect(m.withData).toBe(5); // 4 peers + held
  });
  it('unmatched TER rows are n/a', () => {
    const d = flexi(); d.terRows = d.terRows.map(t => (t.code === '11' ? { ...t, matched: false } : t));
    expect(run(d).funds[0].plans.direct.peers[0].values.ter).toBeNull();
  });
  it('a failed peer is excluded from ranks and listed', () => {
    const d = flexi(); d.peerRows = d.peerRows.map(r => (r.code === '14' ? { ...r, status: 'failed', reason: 'truncated', ret3yPct: 99 } : r));
    const p = run(d).funds[0].plans.direct;
    expect(p.excluded).toEqual([{ name: 'Peer 4', reason: 'truncated' }]);
    expect(p.metrics.ret3y.of).toBe(6);
    expect(p.metrics.ret3y.rank).toBe(1);
  });
  it('a young fund has no 5y value and ranks only over those with data', () => {
    const d = flexi(); d.peerRows = d.peerRows.map(r => ({ ...r, ret5yPct: r.role === 'held' ? 9 : r.code === '11' ? null : 8 }));
    const m = run(d).funds[0].plans.direct.metrics.ret5y;
    expect(m.of).toBe(6);
  });
  it('held fund with no history still renders with a no-history state', () => {
    const d = flexi(); d.peerRows = d.peerRows.map(r => (r.role === 'held' ? { ...r, status: 'insufficient-history', ret3yPct: null, ret1yPct: null } : r));
    const f = run(d).funds[0];
    expect(f.plans.direct.metrics.ret3y.state).toBe('no-history');
    expect(f.plans.direct.metrics.ret3y.rank).toBeNull();
  });
  it('too few comparable funds gives value and median but no rank', () => {
    const f = run(flexi({ peerRet3: [10, 12, 8] })).funds[0];
    expect(f.plans.direct.metrics.ret3y).toMatchObject({ state: 'too-few', rank: null, peerMedian: 10 });
  });
  it('rolling consistency needs enough windows', () => {
    const d = flexi(); d.peerRows = d.peerRows.map(r => (r.role === 'held' && r.plan === 'direct' ? { ...r, rollingWindows: 8 } : r));
    expect(run(d).funds[0].plans.direct.metrics.rolling.state).toBe('no-history');
    expect(run(flexi()).funds[0].plans.direct.metrics.rolling).toMatchObject({ value: 62, state: 'ok' });
  });
  it('empty config or rows => unavailable', () => {
    expect(run({ config: [], peerRows: [], terRows: [] }).status).toBe('unavailable');
    expect(buildMfPeers({ funds: [heldFund], today: TODAY }).status).toBe('unavailable');
  });
  it('uses the latest asOf per code and plan', () => {
    const d = flexi(); d.peerRows.push(row({ asOf: '2026-09-01', role: 'held', fundKey: 'absl-flexi-cap', code: '1', plan: 'direct', ret3yPct: 1 }));
    expect(run(d).funds[0].plans.direct.metrics.ret3y.value).toBe(13);
  });
  it('flags staleness by asOf: held 14 days, peers 45 days', () => {
    const d = flexi(); d.peerRows = d.peerRows.map(r => ({ ...r, asOf: r.role === 'held' ? '2026-09-20' : '2026-08-20' }));
    const p = run(d).funds[0].plans.direct;
    expect(p.held.stale).toBe(true); expect(p.peerStale).toBe(true);
    expect(run(flexi()).funds[0].plans.direct.held.stale).toBe(false);
  });
  it('SBI sub-plan unknown skips with a note', () => {
    const r = buildMfPeers({ funds: [{ planId: 'sbi-retirement', name: 'SBI Retirement Benefit Fund', fundKey: null }], ...flexi(), today: TODAY });
    expect(r.funds).toHaveLength(0);
    expect(r.notes[0].message).toMatch(/SBI sub-plan not confirmed/);
  });
  it('retirement carries the lock-in note once', () => {
    const config = [cfg({ categoryKey: 'retirement-aggressive', role: 'held', fundKey: 'sbi-retirement-aggressive', name: 'SBI Ret Aggr', directCode: '1', regularCode: '2' })];
    const peerRows = [row({ categoryKey: 'retirement-aggressive', role: 'held', fundKey: 'sbi-retirement-aggressive', code: '1', ret3yPct: 10 })];
    const r = buildMfPeers({ funds: [{ planId: 'x', name: 'SBI Ret Aggr', fundKey: 'sbi-retirement-aggressive' }], config, peerRows, terRows: [], today: TODAY });
    expect(r.funds[0].notes.filter(n => n.kind === 'lock-in')).toHaveLength(1);
  });
  it('peer notes (overseas equity) are carried', () => {
    const d = flexi(); d.config[1].note = 'includes overseas equity';
    expect(run(d).funds[0].notes.some(n => /overseas equity/.test(n.message))).toBe(true);
  });
  it('plan held defaults to the mapped plan, else direct with an unconfirmed flag', () => {
    expect(run(flexi()).funds[0]).toMatchObject({ defaultPlan: 'direct', heldPlanConfirmed: false });
    const r = buildMfPeers({ funds: [{ ...heldFund, plan: 'regular' }], ...flexi(), today: TODAY });
    expect(r.funds[0]).toMatchObject({ defaultPlan: 'regular', heldPlanConfirmed: true });
  });
});

describe('conglomerate (common window, no ranks)', () => {
  const config = [
    cfg({ categoryKey: 'conglomerate', role: 'held', fundKey: 'absl-conglomerate', name: 'ABSL Conglomerate', directCode: '1', regularCode: '2' }),
    cfg({ categoryKey: 'conglomerate', name: 'ICICI Conglomerate', directCode: '11', regularCode: '21', weakMatch: true, comparison: { window: 'common-since-2025-10-27', benchmarkProxyCode: '31', label: 'weak comparability', thematicMedian: false } }),
    cfg({ categoryKey: 'conglomerate', role: 'benchmark', name: 'Tata BSE Select Business Groups Index', directCode: '31', regularCode: '32', weakMatch: true }),
  ];
  const w = { windowStartDate: '2025-10-27', historyDays: 350, windowReturnBasis: 'cumulative' };
  const peerRows = [
    row({ categoryKey: 'conglomerate', role: 'held', fundKey: 'absl-conglomerate', code: '1', retWindowPct: 4, volWindowPct: 14, maxDrawdownWindowPct: -9, ...w }),
    row({ categoryKey: 'conglomerate', code: '11', retWindowPct: 6, volWindowPct: 13, maxDrawdownWindowPct: -8, ...w }),
    row({ categoryKey: 'conglomerate', role: 'benchmark', code: '31', retWindowPct: 5, volWindowPct: 12, maxDrawdownWindowPct: -7, ...w }),
  ];
  it('window basis is reported once, and mixed bases are never merged', () => {
    const mk = (basis2) => buildMfPeers({ funds: [{ planId: 'b', name: 'ABSL Conglomerate', fundKey: 'absl-conglomerate' }], config,
      peerRows: peerRows.map(r => ({ ...r, windowReturnBasis: r.code === '11' ? basis2 : 'cumulative' })), terRows: [], today: TODAY }).funds[0];
    expect(mk('cumulative').windowBasis).toBe('cumulative');
    expect(mk('annualised').windowBasis).toBe('mixed');
  });
  it('a blank window (no NAV on or before the start) stays blank and keeps its reason', () => {
    const rows = peerRows.map(r => (r.code === '11' ? { ...r, retWindowPct: null, volWindowPct: null, maxDrawdownWindowPct: null, windowStartDate: '', reason: 'history starts after the window start' } : r));
    const e = buildMfPeers({ funds: [{ planId: 'b', name: 'ABSL Conglomerate', fundKey: 'absl-conglomerate' }], config, peerRows: rows, terRows: [], today: TODAY }).funds[0].plans.direct.peers[0];
    expect(e.window.retWindow).toBeNull(); expect(e.reason).toMatch(/history starts/);
  });
  it('shows window figures, benchmark proxy, no ranks', () => {
    const f = buildMfPeers({ funds: [{ planId: 'b', name: 'ABSL Conglomerate', fundKey: 'absl-conglomerate' }], config, peerRows, terRows: [], today: TODAY }).funds[0];
    expect(f.kind).toBe('common-window');
    expect(f.window).toMatchObject({ startDate: '2025-10-27', benchmarkProxyCode: '31' });
    expect(f.plans.direct.metrics).toBeNull();
    expect(f.plans.direct.held.window.retWindow).toBe(4);
    expect(f.plans.direct.benchmark.window.retWindow).toBe(5);
    expect(f.plans.direct.peers[0].weakMatch).toBe(true);
    expect(f.notes.some(n => /Weak comparability/.test(n.message))).toBe(true);
  });
});

describe('parsing', () => {
  it('maps by header name, so column order does not matter and extra columns are ignored', () => {
    const cfgRows = rowsByHeader([['name', 'categoryKey', 'role', 'weakMatch', 'extra', 'comparisonJson', 'active'], ['N', 'flexi-cap', 'Peer', 'TRUE', 'x', '{"a":1}', ''], ['', '', '', '', '', '', ''], ['Z', 'c', 'weird']]);
    const c = parseConfigRows(cfgRows);
    expect(c).toHaveLength(1); expect(c[0]).toMatchObject({ role: 'peer', weakMatch: true, active: true, comparison: { a: 1 } });
    const p = parsePeerRows(rowsByHeader([['plan', 'asOf', 'code', 'role', 'ret1yPct', 'status', 'fetchedAt'], ['Direct', '2026-10-09', '1', 'held', 1.5, 'ok', '2026-10-09T01:00Z'], ['x']]));
    expect(p).toHaveLength(1); expect(p[0]).toMatchObject({ plan: 'direct', ret1yPct: 1.5, ret3yPct: null, fetchedAt: '2026-10-09T01:00Z' });
    expect(parseTerRows(rowsByHeader([['asOf', 'code', 'plan', 'terPct', 'matched'], ['2026-10-09', '1', 'regular', 1.68, 'TRUE']]))[0]).toMatchObject({ matched: true, terPct: 1.68 });
    expect(parseRunRows(rowsByHeader([['scope', 'finishedAt', 'done', 'total'], ['peers', '2026-10-09T02:00:00Z', 20, 60]])).peers).toMatchObject({ done: 20, total: 60 });
  });
  it('treats an unknown status as failed', () => {
    expect(parsePeerRows([{ asOf: '2026-10-09', code: '1', plan: 'direct', role: 'peer', status: 'weird' }])[0].status).toBe('failed');
  });
});

describe('first run / peers not loaded yet', () => {
  it('held rows without any peer rows render, flagged as peers-not-loaded, with progress', () => {
    const d = flexi(); d.peerRows = d.peerRows.filter(r => r.role === 'held');
    const r = run(d, { run: { peers: { done: 12, total: 60, finishedAt: '' } } });
    expect(r.funds[0].plans.direct.peersNotLoaded).toBe(true);
    expect(r.funds[0].plans.direct.excluded).toEqual([]);
    expect(r.peersProgress).toEqual({ done: 12, total: 60 });
    expect(r.funds[0].plans.direct.metrics.ret3y.state).toBe('no-peers');
  });
  it('exposes the peers finished date for the badge', () => {
    expect(run(flexi(), { run: { peers: { done: 60, total: 60, finishedAt: '2026-10-09T02:00:00Z' } } }).peersFinishedAt).toBe('2026-10-09');
  });
});

describe('partial data (only some rows or tabs exist)', () => {
  it('held row failed with a reason, no peers, no TER: still builds, reason kept', () => {
    const d = flexi();
    d.peerRows = d.peerRows.filter(r => r.role === 'held').map(r => ({ ...r, status: 'failed', reason: 'mfapi timeout', ret3yPct: null, volPct: null }));
    d.terRows = [];
    const f = run(d).funds[0];
    expect(f.plans.direct.held).toMatchObject({ status: 'failed', reason: 'mfapi timeout' });
    expect(f.plans.direct.metrics.ter.state).toBe('no-history');
    expect(f.costGap).toBeNull();
  });
  it('config without any MfPeers row is "unavailable", not a crash', () => {
    expect(run({ config: flexi().config, peerRows: [], terRows: [] }).status).toBe('unavailable');
  });
  it('held fund missing from MfPeers while peers exist renders with a no-data reason', () => {
    const d = flexi(); d.peerRows = d.peerRows.filter(r => r.role !== 'held');
    const h = run(d).funds[0].plans.direct.held;
    expect(h).toMatchObject({ status: 'failed', reason: 'no data row' });
  });
  it('a stale row keeps its numbers and is flagged', () => {
    const d = flexi(); d.peerRows = d.peerRows.map(r => (r.code === '1' ? { ...r, status: 'stale', reason: 'fetch failed' } : r));
    const h = run(d).funds[0].plans.direct.held;
    expect(h).toMatchObject({ stale: true, status: 'stale', reason: 'fetch failed' });
    expect(h.values.ret3y).toBe(13);
  });
});
