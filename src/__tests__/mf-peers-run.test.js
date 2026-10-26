import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  runScope, valuesToPeers, valuesToSeries, valuesToRun, valuesToTer, valuesToConfig,
  peersToValues, seriesToValues, runToValues, terToValues, CONFIG_COLUMNS, PEERS_COLUMNS,
} from '../../functions/lib/_mf-peers.mjs';
import { PeersFetchError } from '../../functions/lib/mf-peers/_http.mjs';

const fx = (n) => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/mf-peers', n), 'utf8');

/* ── in-memory Invest sheet (raw values, so the sheet round-trip is exercised) ── */
function memIo(init = {}) {
  const s = { config: [], peers: [], ter: [], series: [], run: [], sip: [], ...init };
  const calls = [];
  const copy = (a) => a.map((r) => [...r]);
  return {
    s, calls,
    io: {
      read: async () => ({ config: copy(s.config), peers: copy(s.peers), ter: copy(s.ter), series: copy(s.series), run: copy(s.run), sip: copy(s.sip) }),
      writeConfig: async (v) => { calls.push('config'); s.config = copy(v); },
      writePeers: async (rows) => { calls.push('peers'); s.peers = peersToValues(rows); },
      writeSeries: async (rows) => { calls.push('series'); s.series = seriesToValues(rows); },
      writeTer: async (rows) => { calls.push('ter'); s.ter = terToValues(rows); },
      writeRun: async (rows) => { calls.push('run'); s.run = runToValues(rows); },
    },
  };
}

/* ── synthetic mfapi bodies (business days, newest first, DD-MM-YYYY) ── */
function body(start, end, base, daily) {
  const rows = []; let nav = base; let t = Date.parse(`${start}T00:00:00Z`); const e = Date.parse(`${end}T00:00:00Z`); let i = 0;
  for (; t <= e; t += 86_400_000) {
    const d = new Date(t); const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    nav *= 1 + daily + 0.002 * Math.sin(i++ * 1.7);
    const iso = d.toISOString().slice(0, 10);
    rows.push({ date: `${iso.slice(8)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`, nav: nav.toFixed(4) });
  }
  return JSON.stringify({ meta: { scheme_code: 1 }, data: rows.reverse(), status: 'SUCCESS' });
}

const NOW = new Date('2026-10-11T04:00:00+05:30'); // Sunday 04:00 IST
const NAV_DATE = '2026-10-09';

function cfgRow(categoryKey, role, fundKey, name, d, r, extra = {}) {
  const o = { note: '', weakMatch: false, active: true, comparisonJson: '', ...extra };
  return [categoryKey, role, fundKey, 'AMC', name, d, r, '', '2020-01-01', o.note, o.weakMatch, o.active, o.comparisonJson];
}

/** deps: bodies by code (string) or Error; everything else gets `defaultBody`. */
function makeDeps({ bodies = {}, codes, navDate = NAV_DATE, amfi = null, clockStep = 0 } = {}) {
  let t = 0;
  const seen = [];
  const client = {
    getText: vi.fn(async (url) => {
      t += clockStep;
      const m = /\/mf\/(\d+)$/.exec(url);
      if (m) {
        seen.push(m[1]);
        const b = bodies[m[1]];
        if (b instanceof Error) throw b;
        if (Array.isArray(b)) { const next = b.shift(); if (next instanceof Error) throw next; return { status: 200, text: next }; }
        return { status: 200, text: b ?? bodies.default };
      }
      if (url.includes('DownloadNAVHistoryReport') && amfi) return { status: 200, text: amfi };
      throw new Error(`unexpected url ${url}`);
    }),
  };
  return {
    client, seen, sleep: vi.fn(async () => {}), clock: () => t,
    getNavAll: async () => new Map(codes.map((c) => [String(c), { date: navDate }])),
  };
}

const FLEXI = [
  cfgRow('cat-a', 'held', 'held-a', 'Held A', '1001', '1002'),
  cfgRow('cat-a', 'peer', 'peer-2001', 'Peer 1', '2001', '2002'),
  cfgRow('cat-a', 'peer', 'peer-2003', 'Peer 2', '2003', '2004'),
  cfgRow('cat-a', 'peer', 'peer-2005', 'Peer 3', '2005', '2006'),
  cfgRow('cat-a', 'peer', 'peer-2007', 'Peer 4', '2007', '2008'),
  cfgRow('cat-a', 'benchmark', 'peer-3001', 'Bench', '3001', '3002'),
];
const FLEXI_CODES = ['1001', '1002', '2001', '2002', '2003', '2004', '2005', '2006', '2007', '2008', '3001', '3002'];
const flexiBodies = () => ({
  1001: body('2020-01-01', NAV_DATE, 100, 0.0006), 1002: body('2020-01-01', NAV_DATE, 100, 0.00055),
  default: body('2020-01-01', NAV_DATE, 100, 0.0003),
  3001: body('2020-01-01', NAV_DATE, 100, 0.002), 3002: body('2020-01-01', NAV_DATE, 100, 0.002), // a runaway benchmark: must not move the peer median
});

