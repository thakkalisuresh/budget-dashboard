import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import {
  FUND_KEYS, FUND_REGISTRY, HOLDINGS_COLUMNS, STATUS_COLUMNS,
  targetAsOf, inRunWindow, validateAsOf, checkFund, mergeHoldings, holdingsToValues, valuesToHoldings,
  statusToValues, valuesToStatus, runMfHoldings, MfFetchError,
} from '../../functions/lib/_mf-holdings.mjs';
import { INVEST_TABS } from '../sheetInvest.js';

describe('contract', () => {
  it('exports the seven stable fund keys', () => {
    expect(FUND_KEYS).toEqual([
      'absl-flexi-cap', 'absl-conglomerate', 'iti-small-cap',
      'sbi-retirement-aggressive-hybrid', 'sbi-retirement-aggressive',
      'sbi-retirement-conservative-hybrid', 'sbi-retirement-conservative',
    ]);
    expect(FUND_REGISTRY.map(f => f.house)).toEqual(['absl', 'absl', 'iti', 'sbi', 'sbi', 'sbi', 'sbi']);
  });

  it('keeps the sheet column lists identical to src/sheetInvest.js INVEST_TABS (client/server contract)', () => {
    expect(INVEST_TABS.MfHoldings).toEqual(HOLDINGS_COLUMNS);
    expect(INVEST_TABS.MfHoldingsStatus).toEqual(STATUS_COLUMNS);
    expect(HOLDINGS_COLUMNS).toEqual(['asOf', 'fundKey', 'isin', 'name', 'industry', 'assetClass', 'weightPct', 'marketValueInrLakh', 'sourceFile']);
    expect(STATUS_COLUMNS).toEqual(['fundKey', 'asOf', 'status', 'checkedAt', 'rowCount', 'weightSum', 'reason', 'sourceFile']);
  });
});

describe('date window logic (IST)', () => {
  it('targets the previous month-end', () => {
    expect(targetAsOf(new Date('2026-10-10T06:00:00Z'))).toBe('2026-09-30');
    expect(targetAsOf(new Date('2026-01-09T06:00:00Z'))).toBe('2025-12-31');
    expect(targetAsOf(new Date('2026-03-09T06:00:00Z'))).toBe('2026-02-28');
    expect(targetAsOf(new Date('2028-03-09T06:00:00Z'))).toBe('2028-02-29');
  });

  it('uses the IST calendar day, not UTC', () => {
    // 2026-10-31T20:00Z is already 1 Nov in IST -> previous month-end is Oct 31.
    expect(targetAsOf(new Date('2026-10-31T20:00:00Z'))).toBe('2026-10-31');
    expect(targetAsOf(new Date('2026-10-31T10:00:00Z'))).toBe('2026-09-30');
  });

  it('runs only on days 8-12', () => {
    const d = (day) => new Date(`2026-10-${String(day).padStart(2, '0')}T06:00:00Z`);
    expect([7, 8, 12, 13].map(x => inRunWindow(d(x)))).toEqual([false, true, true, false]);
    expect(inRunWindow(new Date('2026-10-12T20:00:00Z'))).toBe(false); // 13th in IST
  });

  it('validates a backfill as-of: month-end, not after target, within the last 3 months', () => {
    const now = new Date('2026-10-10T06:00:00Z');
    expect(validateAsOf('2026-09-30', now)).toEqual({ ok: true });
    expect(validateAsOf('2026-08-31', now).ok).toBe(true);
    expect(validateAsOf('2026-07-31', now).ok).toBe(true);
    expect(validateAsOf('2026-06-30', now).ok).toBe(false);
    expect(validateAsOf('2026-10-31', now).ok).toBe(false);
    expect(validateAsOf('2026-08-30', now).ok).toBe(false);
    expect(validateAsOf('nope', now).ok).toBe(false);
  });
});

const row = (o = {}) => ({ isin: 'INE000A01010', name: 'A', industry: 'Banks', assetClass: 'equity', weightPct: 50, marketValueInrLakh: 10, ...o });
const fund = (o = {}) => ({
  fundKey: 'absl-flexi-cap', asOf: '2026-09-30', sourceFile: 'absl:x.xls#BSLEQTY',
  rows: [row({ weightPct: 60 }), row({ isin: 'INE000B01010', weightPct: 37 }), row({ isin: '', name: 'TREPS', assetClass: 'cash', weightPct: 3 })],
  ...o,
});

