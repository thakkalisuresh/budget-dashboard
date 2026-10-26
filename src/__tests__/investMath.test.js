import { describe, it, expect } from 'vitest';
import {
  FDIC_MAX, goalPct, blendedApy, monthlyInterest, futureValue,
  monthsToGoal, horizonLabel, deriveHoldings, valuePortfolio,
  concentrationAfterBuy, isEtf,
} from '../investMath.js';

describe('goalPct', () => {
  it('computes percent of the $250k FDIC goal', () => {
    expect(goalPct(41250)).toBeCloseTo(16.5, 5);
    expect(goalPct(28400)).toBeCloseTo(11.36, 2);
  });
  it('clamps to 0–100 and handles zero goal', () => {
    expect(goalPct(300000)).toBe(100);
    expect(goalPct(-5)).toBe(0);
    expect(goalPct(100, 0)).toBe(0);
  });
});

describe('blendedApy', () => {
  it('weights APY by balance', () => {
    const apy = blendedApy([
      { balance: 28400, apy: 3.7 },
      { balance: 41250, apy: 4.4 },
    ]);
    expect(apy).toBeCloseTo(4.114, 2);
  });
  it('returns 0 with no balances', () => {
    expect(blendedApy([])).toBe(0);
    expect(blendedApy([{ balance: 0, apy: 4 }])).toBe(0);
  });
});

describe('monthlyInterest', () => {
  it('is a simple monthly slice of APY', () => {
    expect(monthlyInterest(41250, 4.4)).toBeCloseTo(151.25, 2);
  });
});

describe('futureValue', () => {
  it('matches compound interest with contributions', () => {
    // $10k at 12% APY (1%/mo) + $100/mo for 12 months
    const fv = futureValue(10000, 12, 100, 12);
    expect(fv).toBeCloseTo(10000 * 1.01 ** 12 + 100 * ((1.01 ** 12 - 1) / 0.01), 2);
  });
  it('handles zero rate as linear savings', () => {
    expect(futureValue(1000, 0, 100, 10)).toBe(2000);
  });
});

describe('monthsToGoal', () => {
  it('is 0 when already at the goal', () => {
    expect(monthsToGoal(FDIC_MAX, 4, 100)).toBe(0);
  });
  it('is Infinity when unreachable', () => {
    expect(monthsToGoal(1000, 0, 0)).toBe(Infinity);
  });
  it('inverts futureValue (FV at n months ≥ goal, at n−1 < goal)', () => {
    const n = monthsToGoal(41250, 4.4, 1000);
    expect(futureValue(41250, 4.4, 1000, n)).toBeGreaterThanOrEqual(FDIC_MAX);
    expect(futureValue(41250, 4.4, 1000, n - 1)).toBeLessThan(FDIC_MAX);
  });
  it('handles zero rate with contributions', () => {
    expect(monthsToGoal(0, 0, 1000, 12000)).toBe(12);
  });
});

describe('horizonLabel', () => {
  it('formats months, years, unreachable, reached', () => {
    expect(horizonLabel(8)).toBe('8 mo');
    expect(horizonLabel(150)).toBe('≈13 yrs');
    expect(horizonLabel(Infinity)).toBe('—');
    expect(horizonLabel(0)).toBe('reached');
  });
});

