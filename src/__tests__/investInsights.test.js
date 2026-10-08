import { describe, it, expect } from 'vitest';
import {
  computeOverlap, concentration, aggregatePortfolio, holdingKey,
  buildCusipTickerMap, canonicalizeHolding, canonicalizeHoldings,
  evaluateCandidate, buildCandidateReport,
  fiftyTwoWeekPosition, valuationFactors, analystSnapshot,
} from '../investInsights.js';

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

// ════════════════════════════════════════════════════════════════════════════
// PR2 — CUSIP↔ticker reconciliation
// ════════════════════════════════════════════════════════════════════════════

const APPLE_CUSIP = '037833100';

describe('buildCusipTickerMap', () => {
  it('maps CUSIP→ticker from rows that have both, first-seen wins', () => {
    const map = buildCusipTickerMap([
      { cusip: APPLE_CUSIP, ticker: 'AAPL' },
      { cusip: APPLE_CUSIP, ticker: 'WRONG' }, // duplicate — ignored
      { cusip: '594918104', holdingTicker: 'MSFT' }, // raw-row shape
      { cusip: '000000000', ticker: 'ZZ' }, // all-zero cusip ignored
      { cusip: '', ticker: 'NOPE' },         // no cusip
      { cusip: '11111111X', ticker: '' },    // no ticker
    ]);
    expect(map.get(APPLE_CUSIP)).toBe('AAPL');
    expect(map.get('594918104')).toBe('MSFT');
    expect(map.has('000000000')).toBe(false);
    expect(map.size).toBe(2);
  });

  it('tolerates empty/missing input', () => {
    expect(buildCusipTickerMap().size).toBe(0);
    expect(buildCusipTickerMap([]).size).toBe(0);
  });
});

describe('canonicalizeHolding(s)', () => {
  const map = new Map([[APPLE_CUSIP, 'AAPL']]);

  it('rewrites a resolvable CUSIP holding to its ticker, clearing the cusip', () => {
    const out = canonicalizeHolding({ cusip: APPLE_CUSIP, name: 'Apple Inc', weight: 5 }, map);
    expect(out).toMatchObject({ ticker: 'AAPL', cusip: '', weight: 5 });
    expect(holdingKey(out)).toBe('T:AAPL');
  });

  it('is a no-op without a map, resolution, or usable cusip', () => {
    const h = { cusip: '594918104', weight: 1 };
    expect(canonicalizeHolding(h, map)).toBe(h);       // unresolved cusip
    expect(canonicalizeHolding(h, null)).toBe(h);      // no map
    expect(canonicalizeHoldings([h], new Map())).toEqual([h]); // empty map
  });
});

describe('aggregatePortfolio reconciles direct stock with an ETF underlying by CUSIP', () => {
  // VOO (ETF) holds Apple by CUSIP only (no ticker); user also holds AAPL directly.
  const holdings = [
    { symbol: 'VOO', qty: 6, avgCost: 100, costBasis: 600 },  // 60%
    { symbol: 'AAPL', qty: 4, avgCost: 100, costBasis: 400 }, // 40%
  ];
  const quotes = { VOO: { price: 100, prevClose: 100 }, AAPL: { price: 100, prevClose: 100 } };
  const etfHoldingsByTicker = {
    VOO: { holdings: [
      { cusip: APPLE_CUSIP, name: 'Apple Inc', ticker: '', weight: 100 }, // Apple by CUSIP, no ticker
    ] },
  };

  it('WITHOUT a map they stay distinct (C:… and T:AAPL)', () => {
    const agg = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker });
    const keys = agg.map(holdingKey).sort();
    expect(keys).toEqual([`C:${APPLE_CUSIP}`, 'T:AAPL']);
  });

  it('WITH the map they collapse to one T:AAPL holding at 100%', () => {
    const cusipTicker = new Map([[APPLE_CUSIP, 'AAPL']]);
    const agg = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker, cusipTicker });
    expect(agg).toHaveLength(1);
    expect(holdingKey(agg[0])).toBe('T:AAPL');
    expect(agg[0].weight).toBeCloseTo(100, 4); // 60% via VOO + 40% direct
    // Overlap of a pure-AAPL candidate is now 100 (was 40 without reconciliation).
    const candidate = canonicalizeHoldings([{ cusip: APPLE_CUSIP, weight: 100 }], cusipTicker);
    expect(computeOverlap(candidate, agg).overlapPct).toBeCloseTo(100, 4);
    // Concentration reflects the merge: a single effective holding.
    expect(concentration(agg).effectiveN).toBeCloseTo(1, 4);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PR2 — evaluateCandidate (the rule-check)