describe('sanity checks', () => {
  const T = '2026-09-30';
  it('passes a healthy fund and reports the weight sum', () => {
    const c = checkFund(fund(), { target: T });
    expect(c.status).toBe('ok');
    expect(c.weightSum).toBeCloseTo(100, 6);
  });

  it('flags a stale file (portfolio date is not the target month-end) as stale', () => {
    const c = checkFund(fund({ asOf: '2026-08-31' }), { target: T });
    expect(c.status).toBe('stale');
    expect(c.reason).toMatch(/2026-08-31.*2026-09-30/);
  });

  it('flags a missing date as failed', () => {
    expect(checkFund(fund({ asOf: null }), { target: T }).status).toBe('failed');
  });

  it('fails when the weights sum outside 90-102', () => {
    expect(checkFund(fund({ rows: [row({ weightPct: 85 })] }), { target: T }).status).toBe('failed');
    expect(checkFund(fund({ rows: [row({ weightPct: 103 })] }), { target: T }).reason).toMatch(/sum/i);
    expect(checkFund(fund({ rows: [row({ weightPct: 90 })] }), { target: T }).status).toBe('ok');
    expect(checkFund(fund({ rows: [row({ weightPct: 102 })] }), { target: T }).status).toBe('ok');
  });

  it('catches a fraction/percent unit mix-up that slipped through (sum ~1)', () => {
    const c = checkFund(fund({ rows: [row({ weightPct: 0.6 }), row({ isin: 'INE000B01010', weightPct: 0.4 })] }), { target: T });
    expect(c.status).toBe('failed');
  });

  it('fails an empty or truncated result', () => {
    expect(checkFund(fund({ rows: [] }), { target: T }).reason).toMatch(/no rows/i);
    expect(checkFund(fund({ rows: undefined, error: 'sheet X not found' }), { target: T })).toMatchObject({ status: 'failed', reason: 'sheet X not found' });
  });

  it('fails a negative equity/debt weight but allows negative cash and derivative', () => {
    const bad = checkFund(fund({ rows: [row({ weightPct: 101 }), row({ isin: 'INE000B01010', weightPct: -2 })] }), { target: T });
    expect(bad.status).toBe('failed');
    expect(bad.reason).toMatch(/negative/i);
    const ok = checkFund(fund({ rows: [row({ weightPct: 100.5 }), row({ isin: '', name: 'Net Receivable', assetClass: 'cash', weightPct: -0.5 }), row({ isin: '', name: 'IRS', assetClass: 'derivative', weightPct: -12 })] }), { target: T });
    expect(ok.status).toBe('ok');
  });

  it('excludes derivative notional from the weight sum', () => {
    const c = checkFund(fund({ rows: [row({ weightPct: 99 }), row({ isin: '', name: 'Fut', assetClass: 'derivative', weightPct: 25 })] }), { target: T });
    expect(c.status).toBe('ok');
    expect(c.weightSum).toBeCloseTo(99, 6);
  });

  it('fails when classification coverage is poor', () => {
    const c = checkFund(fund({ unclassifiedPct: 12 }), { target: T });
    expect(c.status).toBe('failed');
    expect(c.reason).toMatch(/classif/i);
  });
});