describe('deriveHoldings', () => {
  const buys = [
    { date: '2026-01-05', type: 'BUY', symbol: 'VOO', qty: 10, price: 500 },
    { date: '2026-02-05', type: 'BUY', symbol: 'VOO', qty: 8, price: 520 },
    { date: '2026-01-10', type: 'BUY', symbol: 'aapl', qty: 25, price: 220 },
  ];

  it('accumulates lots and average cost', () => {
    const h = deriveHoldings(buys);
    const voo = h.find(x => x.symbol === 'VOO');
    expect(voo.qty).toBe(18);
    expect(voo.costBasis).toBe(10 * 500 + 8 * 520);
    expect(voo.lots).toHaveLength(2);
    expect(voo.avgCost).toBeCloseTo((5000 + 4160) / 18, 4);
    // symbols normalised to upper case
    expect(h.find(x => x.symbol === 'AAPL').qty).toBe(25);
  });

  it('consumes lots FIFO on sell', () => {
    const h = deriveHoldings([
      ...buys,
      { date: '2026-03-01', type: 'SELL', symbol: 'VOO', qty: 12, price: 530 },
    ]);
    const voo = h.find(x => x.symbol === 'VOO');
    expect(voo.qty).toBe(6);
    // first lot (10 @ 500) fully consumed, 2 of the 520 lot consumed
    expect(voo.lots).toHaveLength(1);
    expect(voo.lots[0].price).toBe(520);
    expect(voo.costBasis).toBeCloseTo(6 * 520, 4);
  });

  it('drops fully-sold positions and clamps oversells', () => {
    const h = deriveHoldings([
      { date: '2026-01-05', type: 'BUY', symbol: 'NVDA', qty: 5, price: 100 },
      { date: '2026-02-05', type: 'SELL', symbol: 'NVDA', qty: 9, price: 120 },
    ]);
    expect(h.find(x => x.symbol === 'NVDA')).toBeUndefined();
  });

  it('tracks dividends without changing qty', () => {
    const h = deriveHoldings([
      { date: '2026-01-05', type: 'BUY', symbol: 'MSFT', qty: 8, price: 400 },
      { date: '2026-03-10', type: 'DIVIDEND', symbol: 'MSFT', amount: 6.16 },
    ]);
    const msft = h.find(x => x.symbol === 'MSFT');
    expect(msft.qty).toBe(8);
    expect(msft.dividends).toBeCloseTo(6.16);
  });

  it('sorts by date before folding (out-of-order input)', () => {
    const h = deriveHoldings([
      { date: '2026-03-01', type: 'SELL', symbol: 'VTI', qty: 5, price: 300 },
      { date: '2026-01-01', type: 'BUY', symbol: 'VTI', qty: 15, price: 280 },
    ]);
    expect(h.find(x => x.symbol === 'VTI').qty).toBe(10);
  });
});

describe('valuePortfolio', () => {
  const holdings = deriveHoldings([
    { date: '2026-01-05', type: 'BUY', symbol: 'VOO', qty: 18, price: 480 },
    { date: '2026-01-05', type: 'BUY', symbol: 'NVDA', qty: 32, price: 150 },
  ]);

  it('values with quotes, computes weights + day change + splits', () => {
    const p = valuePortfolio(holdings, {
      VOO:  { price: 512.4, prevClose: 509.3 },
      NVDA: { price: 171.9, prevClose: 172.62 },
    });
    expect(p.total).toBeCloseTo(18 * 512.4 + 32 * 171.9, 2);
    expect(p.dayChange).toBeCloseTo(18 * (512.4 - 509.3) + 32 * (171.9 - 172.62), 2);
    const voo = p.positions.find(x => x.symbol === 'VOO');
    expect(voo.weight).toBeCloseTo((voo.value / p.total) * 100, 5);
    expect(p.etfPct + p.stockPct).toBeCloseTo(100, 5);
    expect(p.etfPct).toBeCloseTo((voo.value / p.total) * 100, 5); // VOO is the only ETF
    expect(p.maxWeight).toBeCloseTo(Math.max(...p.positions.map(x => x.weight)), 5);
  });

  it('falls back to avg cost when a quote is missing and flags stale', () => {
    const p = valuePortfolio(holdings, { VOO: { price: 512.4, prevClose: 512.4 } });
    const nvda = p.positions.find(x => x.symbol === 'NVDA');
    expect(nvda.price).toBe(150);
    expect(nvda.stale).toBe(true);
    expect(nvda.dayChange).toBe(0);
  });
});

describe('concentrationAfterBuy', () => {
  it('computes before/after weights against the post-buy total', () => {
    const positions = [{ symbol: 'NVDA', value: 5500 }];
    const { before, after } = concentrationAfterBuy(positions, 28358, 'NVDA', 2000);
    expect(before).toBeCloseTo((5500 / 28358) * 100, 3);
    expect(after).toBeCloseTo((7500 / 30358) * 100, 3);
  });
});

describe('isEtf', () => {
  it('detects defaults and user extras, case-insensitively', () => {
    expect(isEtf('voo')).toBe(true);
    expect(isEtf('NVDA')).toBe(false);
    expect(isEtf('NVDA', ['nvda'])).toBe(true);
  });
});

