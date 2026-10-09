import { describe, it, expect } from 'vitest';
import {
  buildMfView, mappedCodes, navFor, fmtMfMoney, mapPatchFor, searchSeed, subPlanHint,
} from '../investMfView.js';

const A = 'nro-mf';
const TODAY = '2027-02-01';
const plans = [
  { id: 'birla-flexi', schemeCode: '120564', mapped: true, name: 'Birla Flexi Cap', amc: 'Aditya Birla Sun Life', amountInr: 5000, active: true },
  { id: 'iti-small-cap', schemeCode: '147919', mapped: true, name: 'ITI Small Cap', amc: 'ITI', amountInr: 5000, active: true },
  { id: 'sbi-retirement', schemeCode: 'unmapped', mapped: false, name: 'SBI Retirement', amc: 'SBI', amountInr: 5000, active: true },
];
const buy = (date, symbol, inr, nav, fx) => ({
  uuid: `${date}-${symbol}`, date, accountId: A, type: 'BUY', symbol: symbol.toUpperCase(),
  currency: 'INR', qty: inr / nav, price: nav, amount: inr, fxToUsd: fx,
});
const rcv = (date, inr, fx) => ({ uuid: `r${date}`, date, accountId: A, type: 'INR_RECEIVED', currency: 'INR', amount: inr, fxToUsd: fx });

const acts = [
  rcv('2026-11-01', 20000, 0.0120),
  buy('2026-11-05', 'birla-flexi', 5000, 100, 0.0120),
  buy('2026-11-05', 'iti-small-cap', 5000, 50, 0.0120),
  buy('2026-11-05', 'sbi-retirement', 5000, 25, 0.0120),
  buy('2026-12-05', 'birla-flexi', 5000, 125, 0.0118),
];
const navs = {
  120564: { nav: 150, date: '2027-01-30' },
  147919: { nav: 40, date: '2027-01-30' },
};
const fx = { rate: 80 }; // INR per USD → 0.0125 USD per INR

const view = (over = {}) => buildMfView({
  plans, activities: acts, accountIds: [A], navs, fx, currency: 'INR', today: TODAY, ...over,
});

describe('buildMfView — INR', () => {
  const v = view();
  const flexi = v.funds.find(f => f.planId === 'birla-flexi');
  const iti = v.funds.find(f => f.planId === 'iti-small-cap');
  const sbi = v.funds.find(f => f.planId === 'sbi-retirement');

  it('derives units, avg cost, invested and value per fund', () => {
    expect(flexi.units).toBeCloseTo(50 + 40, 6);
    expect(flexi.invested).toBeCloseTo(10000, 6);
    expect(flexi.avgCost).toBeCloseTo(10000 / 90, 6);
    expect(flexi.value).toBeCloseTo(90 * 150, 6);
    expect(flexi.gain).toBeCloseTo(13500 - 10000, 6);
    expect(flexi.gainPct).toBeCloseTo(0.35, 6);
    expect(flexi.costBasis).toBe(false);
  });

  it('computes XIRR from dated flows plus current value', () => {
    expect(flexi.xirr).toBeGreaterThan(0);
    expect(iti.xirr).toBeLessThan(0); // 5000 → 100 units × 40 = 4000
  });

  it('falls back to cost for an unmapped plan and flags it', () => {
    expect(sbi.needsMapping).toBe(true);
    expect(sbi.costBasis).toBe(true);
    expect(sbi.value).toBeCloseTo(5000, 6);
    expect(sbi.gain).toBeNull();
    expect(sbi.xirr).toBeNull();
  });

  it('flags a mapped plan whose NAV is missing as cost basis, not needsMapping', () => {
    const w = view({ navs: { 120564: navs[120564] } });
    const f = w.funds.find(x => x.planId === 'iti-small-cap');
    expect(f.costBasis).toBe(true);
    expect(f.needsMapping).toBe(false);
  });

  it('groups by AMC with subtotals and totals the whole book', () => {
    expect(v.amcs.map(a => a.amc)).toEqual(['Aditya Birla Sun Life', 'ITI', 'SBI']);
    expect(v.amcs[0].value).toBeCloseTo(13500, 6);
    expect(v.total.invested).toBeCloseTo(20000, 6);
    expect(v.total.value).toBeCloseTo(13500 + 4000 + 5000, 6);
    expect(v.total.partial).toBe(true); // sbi valued at cost
    expect(v.total.xirr).toBeNull();    // not meaningful while partial
    expect(v.unmappedCount).toBe(1);
  });

  it('shows the INR cash line and non-empty state', () => {
    expect(v.cash.inr).toBe(0); // 20,000 received − four 5,000 debits
    expect(v.cash.display).toBe(v.cash.inr);
    expect(v.hasActivity).toBe(true);
  });
});

