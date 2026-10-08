import { describe, it, expect } from 'vitest';
import { computeOverlap, concentration, aggregatePortfolio, holdingKey } from '../investInsights.js';

// Holdings use the shared contract { name, cusip, ticker, weight } (weight %).
const h = (ticker, weight, extra = {}) => ({ ticker, name: ticker, weight, ...extra });

describe('holdingKey precedence (CUSIP → ticker → name)', () => {
  it('prefers CUSIP when present', () => {
    expect(holdingKey({ cusip: '037833100', ticker: 'AAPL', name: 'Apple' })).toBe('C:037833100');
  });
  it('falls back to ticker, then normalized name', () => {
    expect(holdingKey({ ticker: 'aapl', name: 'Apple' })).toBe('T:AAPL');
    expect(holdingKey({ name: 'Apple Inc.' })).toBe('N:APPLE INC');
    expect(holdingKey({ cusip: '000000000', ticker: 'AAPL' })).toBe('T:AAPL'); // all-zero cusip ignored
  });
});

describe('computeOverlap', () => {
  it('pre-normalized sets → Σ min(wA, wB) (the "overlap 6" parity case)', () => {
    // Inputs already sum to 100, so no renormalization changes them:
    //   A: X=10, Y=90 · B: X=6, Z=94 → shared X → min(10,6) = 6.
    const A = [h('X', 10), h('Y', 90)];
    const B = [h('X', 6), h('Z', 94)];
    const r = computeOverlap(A, B);
    expect(r.overlapPct).toBeCloseTo(6, 5);
    expect(r.sharedCount).toBe(1);
    expect(r.topShared[0]).toMatchObject({ key: 'T:X', wA: 10, wB: 6 });
  });

  it('identical sets → 100', () => {
    const A = [h('X', 60), h('Y', 40)];
    expect(computeOverlap(A, A).overlapPct).toBeCloseTo(100, 5);
  });

  it('disjoint sets → 0', () => {
    expect(computeOverlap([h('X', 100)], [h('Y', 100)]).overlapPct).toBe(0);
  });

  it('renormalizes partial-filing sets against their actual column sum', () => {
    // A sums to 18, B sums to 11 — each is renormalized to 100 before Σ min.
    //   A: X=10/18*100=55.56 · B: X=6/11*100=54.55 → min = 54.55.
    const r = computeOverlap([h('X', 10), h('Y', 8)], [h('X', 6), h('Z', 5)]);
    expect(r.overlapPct).toBeCloseTo(54.55, 1);
    expect(r.sharedCount).toBe(1);
  });

  it('matches on shared CUSIP even when tickers differ/absent', () => {
    const A = [{ cusip: '037833100', weight: 50 }, { cusip: '023135106', weight: 50 }];
    const B = [{ cusip: '037833100', name: 'Apple Inc', weight: 100 }];
    const r = computeOverlap(A, B);
    expect(r.sharedCount).toBe(1);
    expect(r.overlapPct).toBeCloseTo(50, 5); // min(50, 100)
  });

  it('empty input → zero overlap', () => {
    expect(computeOverlap([], [h('X', 100)])).toEqual({ overlapPct: 0, sharedCount: 0, topShared: [] });
  });
});

describe('concentration', () => {
  const equalWeight = (n) => Array.from({ length: n }, (_, i) => h(`S${i}`, 100 / n));

  it('computes HHI / effective-N / top-N for an equal-weight set', () => {
    const c = concentration(equalWeight(4)); // 25% each
    expect(c.numHoldings).toBe(4);
    expect(c.top1).toBeCloseTo(25, 5);
    expect(c.top5).toBeCloseTo(100, 5);
    expect(c.top10).toBeCloseTo(100, 5);
    expect(c.hhi).toBeCloseTo(0.25, 6);      // 4 × 0.25² = 0.25
    expect(c.effectiveN).toBeCloseTo(4, 5);  // 1 / 0.25
  });

  it('verdict boundary around effective-N 100 (>100 is broadly diversified)', () => {
    // Equal-weight N → effective-N = N. Values sit either side of the 100 knife
    // edge (exactly 100 is floating-point fragile, so we don't assert on it).
    expect(concentration(equalWeight(101)).verdict).toBe('broadly diversified');
    expect(concentration(equalWeight(99)).verdict).toBe('moderately concentrated');
  });

  it('verdict boundary around effective-N 30 (>30 is moderately concentrated)', () => {
    expect(concentration(equalWeight(31)).verdict).toBe('moderately concentrated');
    expect(concentration(equalWeight(29)).verdict).toBe('highly concentrated');
    expect(concentration(equalWeight(5)).verdict).toBe('highly concentrated');
  });

  it('renormalizes a partial-filing set before computing', () => {
    // Weights sum to 50; renormalized each doubles → two 50% holdings.
    const c = concentration([h('X', 25), h('Y', 25)]);
    expect(c.top1).toBeCloseTo(50, 5);
    expect(c.hhi).toBeCloseTo(0.5, 6);
    expect(c.effectiveN).toBeCloseTo(2, 5);
  });

  it('empty set → no-data verdict', () => {
    expect(concentration([])).toMatchObject({ numHoldings: 0, verdict: 'no data' });
  });
});

describe('aggregatePortfolio (look-through)', () => {
  const holdings = [
    { symbol: 'VOO', qty: 6, avgCost: 100, costBasis: 600 }, // ETF, value 600 → 60%
    { symbol: 'AAPL', qty: 4, avgCost: 100, costBasis: 400 }, // stock, value 400 → 40%
  ];
  const quotes = { VOO: { price: 100, prevClose: 100 }, AAPL: { price: 100, prevClose: 100 } };
  const etfHoldingsByTicker = {
    VOO: { holdings: [
      { cusip: 'AAA', name: 'Underlying X', ticker: 'X', weight: 60 },
      { cusip: 'BBB', name: 'Underlying Y', ticker: 'Y', weight: 40 },
    ] },
  };

  it('explodes an ETF into underlyings scaled by the position weight', () => {
    const agg = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker });
    const byKey = Object.fromEntries(agg.map((a) => [a.cusip || a.ticker, a.weight]));
    // VOO is 60% of the portfolio; X=60%*60%=36, Y=60%*40%=24; AAPL direct=40.
    expect(byKey.AAA).toBeCloseTo(36, 4);
    expect(byKey.BBB).toBeCloseTo(24, 4);
    expect(byKey.AAPL).toBeCloseTo(40, 4);
    expect(agg.reduce((s, a) => s + a.weight, 0)).toBeCloseTo(100, 4);
  });

  it('keeps an ETF as a single direct holding when no look-through is available', () => {
    const agg = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker: {} });
    const voo = agg.find((a) => a.ticker === 'VOO');
    expect(voo).toBeTruthy();
    expect(voo.weight).toBeCloseTo(60, 4);
  });

  it('merges a security held both directly and inside an ETF by shared key', () => {
    // AAPL direct (ticker key) + an ETF underlying also keyed by ticker AAPL.
    const etf = { VOO: { holdings: [{ ticker: 'AAPL', name: 'Apple', weight: 100 }] } };
    const agg = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker: etf });
    const aapl = agg.filter((a) => a.ticker === 'AAPL');
    expect(aapl).toHaveLength(1);           // merged, not duplicated
    expect(aapl[0].weight).toBeCloseTo(100, 4); // 60% (via VOO) + 40% (direct)
  });

  it('empty portfolio → empty set', () => {
    expect(aggregatePortfolio({ holdings: [], quotes: {}, etfHoldingsByTicker: {} })).toEqual([]);
  });
});
