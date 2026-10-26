import { describe, it, expect } from 'vitest';
import {
  impliedFx, fxDeviationPct, FX_WARN_PCT, pendingInrReceipts, pendingSips, sipKey,
  planTransfer, cashLowCheck, sipUnits, DEFAULT_BUFFER_PCT,
} from '../investMfNudge.js';

const ACCOUNTS = [
  { id: 'nro-mf', name: 'NRO MF', type: 'mf_in', currency: 'INR' },
  { id: 'fidelity', name: 'Fidelity', type: 'brokerage' },
];
const PLANS = [
  { id: 'birla-flexi', name: 'Birla Flexi Cap', amountInr: 5000, day: null, accountId: 'nro-mf', active: true, schemeCode: 'unmapped' },
  { id: 'sbi-retirement', name: 'SBI Retirement', amountInr: 5000, day: 10, accountId: 'nro-mf', active: true, schemeCode: '123456' },
  { id: 'old', name: 'Old', amountInr: 9999, day: null, accountId: 'nro-mf', active: false, schemeCode: 'unmapped' },
];
const dep = (uuid, over = {}) => ({ type: 'DEPOSIT', uuid, accountId: 'nro-mf', currency: 'USD', amount: 240, date: '2026-11-02', ...over });
const rcv = (depUuid, over = {}) => ({ type: 'INR_RECEIVED', uuid: `r_${depUuid}`, accountId: 'nro-mf', currency: 'INR', amount: 20000, fxToUsd: 0.012, date: '2026-11-04', note: `settles:${depUuid}`, ...over });
const buy = (sym, date, amount = 5000) => ({ type: 'BUY', accountId: 'nro-mf', currency: 'INR', symbol: sym, qty: 10, price: 500, amount, fxToUsd: 0.012, date, uuid: `b_${sym}_${date}` });

describe('impliedFx', () => {
  it('derives both directions', () => {
    const r = impliedFx(240, 20000);
    expect(r.usdPerInr).toBeCloseTo(0.012, 6);
    expect(r.inrPerUsd).toBeCloseTo(83.333, 2);
  });
  it('null on bad input', () => {
    expect(impliedFx(0, 20000)).toBeNull();
    expect(impliedFx(240, 0)).toBeNull();
    expect(impliedFx('x', 1)).toBeNull();
  });
});

describe('fxDeviationPct', () => {
  it('absolute % off the live rate', () => {
    expect(fxDeviationPct(88, 80)).toBeCloseTo(10);
    expect(fxDeviationPct(72, 80)).toBeCloseTo(10);
  });
  it('null when the live rate or input is missing', () => {
    expect(fxDeviationPct(80, null)).toBeNull();
    expect(fxDeviationPct(null, 80)).toBeNull();
  });
  it('warn threshold is 5%', () => { expect(FX_WARN_PCT).toBe(5); });
});

describe('pendingInrReceipts', () => {
  it('lists unsettled mf_in USD deposits with account name', () => {
    const out = pendingInrReceipts([dep('d1'), dep('d2', { date: '2026-12-02' })], ACCOUNTS, []);
    expect(out.map(p => p.uuid)).toEqual(['d1', 'd2']);
    expect(out[0]).toMatchObject({ accountId: 'nro-mf', accountName: 'NRO MF', amount: 240, date: '2026-11-02' });
  });
  it('drops settled and dismissed ones', () => {
    const acts = [dep('d1'), dep('d2'), dep('d3'), rcv('d1')];
    expect(pendingInrReceipts(acts, ACCOUNTS, ['d2']).map(p => p.uuid)).toEqual(['d3']);
  });
  it('ignores non-mf_in deposits', () => {
    expect(pendingInrReceipts([dep('d1', { accountId: 'fidelity' })], ACCOUNTS, [])).toEqual([]);
  });
});