import { xirr, convert, activityUsd, monthlyDeposits } from '../investMath.js';

describe('xirr', () => {
  it('matches a simple one-year 10% case', () => {
    const r = xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 1100 }]);
    expect(r).toBeCloseTo(0.1, 3);
  });
  it('solves a monthly SIP stream', () => {
    const flows = [];
    for (let m = 0; m < 12; m++) flows.push({ date: `2025-${String(m + 1).padStart(2, '0')}-05`, amount: -5000 });
    flows.push({ date: '2026-01-05', amount: 63000 });
    const r = xirr(flows);
    expect(r).toBeGreaterThan(0.05);
    expect(r).toBeLessThan(0.2);
    // The returned rate zeroes the NPV.
    const t0 = Date.parse('2025-01-05');
    const npv = flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (Date.parse(f.date) - t0) / 86400000 / 365), 0);
    expect(Math.abs(npv)).toBeLessThan(0.5);
  });
  it('handles a loss (negative rate)', () => {
    const r = xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: 800 }]);
    expect(r).toBeCloseTo(-0.2, 3);
  });
  it('is order-independent', () => {
    const r = xirr([{ date: '2026-01-01', amount: 1100 }, { date: '2025-01-01', amount: -1000 }]);
    expect(r).toBeCloseTo(0.1, 3);
  });
  it('returns null when it cannot be defined', () => {
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: '2025-01-01', amount: -1000 }])).toBeNull();
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2026-01-01', amount: -5 }])).toBeNull(); // no sign change
    expect(xirr([{ date: '2025-01-01', amount: 1000 }, { date: '2026-01-01', amount: 5 }])).toBeNull();
    expect(xirr([{ date: '2025-01-01', amount: -1000 }, { date: '2025-01-01', amount: 1100 }])).toBeNull(); // same day
    expect(xirr([{ date: 'bad', amount: -1 }, { date: '2025-01-01', amount: 2 }])).toBeNull();
  });
  it('falls back to bisection for extreme returns', () => {
    const r = xirr([{ date: '2025-01-01', amount: -100 }, { date: '2025-02-01', amount: 1000 }]);
    expect(r).toBeGreaterThan(100);
  });
});

describe('convert', () => {
  it('converts both ways at USD-per-INR', () => {
    expect(convert(20000, 'INR', 'USD', 0.0115)).toBeCloseTo(230, 6);
    expect(convert(230, 'USD', 'INR', 0.0115)).toBeCloseTo(20000, 4);
  });
  it('is identity for same currency and null for a bad rate', () => {
    expect(convert(5, 'USD', 'USD', 0)).toBe(5);
    expect(convert(5, 'INR', 'USD', 0)).toBeNull();
    expect(convert(5, 'INR', 'USD', null)).toBeNull();
  });
});

describe('activityUsd', () => {
  it('passes USD and legacy rows through', () => {
    expect(activityUsd({ amount: 100, currency: 'USD', fxToUsd: 1 })).toBe(100);
    expect(activityUsd({ amount: 100 })).toBe(100);
  });
  it('uses the stored fx for INR rows, null when missing', () => {
    expect(activityUsd({ amount: 5000, currency: 'INR', fxToUsd: 0.0115 })).toBeCloseTo(57.5, 6);
    expect(activityUsd({ amount: 5000, currency: 'INR', fxToUsd: null })).toBeNull();
  });
});

describe('monthlyDeposits', () => {
  const acts = [
    { type: 'DEPOSIT', date: '2026-10-02', amount: 1000, currency: 'USD' },
    { type: 'DEPOSIT', date: '2026-10-05', amount: 230, currency: 'USD', accountId: 'nro-mf' },
    { type: 'INR_RECEIVED', date: '2026-10-08', amount: 20000, currency: 'INR', fxToUsd: 0.0115 },
    { type: 'DEPOSIT', date: '2026-10-09', amount: 99999, currency: 'INR' },
    { type: 'DEPOSIT', date: '2026-09-30', amount: 500 },
  ];
  it('sums only this month\'s USD deposits (mf_in USD counts, INR never)', () => {
    expect(monthlyDeposits(acts, '2026-10')).toBe(1230);
  });
});