const rowsOf = (m) => valuesToPeers(m.s.peers);
const byCode = (rows, code) => rows.filter((r) => r.code === code);

describe('seed from the approved config', () => {
  it('seeds MfPeersConfig only while the tab is empty and never overwrites a user edit afterwards', async () => {
    const m = memIo();
    const deps = makeDeps({ codes: [] }); // nothing is in NAVAll → every code fails fast, no network
    const r1 = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(m.calls.filter((c) => c === 'config')).toHaveLength(1);
    expect(m.s.config).toHaveLength(58);
    expect(m.s.config[0]).toHaveLength(CONFIG_COLUMNS.length);
    expect(r1.failed).toBe(20);
    // the user flips a peer off and edits a note
    m.s.config[1][11] = false; m.s.config[1][9] = 'my note';
    const before = JSON.stringify(m.s.config);
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(m.calls.filter((c) => c === 'config')).toHaveLength(1);
    expect(JSON.stringify(m.s.config)).toBe(before);
  });
});

describe('held run: validation, metrics, status', () => {
  it('writes one row per held code and plan with metrics, ok status, asOf = run date (IST), fetchedAt, a series row and a run row', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r).toMatchObject({ scope: 'held', cycle: 'W2026-10-11', ok: 2, failed: 0, done: true, total: 2, completed: 2 });
    const rows = rowsOf(m);
    expect(rows.map((x) => [x.code, x.plan, x.role, x.fundKey, x.status])).toEqual([['1001', 'direct', 'held', 'held-a', 'ok'], ['1002', 'regular', 'held', 'held-a', 'ok']]);
    const d = rows[0];
    expect(d.asOf).toBe('2026-10-11');
    expect(d.lastNavDate).toBe(NAV_DATE);
    expect(d.fetchedAt).toBe(NOW.toISOString());
    expect(d.firstNavDate).toBe('2020-01-01');
    expect(d.ret1yPct).toBeGreaterThan(10); expect(d.ret3yPct).not.toBeNull(); expect(d.ret5yPct).not.toBeNull();
    expect(d.volPct).toBeGreaterThan(0); expect(d.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(d.historyDays).toBeGreaterThan(2000);
    expect(d.retWindowPct).toBeNull(); expect(d.windowReturnBasis).toBe('');
    const ser = valuesToSeries(m.s.series);
    expect(ser.map((x) => [x.code, x.lastMonthEnd, x.n])).toEqual([['1001', '2026-09-30', 61], ['1002', '2026-09-30', 61]]);
    expect(valuesToRun(m.s.run)).toEqual([expect.objectContaining({ scope: 'held', cycle: 'W2026-10-11', done: 2, total: 2, finishedAt: NOW.toISOString(), lastError: '' })]);
  });

  it('truncated body → one retry (5 s pause) → ok', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const good = body('2020-01-01', NAV_DATE, 100, 0.0006);
    const deps = makeDeps({ bodies: { 1001: [fx('mfapi-108594.truncated.json'), good], default: good }, codes: FLEXI_CODES });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r.failed).toBe(0);
    expect(deps.seen.filter((c) => c === '1001')).toHaveLength(2);
    expect(deps.sleep).toHaveBeenCalledWith(5000);
  });

  it('a lagging or broken code keeps its last good row (asOf and fetchedAt NOT bumped), with phase/host/cause in the reason; other codes are unaffected', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const ok = flexiBodies();
    await runScope({ scope: 'held', io: m.io, deps: makeDeps({ bodies: ok, codes: FLEXI_CODES }), now: new Date('2026-10-04T04:00:00+05:30') });
    const first = rowsOf(m);
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const deps = makeDeps({
      bodies: { 1001: new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', cause: 'ECONNRESET: read ECONNRESET' }), default: ok[1002] },
      codes: FLEXI_CODES,
    });
    expect(cause.code).toBe('ECONNRESET');
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r).toMatchObject({ ok: 1, failed: 1 });
    const rows = rowsOf(m);
    const bad = byCode(rows, '1001'); const good = byCode(rows, '1002');
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ status: 'failed', asOf: '2026-10-04', fetchedAt: first[0].fetchedAt, ret1yPct: first[0].ret1yPct });
    expect(bad[0].reason).toMatch(/phase=nav-fetch host=api\.mfapi\.in cause=ECONNRESET/);
    expect(good.map((x) => x.asOf)).toEqual(['2026-10-11', '2026-10-04']);
    expect(r.failures[0]).toMatchObject({ code: '1001', status: 'failed' });
    expect(valuesToRun(m.s.run)[0].lastError).toMatch(/phase=nav-fetch/);
  });

  it('mfapi lagging AMFI over a weekend (Fri NAV, Mon NAVAll) is fine: status ok, blank reason, lastNavDate = mfapi\'s date', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, navDate: '2026-10-12' });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r).toMatchObject({ ok: 2, stale: 0, failed: 0 });
    expect(rowsOf(m)[0]).toMatchObject({ status: 'ok', reason: '', lastNavDate: NAV_DATE });
  });

  it('a lag beyond the 5-day tolerance is stale, with no retry, and the previous good row stays', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    await runScope({ scope: 'held', io: m.io, deps: makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES }), now: new Date('2026-10-04T04:00:00+05:30') });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, navDate: '2026-10-16' }); // 7 days ahead of what mfapi serves
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r).toMatchObject({ stale: 2, failed: 0, ok: 0 });
    expect(deps.seen).toEqual(['1001', '1002']); // one request each: no retry
    expect(deps.sleep).not.toHaveBeenCalled();
    const rows = rowsOf(m);
    expect(rows.every((x) => x.status === 'stale' && x.asOf === '2026-10-04' && x.ret1yPct !== null)).toBe(true);
    expect(rows[0].reason).toMatch(/7 days older than AMFI NAVAll 2026-10-16/);
  });

  it('with no previous good row a lag leaves a `pending` placeholder (never a stale row with empty metrics)', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, navDate: '2026-10-20' });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const rows = rowsOf(m);
    expect(rows.map((x) => x.status)).toEqual(['pending', 'pending']);
    expect(rows[0]).toMatchObject({ asOf: '', fetchedAt: '', ret1yPct: null });
    expect(rows[0].reason).toMatch(/older than AMFI NAVAll 2026-10-20/);
    // the next tick (source caught up) replaces the placeholders
    const ok = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'held', io: m.io, deps: ok, now: new Date('2026-10-12T04:00:00+05:30') });
    expect(rowsOf(m).map((x) => [x.status, x.asOf])).toEqual([['ok', '2026-10-12'], ['ok', '2026-10-12']]);
  });

  it('placeholders already on the sheet as `stale` (written before `pending` existed) are read as pending', async () => {
    const stalePlaceholder = PEERS_COLUMNS.map((c) => (c === 'status' ? 'stale' : c === 'code' ? '1001' : c === 'plan' ? 'direct' : ''));
    expect(valuesToPeers([stalePlaceholder])[0].status).toBe('pending');
    const keep = PEERS_COLUMNS.map((c) => (c === 'status' ? 'stale' : c === 'code' ? '1001' : c === 'plan' ? 'direct' : c === 'asOf' ? '2026-10-04' : ''));
    expect(valuesToPeers([keep])[0].status).toBe('stale');
  });

  it('a code missing from NAVAll fails (placeholder row, no asOf) and costs no request', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: ['1001'] });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r).toMatchObject({ ok: 1, failed: 1 });
    expect(rowsOf(m).find((x) => x.code === '1002')).toMatchObject({ status: 'failed', asOf: '', fetchedAt: '' });
    expect(deps.seen).toEqual(['1001']);
  });

  it('NAVAll unavailable is recorded, never thrown', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = { ...makeDeps({ codes: [] }), getNavAll: async () => { throw new Error('fetch failed'); } };
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r.error).toMatch(/phase=nav-check host=portal\.amfiindia\.com fetch failed/);
    expect(valuesToRun(m.s.run)[0].lastError).toMatch(/nav-check/);
  });

  it('flags a short history as insufficient-history and keeps blank (not 0) returns', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: { default: body('2026-04-01', NAV_DATE, 10, 0.0004) }, codes: FLEXI_CODES });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const d = rowsOf(m)[0];
    expect(d.status).toBe('insufficient-history');
    expect(d.reason).toMatch(/history is \d+ days \(< 1 year since 2026-04-01\)/);
    expect(d.ret1yPct).toBeNull(); expect(d.ret3yPct).toBeNull(); expect(d.volPct).toBeNull();
  });

  it('flags a > 15% one-day jump inside the window in the reason without dropping the row', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const j = JSON.parse(body('2020-01-01', NAV_DATE, 100, 0.0004));
    j.data[200].nav = String(Number(j.data[200].nav) * 1.4);
    const deps = makeDeps({ bodies: { default: JSON.stringify(j) }, codes: FLEXI_CODES });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const d = rowsOf(m)[0];
    expect(d.status).toBe('ok');
    expect(d.reason).toMatch(/one-day NAV move > 15%/);
  });
});