describe('pendingSips', () => {
  const today = '2026-11-15';
  it('shows nothing before any INR_RECEIVED exists', () => {
    expect(pendingSips(PLANS, [dep('d1')], { today })).toEqual([]);
  });
  it('shows active plans for the current month once money arrived', () => {
    const out = pendingSips(PLANS, [dep('d1'), rcv('d1')], { today });
    expect(out.map(p => p.planId)).toEqual(['birla-flexi', 'sbi-retirement']);
    expect(out[0]).toMatchObject({ month: '2026-11', amountInr: 5000, name: 'Birla Flexi Cap', mapped: false });
    expect(out[1].mapped).toBe(true);
  });
  it('respects the day: not due before it, due on/after', () => {
    const acts = [dep('d1'), rcv('d1')];
    expect(pendingSips(PLANS, acts, { today: '2026-11-09' }).map(p => p.planId)).toEqual(['birla-flexi']);
    expect(pendingSips(PLANS, acts, { today: '2026-11-10' }).map(p => p.planId)).toEqual(['birla-flexi', 'sbi-retirement']);
  });
  it('clamps day 31 to month end', () => {
    const plans = [{ ...PLANS[0], day: 31 }];
    const acts = [dep('d1', { date: '2026-01-02' }), rcv('d1', { date: '2026-01-05' })];
    const out = pendingSips(plans, acts, { today: '2026-02-28' });
    expect(out.map(p => p.month)).toEqual(['2026-01', '2026-02']);
  });
  it('a BUY (case-insensitive symbol) in that month satisfies it', () => {
    const acts = [dep('d1'), rcv('d1'), buy('BIRLA-FLEXI', '2026-11-05')];
    expect(pendingSips(PLANS, acts, { today }).map(p => p.planId)).toEqual(['sbi-retirement']);
  });
  it('carries unsatisfied earlier months forward', () => {
    const acts = [dep('d1'), rcv('d1'), buy('BIRLA-FLEXI', '2026-11-05'), buy('SBI-RETIREMENT', '2026-11-12')];
    const out = pendingSips(PLANS, acts, { today: '2026-12-20' });
    expect(out.map(p => `${p.planId}@${p.month}`)).toEqual(['birla-flexi@2026-12', 'sbi-retirement@2026-12']);
    const late = pendingSips(PLANS, [dep('d1'), rcv('d1')], { today: '2026-12-20' });
    expect(late.map(p => `${p.planId}@${p.month}`)).toEqual([
      'birla-flexi@2026-11', 'sbi-retirement@2026-11', 'birla-flexi@2026-12', 'sbi-retirement@2026-12',
    ]);
  });
  it('a late BUY dated in an earlier month satisfies that month only', () => {
    const acts = [dep('d1'), rcv('d1'), buy('BIRLA-FLEXI', '2026-11-30')];
    const out = pendingSips(PLANS, acts, { today: '2026-12-20' });
    expect(out.filter(p => p.planId === 'birla-flexi').map(p => p.month)).toEqual(['2026-12']);
  });
  it('skipped keys hide a plan-month', () => {
    const acts = [dep('d1'), rcv('d1')];
    const out = pendingSips(PLANS, acts, { today, skipped: [sipKey('birla-flexi', '2026-11')] });
    expect(out.map(p => p.planId)).toEqual(['sbi-retirement']);
  });
  it('ignores plans on other accounts and inactive plans', () => {
    const plans = [{ ...PLANS[0], accountId: 'other' }, PLANS[2]];
    expect(pendingSips(plans, [dep('d1'), rcv('d1')], { today })).toEqual([]);
  });
});