describe('merge / retention', () => {
  const stored = (fundKey, asOf, n = 2) => Array.from({ length: n }, (_, i) => ({
    asOf, fundKey, isin: `INE00${i}A01010`, name: `n${i}`, industry: '', assetClass: 'equity', weightPct: 10, marketValueInrLakh: null, sourceFile: 's',
  }));

  it('replaces the same fund+asOf (idempotent re-run) and leaves other funds alone', () => {
    const existing = [...stored('absl-flexi-cap', '2026-09-30', 3), ...stored('iti-small-cap', '2026-09-30', 2)];
    const out = mergeHoldings(existing, { 'absl-flexi-cap': { asOf: '2026-09-30', rows: [row()], sourceFile: 'new' } });
    expect(out.filter(r => r.fundKey === 'absl-flexi-cap')).toHaveLength(1);
    expect(out.filter(r => r.fundKey === 'iti-small-cap')).toHaveLength(2);
    const again = mergeHoldings(out, { 'absl-flexi-cap': { asOf: '2026-09-30', rows: [row()], sourceFile: 'new' } });
    expect(again).toEqual(out);
  });

  it('keeps the latest and the previous asOf per fund and prunes older', () => {
    let rows = [...stored('absl-flexi-cap', '2026-07-31'), ...stored('absl-flexi-cap', '2026-08-31')];
    rows = mergeHoldings(rows, { 'absl-flexi-cap': { asOf: '2026-09-30', rows: [row()], sourceFile: 'x' } });
    expect([...new Set(rows.map(r => r.asOf))].sort()).toEqual(['2026-08-31', '2026-09-30']);
  });

  it('a backfill of an older month never evicts the latest', () => {
    let rows = [...stored('absl-flexi-cap', '2026-09-30')];
    rows = mergeHoldings(rows, { 'absl-flexi-cap': { asOf: '2026-08-31', rows: [row()], sourceFile: 'x' } });
    expect([...new Set(rows.map(r => r.asOf))].sort()).toEqual(['2026-08-31', '2026-09-30']);
  });

  it('round-trips through sheet values (strings kept as text, numbers as numbers)', () => {
    const merged = mergeHoldings([], { 'iti-small-cap': { asOf: '2026-09-30', rows: [row({ marketValueInrLakh: null })], sourceFile: 'iti:f#S' } });
    const values = holdingsToValues(merged);
    expect(values[0]).toEqual(['2026-09-30', 'iti-small-cap', 'INE000A01010', 'A', 'Banks', 'equity', 50, '', 'iti:f#S']);
    expect(valuesToHoldings(values)).toEqual(merged);
    expect(valuesToHoldings([['', '', '']])).toEqual([]);
  });

  it('round-trips status rows', () => {
    const s = [{ fundKey: 'iti-small-cap', asOf: '2026-09-30', status: 'ok', checkedAt: '2026-10-10T06:00:00.000Z', rowCount: 90, weightSum: 100, reason: '', sourceFile: 'iti:f' }];
    expect(valuesToStatus(statusToValues(s))).toEqual(s);
  });
});

/* ── orchestration ────────────────────────────────────────────────────────── */

const NOW = new Date('2026-10-10T06:00:00Z');

function memIo(init = {}) {
  const state = { holdings: init.holdings || [], status: init.status || [], writes: 0 };
  return {
    state,
    read: vi.fn(async () => ({ holdings: state.holdings.map(r => ({ ...r })), status: state.status.map(r => ({ ...r })) })),
    write: vi.fn(async ({ holdings, status }) => { state.holdings = holdings; state.status = status; state.writes++; }),
  };
}

const okParsed = (fundKey, asOf = '2026-09-30') => ({ fundKey, asOf, sourceFile: `h:${fundKey}`, unit: 'percent', unclassifiedPct: 0, rows: [row({ weightPct: 99 }), row({ isin: '', name: 'TREPS', assetClass: 'cash', weightPct: 1 })] });

function impl(overrides = {}) {
  const mk = (house, keys, over = {}) => ({
    fetch: vi.fn(async () => ({ fileName: `${house}.bin`, buffer: Buffer.from('x') })),
    parse: vi.fn(() => Object.fromEntries(keys.map(k => [k, okParsed(k)]))),
    ...over,
  });
  return {
    absl: mk('absl', ['absl-flexi-cap', 'absl-conglomerate'], overrides.absl),
    sbi: mk('sbi', FUND_KEYS.filter(k => k.startsWith('sbi')), overrides.sbi),
    iti: mk('iti', ['iti-small-cap'], overrides.iti),
  };
}