describe('idempotence, retention, resume', () => {
  it('a second run in the same cycle makes no requests; force replaces the same-asOf row (still one row per code/plan)', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const n = deps.client.getText.mock.calls.length;
    const r2 = await runScope({ scope: 'held', io: m.io, deps, now: new Date('2026-10-12T04:00:00+05:30') });
    expect(deps.client.getText.mock.calls.length).toBe(n);
    expect(r2).toMatchObject({ skipped: 2, done: true });
    await runScope({ scope: 'held', io: m.io, deps, now: new Date('2026-10-13T04:00:00+05:30'), force: true });
    expect(rowsOf(m)).toHaveLength(4); // 2 asOf values x 2 codes
    await runScope({ scope: 'held', io: m.io, deps, now: new Date('2026-10-13T05:00:00+05:30'), force: true });
    expect(rowsOf(m)).toHaveLength(4); // same asOf: replaced, not appended
  });

  it('keeps only the latest 2 asOf per code/plan across weekly runs', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    for (const d of ['2026-10-04', '2026-10-11', '2026-10-18']) await runScope({ scope: 'held', io: m.io, deps, now: new Date(`${d}T04:00:00+05:30`) });
    expect(byCode(rowsOf(m), '1001').map((x) => x.asOf)).toEqual(['2026-10-18', '2026-10-11']);
  });

  it('stops at the time budget, records progress, and the next invocation resumes only the leftovers', async () => {
    const m = memIo({ config: FLEXI });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, clockStep: 100 });
    const r1 = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30'), budgetMs: 450 });
    expect(r1).toMatchObject({ done: false, total: 10, remaining: 5, ok: 5 });
    const run1 = valuesToRun(m.s.run)[0];
    expect(run1).toMatchObject({ scope: 'peers', cycle: '2026-10', done: 5, total: 10, finishedAt: '' });
    expect(run1.cursorNote).toMatch(/time budget reached/);
    const first = deps.seen.length;
    const r2 = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-03T03:00:00+05:30'), budgetMs: 100_000 });
    expect(r2).toMatchObject({ done: true, ok: 5, skipped: 5, remaining: 0 });
    expect(deps.seen.slice(first)).toHaveLength(5);
    expect(new Set(deps.seen).size).toBe(10); // no code fetched twice
    expect(valuesToRun(m.s.run)[0]).toMatchObject({ done: 10, total: 10 });
    expect(valuesToRun(m.s.run)[0].finishedAt).not.toBe('');
  });

  it('retries a failed code on the next day of the same cycle (a failure never counts as done)', async () => {
    const m = memIo({ config: [FLEXI[1]] , });
    m.s.config = [FLEXI[0], FLEXI[1]];
    const bodies = flexiBodies();
    const flaky = { ...bodies, 2001: [new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', status: 502 }), new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', status: 502 }), bodies.default] };
    const deps = makeDeps({ bodies: flaky, codes: FLEXI_CODES });
    const r1 = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30') });
    expect(r1).toMatchObject({ failed: 1, done: false });
    const r2 = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-03T03:00:00+05:30') });
    expect(r2).toMatchObject({ failed: 0, ok: 1, done: true });
    expect(byCode(rowsOf(m), '2001')[0]).toMatchObject({ status: 'ok', asOf: '2026-10-03' });
  });

  it('checkpoints the sheet during a long run (a crash loses at most a batch)', async () => {
    const peers = Array.from({ length: 14 }, (_, i) => cfgRow('cat-a', 'peer', `p${i}`, `P${i}`, String(5000 + 2 * i), String(5001 + 2 * i)));
    const codes = peers.flatMap((p) => [p[5], p[6]]);
    const m = memIo({ config: [FLEXI[0], ...peers] });
    const deps = makeDeps({ bodies: { default: body('2020-01-01', NAV_DATE, 100, 0.0003) }, codes: [...codes, '1001', '1002'] });
    await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30') });
    expect(m.calls.filter((c) => c === 'peers').length).toBeGreaterThanOrEqual(2);
    expect(rowsOf(m)).toHaveLength(28);
  });
});

