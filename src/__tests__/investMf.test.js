import { describe, it, expect } from 'vitest';
import {
  settlesNote, settlesTargetUuid, inrCashBalance, inrPool, inTransitDeposits, mfUsdCostBasis,
} from '../investMf.js';
import { deriveHoldings } from '../investMath.js';

const A = 'nro-mf';
const dep = (uuid, date, amount) => ({ uuid, date, accountId: A, type: 'DEPOSIT', currency: 'USD', fxToUsd: 1, amount });
const rcv = (uuid, date, inr, usd, settles) => ({
  uuid, date, accountId: A, type: 'INR_RECEIVED', currency: 'INR', amount: inr, fxToUsd: usd / inr, note: settlesNote(settles),
});
const buy = (uuid, date, inr, nav, fx, symbol = 'birla-flexi') => ({
  uuid, date, accountId: A, type: 'BUY', symbol, currency: 'INR', qty: inr / nav, price: nav, amount: inr, fxToUsd: fx,
});

describe('settles note', () => {
  it('round-trips the deposit uuid', () => {
    expect(settlesNote('act_1')).toBe('settles:act_1');
    expect(settlesTargetUuid('settles:act_1')).toBe('act_1');
    expect(settlesTargetUuid('whatever')).toBe('');
  });
});

describe('inrCashBalance', () => {
  it('is INR received minus SIP debits and fees on that account only', () => {
    const acts = [
      dep('d1', '2026-11-01', 230),
      rcv('r1', '2026-11-03', 20000, 230, 'd1'),
      buy('b1', '2026-11-05', 5000, 50, 0.0115),
      buy('b2', '2026-11-05', 5000, 25, 0.0115, 'sbi-retirement'),
      { uuid: 'f', date: '2026-11-06', accountId: A, type: 'FEE', currency: 'INR', amount: 20 },
      { uuid: 'x', date: '2026-11-06', accountId: 'fidelity', type: 'BUY', symbol: 'VOO', amount: 999 },
    ];
    expect(inrCashBalance(acts, A)).toBe(9980);
  });
  it('is 0 with only a USD deposit in transit', () => {
    expect(inrCashBalance([dep('d1', '2026-11-01', 230)], A)).toBe(0);
  });
});

describe('inrPool (average-cost FX)', () => {
  it('averages fx across receipts and spends at the average', () => {
    const acts = [
      rcv('r1', '2026-11-03', 10000, 115, 'd1'),   // 0.0115
      rcv('r2', '2026-12-03', 10000, 110, 'd2'),   // 0.0110
      buy('b1', '2026-12-05', 5000, 50, 0.01125),
    ];
    const pool = inrPool(acts, A);
    expect(pool.inr).toBeCloseTo(15000, 6);
    expect(pool.fx).toBeCloseTo(0.01125, 8);
    expect(pool.usd).toBeCloseTo(168.75, 4);
  });
  it('processes a same-day receipt before the debit', () => {
    const acts = [buy('b1', '2026-11-05', 5000, 50, 0.0115), rcv('r1', '2026-11-05', 20000, 230, 'd1')];
    expect(inrPool(acts, A).inr).toBe(15000);
  });
  it('returns fx null on an empty pool', () => {
    expect(inrPool([], A)).toEqual({ inr: 0, usd: 0, fx: null });
  });
});

describe('inTransitDeposits', () => {
  it('lists USD deposits with no INR_RECEIVED referencing them', () => {
    const acts = [
      dep('d1', '2026-11-01', 230),
      dep('d2', '2026-12-01', 230),
      rcv('r1', '2026-11-03', 20000, 230, 'd1'),
      { ...dep('h1', '2026-12-01', 1000), accountId: 'amex-hysa' },
    ];
    const t = inTransitDeposits(acts, [{ id: A, type: 'mf_in' }, { id: 'amex-hysa', type: 'hysa' }]);
    expect(t.map(d => d.uuid)).toEqual(['d2']);
  });
});

describe('mfUsdCostBasis', () => {
  it('sums INR buys at their stored fx', () => {
    const acts = [buy('b1', '2026-11-05', 5000, 50, 0.0115), buy('b2', '2026-12-05', 5000, 40, 0.011)];
    expect(mfUsdCostBasis(acts, 'birla-flexi')).toBeCloseTo(57.5 + 55, 6);
  });
  it('reduces proportionally on a SELL and ignores other symbols', () => {
    const acts = [
      buy('b1', '2026-11-05', 5000, 50, 0.0115),           // 100 units, $57.5
      { uuid: 's', date: '2026-12-01', accountId: A, type: 'SELL', symbol: 'birla-flexi', currency: 'INR', qty: 50, price: 60, amount: 3000, fxToUsd: 0.011 },
      buy('o', '2026-11-05', 5000, 50, 0.0115, 'other'),
    ];
    expect(mfUsdCostBasis(acts, 'birla-flexi')).toBeCloseTo(28.75, 6);
  });
  it('works with deriveHoldings keyed by plan id (INR lots)', () => {
    const h = deriveHoldings([buy('b1', '2026-11-05', 5000, 50, 0.0115)]);
    expect(h[0]).toMatchObject({ symbol: 'BIRLA-FLEXI', costBasis: 5000 });
  });
});

import { pendingItemizations } from '../investItemize.js';

describe('mf_in does not leak into existing USD paths', () => {
  it('USD deposits on mf_in are never queued for brokerage itemization', () => {
    const accounts = [{ id: A, type: 'mf_in', name: 'NRO' }, { id: 'fidelity', type: 'brokerage', name: 'F' }];
    expect(pendingItemizations([dep('d1', '2026-11-01', 230)], accounts)).toEqual([]);
  });
  it('INR_RECEIVED/BUY on mf_in do not move deriveHoldings unless the account is included', () => {
    const acts = [rcv('r1', '2026-11-03', 20000, 230, 'd1')];
    expect(deriveHoldings(acts)).toEqual([]);
  });
});