describe('buildMfView — all mapped (full XIRR)', () => {
  const allMapped = plans.map(p => ({ ...p, schemeCode: p.mapped ? p.schemeCode : '148685', mapped: true }));
  const n2 = { ...navs, 148685: { nav: 30, date: '2027-01-30' } };
  const v = buildMfView({ plans: allMapped, activities: acts, accountIds: [A], navs: n2, fx, currency: 'INR', today: TODAY });

  it('computes a total XIRR and no partial flag', () => {
    expect(v.total.partial).toBe(false);
    expect(v.total.value).toBeCloseTo(13500 + 4000 + 6000, 6);
    expect(v.total.xirr).toBeGreaterThan(0);
    expect(v.unmappedCount).toBe(0);
  });

  it('suppresses XIRR when the history is under 30 days', () => {
    const w = buildMfView({ plans: allMapped, activities: acts, accountIds: [A], navs: n2, fx, currency: 'INR', today: '2026-11-20' });
    expect(w.total.xirr).toBeNull();
  });
});

describe('buildMfView — SELL / DIVIDEND / FEE flows', () => {
  it('treats SELL and DIVIDEND as inflows and fund FEEs as outflows', () => {
    const base = [buy('2026-01-05', 'birla-flexi', 10000, 100, 0.012)];
    const more = [
      ...base,
      { uuid: 'd', date: '2026-07-05', accountId: A, type: 'DIVIDEND', symbol: 'BIRLA-FLEXI', currency: 'INR', amount: 500, fxToUsd: 0.012 },
    ];
    const a = buildMfView({ plans: [plans[0]], activities: base, accountIds: [A], navs, fx, currency: 'INR', today: TODAY });
    const b = buildMfView({ plans: [plans[0]], activities: more, accountIds: [A], navs, fx, currency: 'INR', today: TODAY });
    expect(b.funds[0].xirr).toBeGreaterThan(a.funds[0].xirr);
  });
});

describe('buildMfView — USD view', () => {
  const v = view({ currency: 'USD', plans: [plans[0]], activities: acts.filter(a => a.type !== 'BUY' || a.symbol === 'BIRLA-FLEXI') });
  const f = v.funds[0];

  it('invests at each BUY\'s stored fx and values at the live rate', () => {
    expect(f.invested).toBeCloseTo(5000 * 0.0120 + 5000 * 0.0118, 6);
    expect(f.value).toBeCloseTo(13500 * 0.0125, 6);
    expect(f.gain).toBeCloseTo(f.value - f.invested, 6);
    expect(f.avgCost).toBeCloseTo(f.invested / 90, 6);
  });

  it('splits gain into market and FX parts that add up', () => {
    expect(v.total.fxGain).toBeCloseTo(10000 * 0.0125 - f.invested, 6);
    expect(v.total.marketGain + v.total.fxGain).toBeCloseTo(v.total.gain, 6);
  });

  it('reports the rate basis', () => {
    expect(v.usdPerInr).toBeCloseTo(0.0125, 8);
    expect(v.basis).toMatch(/80/);
  });

  it('does not invent values without a live rate', () => {
    const w = view({ currency: 'USD', fx: null });
    expect(w.rateMissing).toBe(true);
    expect(w.funds.find(x => x.planId === 'birla-flexi').value).toBeNull();
    expect(w.total.value).toBeNull();
    expect(w.cash.display).toBeNull();
  });

  it('converts the cash line at the live rate', () => {
    const w = view({ currency: 'USD', activities: [rcv('2026-11-01', 8000, 0.012)] });
    expect(w.cash.display).toBeCloseTo(8000 * 0.0125, 6);
  });
});