describe('lag circuit breaker', () => {
  it('after 3 consecutive lag-stale codes the run stops fetching (no budget burned), says why, and the next tick finishes the cycle', async () => {
    const m = memIo({ config: FLEXI });
    const behind = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, navDate: '2026-10-20' });
    const r1 = await runScope({ scope: 'peers', io: m.io, deps: behind, now: new Date('2026-10-12T03:00:00+05:30') });
    expect(behind.seen).toHaveLength(3);
    expect(r1).toMatchObject({ done: false, stale: 3, remaining: 7, ok: 0 });
    const run = valuesToRun(m.s.run)[0];
    expect(run.cursorNote).toMatch(/mfapi is 11 days behind AMFI NAVAll \(3 codes in a row\); paused until the next tick/);
    expect(run.finishedAt).toBe('');
    expect(rowsOf(m).filter((x) => x.status === 'pending')).toHaveLength(3);
    const caughtUp = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    const r2 = await runScope({ scope: 'peers', io: m.io, deps: caughtUp, now: new Date('2026-10-13T03:00:00+05:30') });
    expect(r2).toMatchObject({ done: true, ok: 10, stale: 0 });
    expect(rowsOf(m).every((x) => x.status === 'ok')).toBe(true);
  });

  it('a success resets the streak, and non-lag failures never trip the breaker', async () => {
    const m = memIo({ config: FLEXI });
    const b = flexiBodies();
    const err = () => new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', status: 502 });
    const bodies = { ...b };
    for (const c of ['2001', '2002', '2003', '2004', '2005']) bodies[c] = [err(), err()];
    const deps = makeDeps({ bodies, codes: FLEXI_CODES });
    const r = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-12T03:00:00+05:30') });
    expect(r).toMatchObject({ failed: 5, ok: 5, remaining: 0 }); // five real failures in a row did not pause the run
  });
});