// ════════════════════════════════════════════════════════════════════════════

describe('evaluateCandidate', () => {
  const T = { overlapPct: 60, concentrationPct: 25, near52wkPct: 5, sectorCapPct: 80 };
  const find = (r, id) => r.flags.find((f) => f.id === id);

  it('overlap flag: strictly above the line is caution, at/under is pass', () => {
    expect(find(evaluateCandidate({ overlap: 60, thresholds: T }), 'overlap').severity).toBe('pass');
    expect(find(evaluateCandidate({ overlap: 60.01, thresholds: T }), 'overlap').severity).toBe('caution');
  });

  it('single-position flag at the concentration cap boundary', () => {
    expect(find(evaluateCandidate({ posPctAfter: 25, thresholds: T }), 'position').severity).toBe('pass');
    expect(find(evaluateCandidate({ posPctAfter: 25.5, thresholds: T }), 'position').severity).toBe('caution');
  });

  it('concentration-worsens flag fires when effective-N drops', () => {
    const worse = evaluateCandidate({ concBefore: { effectiveN: 40 }, concAfter: { effectiveN: 30 }, thresholds: T });
    expect(find(worse, 'concentration').severity).toBe('caution');
    const same = evaluateCandidate({ concBefore: { effectiveN: 40 }, concAfter: { effectiveN: 40 }, thresholds: T });
    expect(find(same, 'concentration').severity).toBe('pass');
  });

  it('near-52wk flag: within the threshold of the high is caution', () => {
    expect(find(evaluateCandidate({ near52wkPct: 5, thresholds: T }), 'near52wk').severity).toBe('caution'); // at 5% → within
    expect(find(evaluateCandidate({ near52wkPct: 6, thresholds: T }), 'near52wk').severity).toBe('pass');
  });

  it('analyst trend maps improving→pass, deteriorating→caution, flat→neutral', () => {
    expect(find(evaluateCandidate({ analystTrend: 'improving' }), 'analyst').severity).toBe('pass');
    expect(find(evaluateCandidate({ analystTrend: 'deteriorating' }), 'analyst').severity).toBe('caution');
    expect(find(evaluateCandidate({ analystTrend: 'flat' }), 'analyst').severity).toBe('neutral');
  });

  it('omits flags whose inputs are absent (graceful), and counts caution/pass', () => {
    const r = evaluateCandidate({ overlap: 70, posPctAfter: 10, analystTrend: 'improving', thresholds: T });
    expect(r.flags.map((f) => f.id).sort()).toEqual(['analyst', 'overlap', 'position']);
    expect(r.cautionCount).toBe(1); // overlap
    expect(r.passCount).toBe(2);    // position + analyst
    // no concentration / near52wk flags since those inputs were absent
    expect(find(r, 'concentration')).toBeUndefined();
    expect(find(r, 'near52wk')).toBeUndefined();
  });

  it('never emits a sector-cap flag (deferred this PR)', () => {
    const r = evaluateCandidate({ overlap: 10, posPctAfter: 10, near52wkPct: 10, analystTrend: 'flat', thresholds: T });
    expect(r.flags.some((f) => f.id === 'sector')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PR2 — market-factor extractors + buildCandidateReport robustness
// ════════════════════════════════════════════════════════════════════════════

describe('market-factor extractors degrade on missing fields', () => {
  it('fiftyTwoWeekPosition computes distance-below-high and range position', () => {
    const p = fiftyTwoWeekPosition({ metric: { '52WeekHigh': 200, '52WeekLow': 100 } }, 150);
    expect(p.nearHighPct).toBeCloseTo(25, 2); // (200-150)/200
    expect(p.rangePct).toBeCloseTo(50, 2);    // (150-100)/(200-100)
  });
  it('returns null when the metric or price is absent', () => {
    expect(fiftyTwoWeekPosition(null, 150)).toBeNull();
    expect(fiftyTwoWeekPosition({ metric: { '52WeekHigh': 200 } }, null)).toBeNull();
  });
  it('valuationFactors falls back peTTM→peBasicExclExtraTTM and nulls missing', () => {
    expect(valuationFactors({ metric: { peBasicExclExtraTTM: 30, beta: 1.2 } })).toEqual({ peTTM: 30, beta: 1.2 });
    expect(valuationFactors({})).toEqual({ peTTM: null, beta: null });
  });
  it('analystSnapshot derives trend from the latest two periods', () => {
    const rec = [
      { strongBuy: 6, buy: 4, hold: 2, sell: 0, strongSell: 0, period: '2026-10-01' },
      { strongBuy: 3, buy: 4, hold: 2, sell: 1, strongSell: 0, period: '2026-09-01' },
    ];
    expect(analystSnapshot(rec).trend).toBe('improving');
    expect(analystSnapshot([rec[0]]).trend).toBeNull(); // single period → no trend
    expect(analystSnapshot([]).counts).toBeNull();
  });
});

describe('buildCandidateReport', () => {
  const holdings = [
    { symbol: 'VOO', qty: 6, avgCost: 100, costBasis: 600 },
    { symbol: 'AAPL', qty: 4, avgCost: 100, costBasis: 400 },
  ];
  const quotes = { VOO: { price: 100, prevClose: 100 }, AAPL: { price: 100, prevClose: 100 } };
  const positions = [
    { symbol: 'VOO', value: 600 }, { symbol: 'AAPL', value: 400 },
  ];
  const agg = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker: {} });

  it('assembles overlap + concentration + flags with a full market payload', () => {
    const market = {
      quote: { price: 180 },
      metric: { metric: { '52WeekHigh': 200, '52WeekLow': 120, peTTM: 28, beta: 1.1 } },
      recommendation: [
        { strongBuy: 5, buy: 5, hold: 1, sell: 0, strongSell: 0, period: '2026-10-01' },
        { strongBuy: 2, buy: 5, hold: 1, sell: 2, strongSell: 0, period: '2026-09-01' },
      ],
    };
    const r = buildCandidateReport({
      candidateTicker: 'AAPL', candidateHoldings: [{ ticker: 'AAPL', name: 'Apple', weight: 100 }],
      aggPortfolio: agg, positions, portfolioTotal: 1000, amount: 500, market,
      thresholds: { overlapPct: 60, concentrationPct: 25, near52wkPct: 5, sectorCapPct: 80 },
    });
    expect(r.ticker).toBe('AAPL');
    expect(r.overlap.overlapPct).toBeGreaterThan(0); // AAPL overlaps the direct AAPL holding
    expect(r.concAfter).not.toBeNull();              // amount given → delta computed
    expect(r.posPctAfter).toBeGreaterThan(0);
    expect(r.factors.pos52.nearHighPct).toBeCloseTo(10, 2);
    expect(r.factors.analyst.trend).toBe('improving');
    expect(r.evaluation.flags.length).toBeGreaterThan(0);
  });

  it('no crash and no conc-delta when amount is blank and market fields are missing', () => {
    const r = buildCandidateReport({
      candidateTicker: 'NVDA', candidateHoldings: [{ ticker: 'NVDA', name: 'Nvidia', weight: 100 }],
      aggPortfolio: agg, positions, portfolioTotal: 1000, amount: 0, market: {},
      thresholds: {},
    });
    expect(r.concAfter).toBeNull();
    expect(r.posPctAfter).toBeNull();
    expect(r.factors.pos52).toBeNull();
    expect(r.factors.analyst.trend).toBeNull();
    // Only the overlap flag can fire with no amount / no market data.
    expect(r.evaluation.flags.every((f) => f.id === 'overlap')).toBe(true);
  });
});
