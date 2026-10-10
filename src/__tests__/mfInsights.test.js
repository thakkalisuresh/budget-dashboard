import { describe, it, expect } from 'vitest';
import sample from './fixtures/mfHoldings.sample.json';
import {
  buildMfInsights, fundKeyFor, categoryGroup, groupHoldings, pairOverlap,
  sanitizeMfThresholds, DEFAULT_MF_THRESHOLDS, STALE_AFTER_DAYS,
} from '../mfInsights.js';

const TODAY = '2026-10-10';
const fund = (planId, over = {}) => ({
  planId, name: planId, schemeCode: 'unmapped', amountInr: 5000, active: true, units: 0, valueInr: null, ...over,
});
const FOUR = [
  fund('birla-flexi', { schemeCode: '120564', name: 'Aditya Birla Sun Life Flexi Cap Fund - Direct Plan - Growth' }),
  fund('birla-conglomerate', { name: 'Birla Conglomerate Fund' }),
  fund('sbi-retirement', { name: 'SBI Retirement Fund' }),
  fund('iti-small-cap', { schemeCode: '147919', name: 'ITI Small Cap Fund - Direct Plan - Growth' }),
];
const NAVS = {
  120564: { name: 'Aditya Birla Sun Life Flexi Cap Fund - Direct Plan - Growth', categoryKey: 'Equity: Flexi Cap Fund' },
  147919: { name: 'ITI Small Cap Fund - Direct Plan - Growth', categoryKey: 'Equity: Small Cap Fund' },
};
const holdings = (rows = sample, statusByFund = {}) => ({ rows, statusByFund, asOfByFund: {}, missing: false });
const mkRow = (fundKey, isin, weightPct, over = {}) => ({
  asOf: '2026-09-30', fundKey, isin, name: isin, industry: 'Banks', assetClass: 'equity', weightPct, marketValueInrLakh: null, sourceFile: 't', ...over,
});

describe('fundKeyFor', () => {
  it('maps known AMFI codes and scheme names', () => {
    expect(fundKeyFor({ schemeCode: '120564' })).toBe('absl-flexi-cap');
    expect(fundKeyFor({ schemeCode: '153124' })).toBe('absl-conglomerate');
    expect(fundKeyFor({ schemeCode: '147919' })).toBe('iti-small-cap');
    expect(fundKeyFor({ schemeCode: '148685' })).toBe('sbi-retirement-aggressive-hybrid');
    expect(fundKeyFor({ schemeCode: '103166', name: 'Aditya Birla Sun Life Flexi Cap Fund - Regular Plan - Growth' })).toBe('absl-flexi-cap');
  });
  it('reads the SBI sub-plan from the scheme name, hybrid variants first', () => {
    const k = (name) => fundKeyFor({ schemeCode: '999999', name });
    expect(k('SBI Retirement Benefit Fund - Aggressive Hybrid Plan - Direct Plan - Growth')).toBe('sbi-retirement-aggressive-hybrid');
    expect(k('SBI Retirement Benefit Fund - Aggressive Plan - Direct')).toBe('sbi-retirement-aggressive');
    expect(k('SBI Retirement Benefit Fund - Conservative Hybrid Plan')).toBe('sbi-retirement-conservative-hybrid');
    expect(k('SBI Retirement Benefit Fund - Conservative Plan')).toBe('sbi-retirement-conservative');
    expect(k('SBI Retirement Benefit Fund')).toBeNull();
  });
  it('falls back to the plan id only while the plan is unmapped; sbi-retirement stays unknown', () => {
    expect(fundKeyFor({ schemeCode: 'unmapped', planId: 'birla-flexi' })).toBe('absl-flexi-cap');
    expect(fundKeyFor({ schemeCode: 'unmapped', planId: 'birla-conglomerate' })).toBe('absl-conglomerate');
    expect(fundKeyFor({ schemeCode: 'unmapped', planId: 'iti-small-cap' })).toBe('iti-small-cap');
    expect(fundKeyFor({ schemeCode: 'unmapped', planId: 'sbi-retirement', name: 'SBI Retirement Fund' })).toBeNull();
    // mapped to something unrelated: the seeded plan id must not leak in
    expect(fundKeyFor({ schemeCode: '100001', name: 'Some Other Fund', planId: 'birla-flexi' })).toBeNull();
  });
});