describe('daily schedules: no-op / first run / resume', () => {
  it('a complete cycle is a true no-op: no NAVAll download, no request, no sheet write', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const navAll = vi.fn(deps.getNavAll); const calls = deps.client.getText.mock.calls.length; const writes = m.calls.length;
    const r = await runScope({ scope: 'held', io: m.io, deps: { ...deps, getNavAll: navAll }, now: new Date('2026-10-14T04:00:00+05:30') });
    expect(r).toMatchObject({ done: true, skipped: 2, completed: 2, ok: 0, failed: 0 });
    expect(navAll).not.toHaveBeenCalled();
    expect(deps.client.getText.mock.calls.length).toBe(calls);
    expect(m.calls.length).toBe(writes);
  });
  it('the next IST week (Sunday) is a new cycle and refreshes again', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const calls = deps.client.getText.mock.calls.length;
    await runScope({ scope: 'held', io: m.io, deps, now: new Date('2026-10-17T04:00:00+05:30') }); // Saturday: still the same cycle
    expect(deps.client.getText.mock.calls.length).toBe(calls);
    const r = await runScope({ scope: 'held', io: m.io, deps, now: new Date('2026-10-18T04:00:00+05:30') });
    expect(r.ok).toBe(2);
    expect(byCode(rowsOf(m), '1001').map((x) => x.asOf)).toEqual(['2026-10-18', '2026-10-11']);
  });
  it('first run: no held rows yet → runs on the very first tick, whatever day it is', async () => {
    const m = memIo({ config: [FLEXI[0]] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: new Date('2026-10-14T04:00:00+05:30') }); // a Wednesday
    expect(r).toMatchObject({ ok: 2, done: true });
    expect(rowsOf(m)).toHaveLength(2);
  });
  it('peers: a month completes over several daily ticks (budget → resume), then stays quiet until the 1st', async () => {
    const m = memIo({ config: FLEXI });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, clockStep: 100 });
    const day = (d) => new Date(`2026-10-${d}T03:00:00+05:30`);
    const r1 = await runScope({ scope: 'peers', io: m.io, deps, now: day('12'), budgetMs: 450 });
    expect(r1.done).toBe(false);
    const r2 = await runScope({ scope: 'peers', io: m.io, deps, now: day('13'), budgetMs: 450 });
    expect(r2).toMatchObject({ done: true, skipped: 5, ok: 5 });
    const calls = deps.client.getText.mock.calls.length;
    for (const d of ['14', '20', '31']) expect((await runScope({ scope: 'peers', io: m.io, deps, now: day(d), budgetMs: 450 })).done).toBe(true);
    expect(deps.client.getText.mock.calls.length).toBe(calls);
    const nov = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-11-01T03:00:00+05:30'), budgetMs: 450 });
    expect(nov.done).toBe(false); // a new month is a new cycle
    expect(nov.ok).toBe(5);
  });
  it('a failed code never counts as done, so the daily tick retries it (and only it)', async () => {
    const m = memIo({ config: [FLEXI[0], FLEXI[1]] });
    const b = flexiBodies();
    const deps = makeDeps({ bodies: { ...b, 2001: [new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', status: 502 }), new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', status: 502 }), b.default] }, codes: FLEXI_CODES });
    await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-12T03:00:00+05:30') });
    deps.seen.length = 0;
    const r = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-13T03:00:00+05:30') });
    expect(r.ok).toBe(1);
    expect(new Set(deps.seen)).toEqual(new Set(['2001']));
  });
});