describe('planTransfer', () => {
  it('sums active plans and builds the buffered range', () => {
    const r = planTransfer({ plans: PLANS, liveInrPerUsd: 80, bufferPct: 2 });
    expect(r.targetInr).toBe(10000);
    expect(r.usdLow).toBeCloseTo(125);
    expect(r.usdHigh).toBeCloseTo(127.5);
  });
  it('defaults the buffer to 2%', () => {
    expect(DEFAULT_BUFFER_PCT).toBe(2);
    expect(planTransfer({ plans: PLANS, liveInrPerUsd: 80 }).usdHigh).toBeCloseTo(127.5);
  });
  it('no live rate → INR only', () => {
    const r = planTransfer({ plans: PLANS, liveInrPerUsd: null });
    expect(r.targetInr).toBe(10000);
    expect(r.usdLow).toBeNull();
    expect(r.usdHigh).toBeNull();
  });
  it('reports cash already in the account and the USD it saves', () => {
    const r = planTransfer({ plans: PLANS, liveInrPerUsd: 80, cashInr: 4000 });
    expect(r.cashInr).toBe(4000);
    expect(r.usdSaved).toBeCloseTo(50);
  });
  it('caps the saving at the target and ignores negative cash', () => {
    expect(planTransfer({ plans: PLANS, liveInrPerUsd: 80, cashInr: 50000 }).usdSaved).toBeCloseTo(125);
    expect(planTransfer({ plans: PLANS, liveInrPerUsd: 80, cashInr: -5 }).cashInr).toBe(0);
  });
});

describe('cashLowCheck', () => {
  it('suppressed while nothing has been sent', () => {
    expect(cashLowCheck([], PLANS, 'nro-mf').low).toBe(false);
  });
  it('active when only an in-transit deposit exists', () => {
    // in transit USD deposit, no INR yet: still no cash, so warn
    const r = cashLowCheck([dep('d1')], PLANS, 'nro-mf');
    expect(r).toMatchObject({ low: true, cashInr: 0, needInr: 10000, shortfallInr: 10000 });
  });
  it('low when cash < next SIP total', () => {
    const acts = [dep('d1'), rcv('d1', { amount: 12000 }), buy('BIRLA-FLEXI', '2026-11-05')];
    const r = cashLowCheck(acts, PLANS, 'nro-mf');
    expect(r).toMatchObject({ low: true, cashInr: 7000, shortfallInr: 3000 });
  });
  it('not low when cash covers it', () => {
    const acts = [dep('d1'), rcv('d1', { amount: 20000 })];
    expect(cashLowCheck(acts, PLANS, 'nro-mf').low).toBe(false);
  });
});

describe('sipUnits', () => {
  it('amount / NAV, 3 decimals', () => { expect(sipUnits(5000, 123.4567)).toBe(40.5); });
  it('null on bad NAV', () => { expect(sipUnits(5000, 0)).toBeNull(); expect(sipUnits(5000, 'x')).toBeNull(); });
});

import { buildInrReceived, buildSipBuy } from '../investMfNudge.js';

describe('buildInrReceived', () => {
  it('writes the settling INR_RECEIVED with true FX', () => {
    const a = buildInrReceived({ deposit: { uuid: 'd1', accountId: 'nro-mf', amount: 240 }, inrReceived: 20000, date: '2026-11-04' });
    expect(a).toEqual({
      date: '2026-11-04', accountId: 'nro-mf', type: 'INR_RECEIVED', currency: 'INR',
      amount: 20000, fxToUsd: 240 / 20000, note: 'settles:d1',
    });
  });
});

describe('buildSipBuy', () => {
  const acts = [dep('d1'), rcv('d1', { amount: 20000, fxToUsd: 0.012 })];
  it('uses the pool average fx computed before the BUY', () => {
    const a = buildSipBuy({ plan: PLANS[0], date: '2026-11-05', nav: 100, units: 50, activities: acts });
    expect(a).toEqual({
      date: '2026-11-05', accountId: 'nro-mf', type: 'BUY', currency: 'INR',
      symbol: 'birla-flexi', qty: 50, price: 100, amount: 5000, fxToUsd: 0.012,
    });
  });
  it('amount defaults to the plan amount but can be overridden', () => {
    expect(buildSipBuy({ plan: PLANS[0], date: 'd', nav: 100, units: 49, amount: 4900, activities: acts }).amount).toBe(4900);
  });
  it('empty pool → blank fx (never guessed)', () => {
    expect(buildSipBuy({ plan: PLANS[0], date: 'd', nav: 100, units: 50, activities: [] }).fxToUsd).toBe('');
  });
});