describe('categoryGroup', () => {
  it('buckets category keys', () => {
    expect(categoryGroup('Equity: Flexi Cap Fund')).toBe('equity');
    expect(categoryGroup('Hybrid: Aggressive Hybrid Fund')).toBe('hybrid');
    expect(categoryGroup('Solution Oriented: Retirement Fund')).toBe('solution');
    expect(categoryGroup('Other: Retirement')).toBe('solution');
    expect(categoryGroup('Debt: Liquid Fund')).toBe('debt');
    expect(categoryGroup(null)).toBe('other');
  });
});

describe('sanitizeMfThresholds', () => {
  it('keeps valid numbers and defaults the rest', () => {
    const t = sanitizeMfThresholds({ pairOverlapPct: 30, sectorPct: -5, singleStockPct: 'x', categoryPct: 120, sipSharePct: 0 });
    expect(t.pairOverlapPct).toBe(30);
    expect(t.sectorPct).toBe(DEFAULT_MF_THRESHOLDS.sectorPct);
    expect(t.singleStockPct).toBe(DEFAULT_MF_THRESHOLDS.singleStockPct);
    expect(t.categoryPct).toBe(DEFAULT_MF_THRESHOLDS.categoryPct);
    expect(t.sipSharePct).toBe(DEFAULT_MF_THRESHOLDS.sipSharePct);
    expect(sanitizeMfThresholds(null)).toEqual(DEFAULT_MF_THRESHOLDS);
    expect(sanitizeMfThresholds('junk')).toEqual(DEFAULT_MF_THRESHOLDS);
  });
  it('never lets the info marker sit above the watch marker', () => {
    expect(sanitizeMfThresholds({ pairOverlapPct: 10 }).pairOverlapInfoPct).toBe(10);
  });
});

describe('pair overlap (research proof of concept, 30-Sep-2026 files)', () => {
  const g = groupHoldings(sample);
  it('ABSL Flexi x Conglomerate: 20.7% of NAV raw, 14 common stocks', () => {
    const o = pairOverlap(g.get('absl-flexi-cap'), g.get('absl-conglomerate'));
    expect(o.rawPct).toBe(20.7);
    expect(o.commonCount).toBe(14);
  });
  it('normalised to each fund’s equity the same pair is 21.1%', () => {
    expect(pairOverlap(g.get('absl-flexi-cap'), g.get('absl-conglomerate')).overlapPct).toBe(21.1);
  });
  it('other pairs stay in the research ballpark; top shared names are the largest overlaps', () => {
    expect(pairOverlap(g.get('absl-flexi-cap'), g.get('iti-small-cap')).rawPct).toBe(10);
    expect(pairOverlap(g.get('absl-conglomerate'), g.get('iti-small-cap')).rawPct).toBe(5.4);
    const top = pairOverlap(g.get('absl-flexi-cap'), g.get('absl-conglomerate')).topShared;
    expect(top.length).toBe(5);
    expect(top[0].wA).toBeGreaterThan(0);
  });
});