describe('rolling beat (held rows, from the stored month-end series)', () => {
  it('peers monthly then held weekly: the held rows get the share of rolling 1y windows that beat the peer median; the benchmark is excluded', async () => {
    const m = memIo({ config: FLEXI });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30') });
    expect(rowsOf(m).filter((x) => x.role === 'held')).toHaveLength(0);
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const held = rowsOf(m).filter((x) => x.role === 'held');
    expect(held).toHaveLength(2);
    for (const h of held) expect(h).toMatchObject({ rollingBeatPeerMedianPct: 100, rollingWindows: 25 });
    expect(rowsOf(m).filter((x) => x.role !== 'held').every((x) => x.rollingBeatPeerMedianPct === null && x.rollingWindows === null)).toBe(true);
  });

  it('before any peers run there is no series: blank share (rollingWindows 0), not an error', async () => {
    const m = memIo({ config: FLEXI });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r.failed).toBe(0);
    const h = rowsOf(m)[0];
    expect(h.rollingBeatPeerMedianPct).toBeNull();
    expect(h.rollingWindows).toBe(0);
  });

  it('fewer than 3 peers → blank', async () => {
    const m = memIo({ config: FLEXI.slice(0, 3) });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30') });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(rowsOf(m).find((x) => x.role === 'held')).toMatchObject({ rollingBeatPeerMedianPct: null, rollingWindows: 0 });
  });
});

describe('conglomerate: whole category weekly + common-window columns', () => {
  const cmp = JSON.stringify({ window: 'common-since-2025-10-27', benchmarkProxyCode: '153132', label: 'weak comparability', thematicMedian: false });
  const cg = [
    cfgRow('conglomerate', 'held', 'absl-conglomerate', 'ABSL Conglomerate', '153124', '153127', { comparisonJson: cmp }),
    cfgRow('conglomerate', 'peer', 'peer-153867', 'ICICI Conglomerate', '153867', '153865', { comparisonJson: cmp }),
  ];
  it('the weekly held run refreshes held + peers; window metrics are cumulative until 365 days; rolling beat stays blank', async () => {
    const m = memIo({ config: cg });
    const deps = makeDeps({ bodies: { 153124: fx('mfapi-153124.json'), 153127: fx('mfapi-153124.json'), 153867: fx('mfapi-153867.json'), 153865: fx('mfapi-153867.json') }, codes: ['153124', '153127', '153867', '153865'] });
    const r = await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    expect(r).toMatchObject({ total: 4, ok: 4 });
    const rows = rowsOf(m);
    expect(rows.map((x) => x.role)).toEqual(['held', 'held', 'peer', 'peer']);
    for (const x of rows) {
      expect(x).toMatchObject({ windowStartDate: '2025-10-27', windowReturnBasis: 'cumulative', lastNavDate: NAV_DATE });
      expect(x.retWindowPct).not.toBeNull(); expect(x.volWindowPct).not.toBeNull(); expect(x.maxDrawdownWindowPct).not.toBeNull();
      expect(x.rollingBeatPeerMedianPct).toBeNull(); expect(x.rollingWindows).toBeNull();
    }
    expect(rows[2].status).toBe('insufficient-history'); // ICICI: ~0.95 y of history
    expect(rows[2].ret1yPct).toBeNull();
    expect(rows[0].status).toBe('ok');
    expect(rows[0].ret1yPct).toBeCloseTo(-4.84, 1);
  });
  it('the monthly peers run leaves the conglomerate category alone', async () => {
    const m = memIo({ config: [...cg, ...FLEXI] });
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30') });
    expect(rowsOf(m).some((x) => x.categoryKey === 'conglomerate')).toBe(false);
  });
  it('a series that starts after the window start gets blank window columns and says why', async () => {
    const late = JSON.parse(fx('mfapi-153867.json')); late.data = late.data.filter((r) => r.date !== '27-10-2025');
    const m = memIo({ config: cg });
    const deps = makeDeps({ bodies: { 153124: fx('mfapi-153124.json'), 153127: fx('mfapi-153124.json'), 153867: JSON.stringify(late), 153865: JSON.stringify(late) }, codes: ['153124', '153127', '153867', '153865'] });
    await runScope({ scope: 'held', io: m.io, deps, now: NOW });
    const x = rowsOf(m).find((r) => r.code === '153867');
    expect(x.retWindowPct).toBeNull(); expect(x.windowStartDate).toBe(''); expect(x.windowReturnBasis).toBe('');
    expect(x.reason).toMatch(/common window: history starts 2025-10-28, after the window start 2025-10-27/);
  });
});