describe('buildMfView — empty and edge states', () => {
  it('has no activity before the first BUY and still lists active plans', () => {
    const v = view({ activities: [] });
    expect(v.hasActivity).toBe(false);
    expect(v.funds.map(f => f.planId)).toEqual(['birla-flexi', 'iti-small-cap', 'sbi-retirement']);
    expect(v.funds.every(f => f.units === 0)).toBe(true);
    expect(v.total.xirr).toBeNull();
  });

  it('matches plan ids case-insensitively against the upper-cased symbol', () => {
    expect(view().funds.find(f => f.planId === 'birla-flexi').units).toBeGreaterThan(0);
  });

  it('shows holdings whose plan row is missing under an Other group', () => {
    const v = view({ plans: [plans[0]] });
    expect(v.funds.find(f => f.planId === 'ITI-SMALL-CAP').amc).toBe('Other');
  });

  it('ignores activities from non-MF accounts', () => {
    const v = view({ activities: [...acts, { ...buy('2026-11-05', 'birla-flexi', 99999, 1, 0.012), accountId: 'fidelity' }] });
    expect(v.funds.find(f => f.planId === 'birla-flexi').invested).toBeCloseTo(10000, 6);
  });
});

describe('mappedCodes / navFor', () => {
  it('lists only numeric scheme codes, deduped', () => {
    expect(mappedCodes([...plans, { id: 'x', schemeCode: '120564' }])).toEqual(['120564', '147919']);
    expect(mappedCodes([{ id: 'u', schemeCode: 'unmapped' }])).toEqual([]);
  });
  it('returns a positive numeric NAV or null', () => {
    expect(navFor(plans[0], navs)).toEqual({ nav: 150, date: '2027-01-30' });
    expect(navFor(plans[2], navs)).toBeNull();
    expect(navFor(plans[0], { 120564: { nav: null } })).toBeNull();
  });
});

describe('fmtMfMoney', () => {
  it('uses Indian grouping for INR and plain grouping for USD', () => {
    expect(fmtMfMoney(123456, 'INR')).toBe('₹1,23,456');
    expect(fmtMfMoney(1234.5, 'USD', 2)).toBe('$1,234.50');
    expect(fmtMfMoney(null, 'INR')).toBe('—');
    expect(fmtMfMoney(-5000, 'INR')).toBe('−₹5,000');
  });
});

describe('scheme picker helpers', () => {
  it('seeds the search per plan', () => {
    expect(searchSeed({ id: 'iti-small-cap', name: 'ITI Small Cap Fund' })).toBe('ITI Small Cap');
    expect(searchSeed({ id: 'birla-flexi', name: 'Birla Flexi Cap Fund' })).toBe('Flexi Cap');
    expect(searchSeed({ id: 'birla-conglomerate', name: 'Birla Conglomerate Fund' })).toBe('Conglomerate');
    expect(searchSeed({ id: 'sbi-retirement', name: 'SBI Retirement Fund' })).toBe('SBI Retirement Benefit');
    expect(searchSeed({ id: 'custom', name: 'My Scheme Direct Growth' })).toBe('My Scheme');
  });

  it('builds the patch: schemeCode always, name only when asked', () => {
    const r = { code: '147919', name: 'ITI Small Cap Fund - Direct Plan - Growth', amc: 'ITI Mutual Fund' };
    expect(mapPatchFor(r, true)).toEqual({ schemeCode: '147919', name: r.name });
    expect(mapPatchFor(r, false)).toEqual({ schemeCode: '147919' });
  });

  it('hints when results hold several sub-plans of one fund', () => {
    const r = (name) => ({ code: name, name, plan: 'direct', option: 'growth' });
    expect(subPlanHint([r('SBI Retirement Benefit Fund - Aggressive Plan - Direct Growth'), r('SBI Retirement Benefit Fund - Conservative Plan - Direct Growth')]))
      .toMatch(/several sub-plans/);
    expect(subPlanHint([r('ITI Small Cap Fund - Direct Growth')])).toBe('');
  });
});