describe('runMfHoldings', () => {
  it('ingests all three houses and writes rows + a status row per fund', async () => {
    const io = memIo();
    const res = await runMfHoldings({ io, impl: impl(), now: NOW, sleep: async () => {} });
    expect(res.target).toBe('2026-09-30');
    expect(io.state.holdings.map(r => r.fundKey).filter((v, i, a) => a.indexOf(v) === i).sort()).toEqual([...FUND_KEYS].sort());
    expect(io.state.status).toHaveLength(7);
    expect(io.state.status.every(s => s.status === 'ok' && s.asOf === '2026-09-30')).toBe(true);
    expect(res.houses.absl.status).toBe('done');
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it('skips houses already ingested for the target month (no fetch, no write)', async () => {
    const io = memIo();
    await runMfHoldings({ io, impl: impl(), now: NOW, sleep: async () => {} });
    const i2 = impl();
    const res = await runMfHoldings({ io, impl: i2, now: NOW, sleep: async () => {} });
    expect(Object.values(res.houses).every(h => h.status === 'skipped')).toBe(true);
    expect(i2.absl.fetch).not.toHaveBeenCalled();
    expect(io.write).toHaveBeenCalledTimes(1);
  });

  it('does not let one failing house block the others and marks it per fund', async () => {
    const io = memIo();
    const i = impl({ sbi: { fetch: vi.fn(async () => { throw new MfFetchError('missing', 'not published yet (404)'); }) } });
    const res = await runMfHoldings({ io, impl: i, now: NOW, sleep: async () => {} });
    expect(res.houses.sbi.status).toBe('missing');
    expect(res.houses.absl.status).toBe('done');
    expect(res.houses.iti.status).toBe('done');
    const sbi = io.state.status.filter(s => s.fundKey.startsWith('sbi'));
    expect(sbi).toHaveLength(4);
    expect(sbi.every(s => s.status === 'missing' && /404/.test(s.reason))).toBe(true);
    expect(io.state.holdings.some(r => r.fundKey.startsWith('sbi'))).toBe(false);
  });

  it('an unexpected throw in one house is a per-house failure, not a crash', async () => {
    const io = memIo();
    const i = impl({ absl: { parse: vi.fn(() => { throw new Error('boom'); }) } });
    const res = await runMfHoldings({ io, impl: i, now: NOW, sleep: async () => {} });
    expect(res.houses.absl.status).toBe('failed');
    expect(io.state.status.find(s => s.fundKey === 'absl-flexi-cap')).toMatchObject({ status: 'failed', reason: expect.stringContaining('boom') });
    expect(res.houses.iti.status).toBe('done');
  });

  it('retries a failed house next run but skips the done ones', async () => {
    const io = memIo();
    const first = impl({ iti: { fetch: vi.fn(async () => { throw new MfFetchError('missing', 'listing empty'); }) } });
    await runMfHoldings({ io, impl: first, now: NOW, sleep: async () => {} });
    const second = impl();
    const res = await runMfHoldings({ io, impl: second, now: new Date('2026-10-11T06:00:00Z'), sleep: async () => {} });
    expect(res.houses.iti.status).toBe('done');
    expect(res.houses.absl.status).toBe('skipped');
    expect(second.iti.fetch).toHaveBeenCalledTimes(1);
    expect(second.absl.fetch).not.toHaveBeenCalled();
    expect(io.state.status.find(s => s.fundKey === 'iti-small-cap').status).toBe('ok');
  });

  it('a failed check keeps the previous month and records the reason', async () => {
    const prev = [{ asOf: '2026-08-31', fundKey: 'iti-small-cap', isin: 'INE000A01010', name: 'old', industry: '', assetClass: 'equity', weightPct: 100, marketValueInrLakh: null, sourceFile: 's' }];
    const prevStatus = [{ fundKey: 'iti-small-cap', asOf: '2026-08-31', status: 'ok', checkedAt: 'x', rowCount: 1, weightSum: 100, reason: '', sourceFile: 's' }];
    const io = memIo({ holdings: prev, status: prevStatus });
    const bad = okParsed('iti-small-cap');
    bad.rows = [row({ weightPct: 40 })];
    const i = impl({ iti: { parse: vi.fn(() => ({ 'iti-small-cap': bad })) } });
    await runMfHoldings({ io, impl: i, now: NOW, sleep: async () => {} });
    expect(io.state.holdings.filter(r => r.fundKey === 'iti-small-cap')).toEqual(prev);
    const s = io.state.status.find(x => x.fundKey === 'iti-small-cap');
    expect(s).toMatchObject({ status: 'failed', asOf: '2026-08-31', rowCount: 1 });
    expect(s.reason).toMatch(/sum/i);
  });

  it('marks a still-published old file as stale and keeps stored rows', async () => {
    const io = memIo();
    const i = impl({ iti: { parse: vi.fn(() => ({ 'iti-small-cap': okParsed('iti-small-cap', '2026-08-31') })) } });
    await runMfHoldings({ io, impl: i, now: NOW, sleep: async () => {} });
    expect(io.state.status.find(x => x.fundKey === 'iti-small-cap')).toMatchObject({ status: 'stale', asOf: '' });
    expect(io.state.holdings.some(r => r.fundKey === 'iti-small-cap')).toBe(false);
  });

  it('one bad fund inside a house (wrong sheet) does not block its siblings', async () => {
    const io = memIo();
    const i = impl({ sbi: { parse: vi.fn(() => ({
      'sbi-retirement-aggressive-hybrid': okParsed('sbi-retirement-aggressive-hybrid'),
      'sbi-retirement-aggressive': { fundKey: 'sbi-retirement-aggressive', error: 'sheet SRBF-AP not found' },
      'sbi-retirement-conservative-hybrid': okParsed('sbi-retirement-conservative-hybrid'),
      'sbi-retirement-conservative': okParsed('sbi-retirement-conservative'),
    })) } });
    const res = await runMfHoldings({ io, impl: i, now: NOW, sleep: async () => {} });
    expect(res.houses.sbi.status).toBe('partial');
    expect(io.state.status.find(s => s.fundKey === 'sbi-retirement-aggressive')).toMatchObject({ status: 'failed', reason: 'sheet SRBF-AP not found' });
    expect(io.state.status.find(s => s.fundKey === 'sbi-retirement-conservative').status).toBe('ok');
  });

  it('a house that stays partial is retried next run, but its ok funds are not re-written', async () => {
    const io = memIo();
    const partial = { 'sbi-retirement-aggressive-hybrid': okParsed('sbi-retirement-aggressive-hybrid'), 'sbi-retirement-aggressive': { fundKey: 'sbi-retirement-aggressive', error: 'x' }, 'sbi-retirement-conservative-hybrid': okParsed('sbi-retirement-conservative-hybrid'), 'sbi-retirement-conservative': okParsed('sbi-retirement-conservative') };
    await runMfHoldings({ io, impl: impl({ sbi: { parse: vi.fn(() => partial) } }), now: NOW, sleep: async () => {} });
    const i2 = impl();
    const res = await runMfHoldings({ io, impl: i2, now: NOW, sleep: async () => {} });
    expect(res.houses.sbi.status).toBe('done');
    expect(i2.sbi.fetch).toHaveBeenCalledTimes(1);
  });

  it('force re-runs a finished house; houses filter limits the run', async () => {
    const io = memIo();
    await runMfHoldings({ io, impl: impl(), now: NOW, sleep: async () => {} });
    const i2 = impl();
    const res = await runMfHoldings({ io, impl: i2, now: NOW, force: true, houses: ['iti'], sleep: async () => {} });
    expect(res.houses.iti.status).toBe('done');
    expect(res.houses.absl).toBeUndefined();
    expect(i2.absl.fetch).not.toHaveBeenCalled();
  });

  it('backfill of an older month writes rows but leaves the status row of the latest month alone', async () => {
    const io = memIo();
    await runMfHoldings({ io, impl: impl(), now: NOW, sleep: async () => {} });
    const before = io.state.status.map(s => ({ ...s }));
    const i2 = impl({ iti: { parse: vi.fn(() => ({ 'iti-small-cap': okParsed('iti-small-cap', '2026-08-31') })) } });
    const res = await runMfHoldings({ io, impl: i2, now: NOW, asOf: '2026-08-31', houses: ['iti'], sleep: async () => {} });
    expect(res.target).toBe('2026-08-31');
    expect([...new Set(io.state.holdings.filter(r => r.fundKey === 'iti-small-cap').map(r => r.asOf))].sort()).toEqual(['2026-08-31', '2026-09-30']);
    expect(io.state.status.find(s => s.fundKey === 'iti-small-cap')).toEqual(before.find(s => s.fundKey === 'iti-small-cap'));
    expect(i2.iti.fetch).toHaveBeenCalledWith(expect.objectContaining({ asOf: '2026-08-31' }));
  });

  it('rejects an invalid backfill as-of without fetching anything', async () => {
    const io = memIo();
    const i = impl();
    await expect(runMfHoldings({ io, impl: i, now: NOW, asOf: '2026-08-15', sleep: async () => {} })).rejects.toThrow(/month-end/i);
    expect(i.absl.fetch).not.toHaveBeenCalled();
  });

  it('does not write when nothing changed (all skipped)', async () => {
    const io = memIo();
    await runMfHoldings({ io, impl: impl(), now: NOW, sleep: async () => {} });
    io.write.mockClear();
    await runMfHoldings({ io, impl: impl(), now: NOW, sleep: async () => {} });
    expect(io.write).not.toHaveBeenCalled();
  });
});