describe('groupHoldings', () => {
  it('keeps only each fund’s latest asOf and merges duplicate ISINs', () => {
    const g = groupHoldings([
      mkRow('f', 'INE1', 5, { asOf: '2026-08-31' }),
      mkRow('f', 'INE1', 3), mkRow('f', 'INE1', 2), mkRow('f', 'INE2', 4),
      mkRow('f', 'INF9', 8, { assetClass: 'debt' }),
    ]).get('f');
    expect(g.asOf).toBe('2026-09-30');
    expect(g.byKey.get('INE1').weightPct).toBe(5);
    expect(g.equityPct).toBe(9);
    expect(g.weightSum).toBe(17);
  });
  it('ignores derivative notionals and negative cash entirely; debt ratings never become sectors', () => {
    const g = groupHoldings([
      mkRow('f', 'INE1', 50), mkRow('f', '', 90, { assetClass: 'derivative', name: 'Future' }),
      mkRow('f', '', -0.3, { assetClass: 'cash' }), mkRow('f', 'INE2', 30, { assetClass: 'debt', industry: 'AAA' }),
    ]).get('f');
    expect(g.weightSum).toBe(80);
    expect(g.equityPct).toBe(50);
    expect(g.byKey.size).toBe(1);
    const r = buildMfInsights({ funds: [FOUR[0]], navs: NAVS, holdings: holdings([mkRow('absl-flexi-cap', 'INE1', 60), mkRow('absl-flexi-cap', 'INE2', 30, { assetClass: 'debt', industry: 'AAA' })]), today: TODAY });
    expect(r.exposure.sectors.map(x => x.sector)).toEqual(['Banks']);
  });
  it('drops rows with no usable weight and tolerates empty input', () => {
    expect(groupHoldings([mkRow('f', 'A', 'x'), mkRow('f', 'B', 0), mkRow('f', 'C', -1)]).size).toBe(0);
    expect(groupHoldings(null).size).toBe(0);
  });
});