describe('SBI sub-plan auto-narrowing in a run', () => {
  const ret = [
    cfgRow('retirement-aggressive-hybrid', 'held', 'sbi-retirement-aggressive-hybrid', 'SBI AHP', '148685', '148695'),
    cfgRow('retirement-conservative', 'held', 'sbi-retirement-conservative', 'SBI CP', '148688', '148696'),
  ];
  const codes = ['148685', '148695', '148688', '148696'];
  it('unmapped SipPlans → all active; mapped → only that sub-plan is fetched', async () => {
    const all = makeDeps({ bodies: { default: body('2020-01-01', NAV_DATE, 10, 0.0004) }, codes });
    await runScope({ scope: 'held', io: memIo({ config: ret }).io, deps: all, now: NOW });
    expect(new Set(all.seen)).toEqual(new Set(codes));
    const m = memIo({ config: ret, sip: [['sbi-retirement', '148688', 'SBI Retirement Fund', 'SBI', 5000, '', 'nro-mf', true]] });
    const one = makeDeps({ bodies: { default: body('2020-01-01', NAV_DATE, 10, 0.0004) }, codes });
    await runScope({ scope: 'held', io: m.io, deps: one, now: NOW });
    expect(new Set(one.seen)).toEqual(new Set(['148688', '148696']));
  });
});

describe('peers run: AMFI spot check', () => {
  it('compares two codes with AMFI’s single-day report and notes mismatches in the row reason (status stays ok)', async () => {
    const m = memIo({ config: FLEXI });
    const probe = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES });
    const amfiLines = ['hdr'];
    const deps = makeDeps({ bodies: flexiBodies(), codes: FLEXI_CODES, amfi: 'placeholder' });
    // learn the NAVs the run will see for the first two peer codes, then serve AMFI with one of them off
    const peek = JSON.parse(flexiBodies().default).data[0].nav;
    amfiLines.push(`2001;N;Direct;Growth;INF;-;${peek};09-Oct-2026`, `2002;N;Regular;Growth;INF;-;${(Number(peek) + 1).toFixed(4)};09-Oct-2026`);
    deps.client.getText.mockImplementation(async (url) => {
      if (url.includes('DownloadNAVHistoryReport')) return { status: 200, text: amfiLines.join('\n') };
      const code = /\/mf\/(\d+)$/.exec(url)[1];
      return { status: 200, text: flexiBodies()[code] ?? flexiBodies().default };
    });
    expect(probe).toBeTruthy();
    const r = await runScope({ scope: 'peers', io: m.io, deps, now: new Date('2026-10-02T03:00:00+05:30') });
    expect(r.failed).toBe(0);
    const rows = rowsOf(m);
    expect(byCode(rows, '2001')[0].reason).toBe('');
    expect(byCode(rows, '2002')[0].reason).toMatch(/spot-check: mfapi NAV .* differs from AMFI/);
    expect(byCode(rows, '2002')[0].status).toBe('ok');
    expect(valuesToRun(m.s.run)[0].cursorNote).toMatch(/spot-check 2026-10-09: 2\/2 codes found, 1 mismatch/);
  });
});