describe('buildMfInsights', () => {
  const run = (over = {}) => buildMfInsights({ funds: FOUR, navs: NAVS, holdings: holdings(), today: TODAY, ...over });

  it('with the real-sample mock setup: SIP basis, SBI skipped, category mix from live + assumed', () => {
    const r = run();
    expect(r.basis).toBe('sip');
    expect(r.categoryMix.map(c => [c.categoryKey, c.pct])).toEqual([
      ['Equity: Flexi Cap Fund', 25], ['Equity: Small Cap Fund', 25], ['Equity: Thematic Fund', 25], ['Solution Oriented: Retirement Fund', 25],
    ].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    expect(r.categoryMix.find(c => c.categoryKey === 'Equity: Thematic Fund').assumed).toBe(true);
    expect(r.categoryMix.find(c => c.categoryKey === 'Equity: Flexi Cap Fund').assumed).toBe(false);
    expect(r.groupMix).toEqual({ equity: 75, solution: 25 });
    expect(r.exposure.coveredFunds.sort()).toEqual(['absl-conglomerate', 'absl-flexi-cap', 'iti-small-cap']);
    expect(r.exposure.coveragePct).toBe(75);
    expect(r.exposure.lowerBound).toBe(true);
    expect(r.notes.some(n => n.kind === 'unknown' && /sub-plan/.test(n.message))).toBe(true);
    expect(r.holdings.status).toBe('partial');
  });

  it('flags the Flexi x Conglomerate overlap as info (21.1% is between 15 and 25)', () => {
    const f = run().flags.find(x => x.id === 'overlap-absl-flexi-cap-absl-conglomerate');
    expect(f.severity).toBe('info');
    expect(f.numbers).toMatchObject({ overlapPct: 21.1, rawPct: 20.7, commonCount: 14 });
    expect(f.asOf).toEqual(['2026-09-30']);
    expect(f.message).toMatch(/14 of the same stocks/);
  });

  it('thresholds are honoured', () => {
    const watch = run({ thresholds: { pairOverlapPct: 20 } }).flags.find(x => x.id.startsWith('overlap-absl-flexi-cap-absl-cong'));
    expect(watch.severity).toBe('watch');
    const none = run({ thresholds: { pairOverlapPct: 90, pairOverlapInfoPct: 80 } }).flags.find(x => x.id.startsWith('overlap-absl-flexi-cap-absl-cong'));
    expect(none).toBeUndefined();
  });

  it('portfolio exposure: Reliance is the biggest shared stock; weights add up', () => {
    const r = run();
    const ex = r.exposure;
    expect(ex.top10.length).toBe(10);
    expect(ex.top10[0].pct).toBeGreaterThanOrEqual(ex.top10[1].pct);
    // Σ stock exposure equals Σ (portfolio weight × equity coverage) over covered funds
    const g = groupHoldings(sample);
    const expected = ['absl-flexi-cap', 'absl-conglomerate', 'iti-small-cap'].reduce((s, k) => s + 0.25 * g.get(k).equityPct, 0);
    expect(ex.equityOfPortfolioPct).toBeCloseTo(expected, 0);
    expect(ex.effectiveN).toBeGreaterThan(20);
    expect(ex.sectors.length).toBeGreaterThan(3);
  });

  it('single-stock and sector caps raise watch flags', () => {
    const r = run({ thresholds: { singleStockPct: 2, sectorPct: 3 } });
    expect(r.flags.some(f => f.id.startsWith('stock-') && f.severity === 'watch')).toBe(true);
    expect(r.flags.some(f => f.id.startsWith('sector-') && f.severity === 'watch')).toBe(true);
  });

  it('switches to value weights when every active fund has a market value', () => {
    const valued = FOUR.map((f, i) => ({ ...f, valueInr: [30000, 10000, 10000, 10000][i] }));
    const r = run({ funds: valued });
    expect(r.basis).toBe('value');
    expect(r.categoryMix[0]).toMatchObject({ categoryKey: 'Equity: Flexi Cap Fund', pct: 50 });
    expect(r.flags.some(f => f.id.startsWith('category-'))).toBe(false); // exactly at the 50% cap, not above
    const r2 = run({ funds: valued, thresholds: { categoryPct: 40 } });
    expect(r2.flags.find(f => f.id === 'category-Equity: Flexi Cap Fund').severity).toBe('watch');
  });

  it('SIP-split: a dominant fund, value divergence, and the lock-in note', () => {
    const funds = [
      fund('birla-flexi', { schemeCode: '120564', name: 'x', amountInr: 2500, valueInr: 90000 }),
      fund('iti-small-cap', { schemeCode: '147919', name: 'y', amountInr: 2500, valueInr: 10000 }),
      fund('sbi-ret', { schemeCode: '148685', name: 'SBI Retirement Benefit Fund - Aggressive Hybrid Plan', amountInr: 5000, valueInr: 5000 }),
    ];
    const r = buildMfInsights({ funds, navs: NAVS, holdings: null, today: TODAY });
    expect(r.basis).toBe('value');
    expect(r.flags.find(f => f.id === 'sip-share-sbi-ret')).toMatchObject({ severity: 'watch', numbers: { sipSharePct: 50, capPct: 40 } });
    expect(r.flags.find(f => f.id === 'sip-value-birla-flexi').numbers).toMatchObject({ sipSharePct: 25, valueSharePct: 85.7 });
    expect(r.flags.find(f => f.id === 'lock-in-sbi-ret').message).toMatch(/5 years from each instalment/);
    // a 40% share is not "above 40%"
    const edge = buildMfInsights({ funds: [{ ...funds[0], amountInr: 4000 }, { ...funds[1], amountInr: 6000 }], navs: NAVS, today: TODAY });
    expect(edge.flags.some(f => f.id.startsWith('sip-share-'))).toBe(true); // 60% flagged…
    expect(edge.flags.some(f => f.id === 'sip-share-birla-flexi')).toBe(false); // …40% is not
  });

  it('inactive plans are excluded from the SIP split', () => {
    const r = run({ funds: [...FOUR, fund('old', { amountInr: 50000, active: false })] });
    expect(r.sipSplit.map(s => s.planId)).not.toContain('old');
    expect(r.sipSplit[0].sipSharePct).toBe(25);
  });

  it('no holdings: still returns category mix and SIP split, says holdings are not available', () => {
    const r = run({ holdings: { rows: [], statusByFund: {}, asOfByFund: {}, missing: true } });
    expect(r.holdings.status).toBe('no-holdings');
    expect(r.categoryMix.length).toBeGreaterThan(0);
    expect(r.sipSplit.length).toBe(4);
    expect(r.overlap.pairs).toEqual([]);
    expect(r.notes.some(n => n.kind === 'no-holdings')).toBe(true);
    expect(buildMfInsights({ funds: FOUR, navs: NAVS, holdings: null, today: TODAY }).holdings.status).toBe('no-holdings');
  });

  it('empty portfolio and a single fund do not blow up', () => {
    expect(buildMfInsights({ funds: [], today: TODAY }).headline).toMatch(/No active funds/);
    const one = buildMfInsights({ funds: [FOUR[0]], navs: NAVS, holdings: holdings(), today: TODAY });
    expect(one.overlap.pairs).toEqual([]);
    expect(one.exposure.coveragePct).toBe(100);
    expect(one.exposure.lowerBound).toBe(false);
    expect(one.categoryMix[0].pct).toBe(100);
  });

  it('stale holdings (older than 45 days) get a visible note; failed status keeps rows with the reason', () => {
    const old = sample.map(r => ({ ...r, asOf: '2026-08-15' }));
    const r = run({ holdings: holdings(old) });
    expect(r.notes.some(n => n.kind === 'stale')).toBe(true);
    expect(r.holdings.funds.find(f => f.fundKey === 'absl-flexi-cap')).toMatchObject({ available: true, stale: true, ageDays: 56 });
    expect(STALE_AFTER_DAYS).toBe(45);
    const failed = run({ holdings: holdings(sample, { 'iti-small-cap': { status: 'failed', reason: 'file not found' } }) });
    const note = failed.notes.find(n => n.id === 'status-iti-small-cap');
    expect(note.message).toMatch(/failed.*file not found.*2026-09-30/);
    expect(failed.holdings.funds.find(f => f.fundKey === 'iti-small-cap').available).toBe(true);
  });

  it('exactly 45 days old is not stale', () => {
    const r = run({ holdings: holdings(sample), today: '2026-11-14' });
    expect(r.notes.some(n => n.kind === 'stale')).toBe(false);
    expect(run({ today: '2026-11-15' }).notes.some(n => n.kind === 'stale')).toBe(true);
  });

  it('weights not summing to ~100 are called out; duplicate ISINs do not double count a name', () => {
    const rows = [mkRow('absl-flexi-cap', 'INE1', 10), mkRow('absl-flexi-cap', 'INE1', 5)];
    const r = buildMfInsights({ funds: [FOUR[0]], navs: NAVS, holdings: holdings(rows), today: TODAY });
    expect(r.notes.some(n => n.kind === 'data')).toBe(true);
    expect(r.exposure.stockCount).toBe(1);
    expect(r.exposure.top10[0].pct).toBe(15);
  });

  it('sub-plan confirmed: the SBI Aggressive Hybrid plan joins the overlap matrix', () => {
    const funds = FOUR.map(f => f.planId === 'sbi-retirement'
      ? { ...f, schemeCode: '148685', name: 'SBI Retirement Benefit Fund - Aggressive Hybrid Plan - Direct Plan - Growth' } : f);
    const r = run({ funds });
    expect(r.overlap.funds).toContain('sbi-retirement-aggressive-hybrid');
    expect(r.overlap.pairs.length).toBe(6);
    expect(r.exposure.coveragePct).toBe(100);
    expect(r.notes.some(n => n.kind === 'unknown')).toBe(false);
  });

  it('copy stays neutral: no advice wording anywhere in flags or notes', () => {
    const r = run({ thresholds: { pairOverlapPct: 5, singleStockPct: 1, sectorPct: 5, categoryPct: 10, sipSharePct: 10, lockInSharePct: 10 } });
    const text = [...r.flags.map(f => f.message), ...r.notes.map(n => n.message), r.headline].join(' ');
    expect(r.flags.length).toBeGreaterThan(5);
    expect(text).not.toMatch(/\b(buy|sell|switch|should|consider|reduce|recommend|exit)\b/i);
  });
});