describe('TER scope', () => {
  const small = (extra = {}) => JSON.stringify({ data: JSON.parse(fx('ter-small-10-2026-p1.json')).data.concat(JSON.parse(fx('ter-small-10-2026-p2.json')).data), meta: { pageCount: 1 }, ...extra });
  const cfg = [
    cfgRow('small-x', 'held', 'held-x', 'ICICI Prudential Small Cap Fund', '120591', '106823'),
    cfgRow('small-x', 'peer', 'peer-130503', 'HDFC Small Cap Fund', '130503', '130502'),
    cfgRow('small-x', 'peer', 'peer-9', 'Totally New Fund', '9', '10'),
  ];
  const terClient = (handler) => ({ getText: vi.fn(async (url) => handler(url)) });
  const depsOf = (client) => ({ client, sleep: async () => {}, getNavAll: async () => new Map() });
  const feed = (url) => {
    if (url.includes('populate-sub-category')) return { text: '[]' };
    if (url.includes('strCat=77') && url.includes('Month=10-2026')) return { text: small() };
    return { text: JSON.stringify({ data: [], meta: { pageCount: 0 } }) };
  };

  it('writes one MfTer row per tracked code and plan: matched values, known gap, unexplained gap', async () => {
    const m = memIo({ config: cfg });
    const r = await runScope({ scope: 'ter', io: m.io, deps: depsOf(terClient(feed)), now: new Date('2026-10-09T03:00:00+05:30') });
    expect(r).toMatchObject({ done: true, ok: 2, failed: 2, knownGaps: 2 }); // HDFC's 2 plans are an expected gap and are never reported
    const t = valuesToTer(m.s.ter);
    expect(t).toHaveLength(6);
    expect(t.find((x) => x.code === '120591' && x.plan === 'direct')).toMatchObject({ matched: true, terPct: 1.17, berPct: 0.71, matchedName: 'ICICI Prudential Small Cap Fund', terDate: '2026-10-08', asOf: '2026-10-09', reason: '' });
    expect(t.find((x) => x.code === '106823' && x.plan === 'regular')).toMatchObject({ matched: true, terPct: 2.09 });
    expect(t.find((x) => x.code === '130503')).toMatchObject({ matched: false, terPct: null, berPct: null, matchedName: '', reason: expect.stringMatching(/known gap/) });
    expect(t.find((x) => x.code === '9')).toMatchObject({ matched: false, reason: expect.stringMatching(/no scheme with this name/) });
    expect(valuesToRun(m.s.run)[0]).toMatchObject({ scope: 'ter', cycle: '2026-10', done: 6, total: 6 });
  });

  it('is idempotent within a month (the second run does not touch the feed) unless forced', async () => {
    const m = memIo({ config: cfg });
    const client = terClient(feed);
    await runScope({ scope: 'ter', io: m.io, deps: depsOf(client), now: new Date('2026-10-09T03:00:00+05:30') });
    const n = client.getText.mock.calls.length;
    await runScope({ scope: 'ter', io: m.io, deps: depsOf(client), now: new Date('2026-10-10T03:00:00+05:30') });
    expect(client.getText.mock.calls.length).toBe(n);
    await runScope({ scope: 'ter', io: m.io, deps: depsOf(client), now: new Date('2026-10-10T03:00:00+05:30'), force: true });
    expect(client.getText.mock.calls.length).toBeGreaterThan(n);
    expect(valuesToTer(m.s.ter)).toHaveLength(6);
  });

  it('an unreachable feed is per-scheme matched=FALSE with a reason (never a job failure) and keeps previously matched values', async () => {
    const m = memIo({ config: cfg });
    await runScope({ scope: 'ter', io: m.io, deps: depsOf(terClient(feed)), now: new Date('2026-10-08T03:00:00+05:30'), force: true });
    const down = terClient(() => { throw new PeersFetchError({ phase: 'ter', host: 'www.amfiindia.com', cause: 'ECONNRESET: read ECONNRESET' }); });
    const r = await runScope({ scope: 'ter', io: m.io, deps: depsOf(down), now: new Date('2026-10-09T03:00:00+05:30'), force: true });
    expect(r.done).toBe(true);
    expect(r.error).toMatch(/phase=ter host=www\.amfiindia\.com/);
    const t = valuesToTer(m.s.ter);
    expect(t.find((x) => x.code === '120591' && x.plan === 'direct')).toMatchObject({ matched: true, terPct: 1.17, asOf: '2026-10-08' }); // last good value, its age visible in asOf
    expect(t.find((x) => x.code === '9')).toMatchObject({ matched: false, reason: expect.stringMatching(/AMFI TER feed unavailable: .*ECONNRESET/) });
  });
});

describe('config round trip', () => {
  it('valuesToConfig reads what memIo helper writes', () => {
    expect(valuesToConfig([FLEXI[0]])[0]).toMatchObject({ categoryKey: 'cat-a', role: 'held', directCode: '1001', regularCode: '1002', active: true });
    expect(PEERS_COLUMNS.length).toBe(26);
  });
});
