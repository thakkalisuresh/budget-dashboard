import { describe, it, expect } from 'vitest';
import {
  computeInstallments,
  installmentLabel,
  makeSplitPlan,
  nextInstallmentNumber,
  isPlanComplete,
  nextDueInstallment,
  markPlaced,
  upsertSplitPlan,
  removeSplitPlan,
  activeSplitPlans,
} from '../splitPlans.js';

const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe('computeInstallments', () => {
  it('splits a divisible total evenly', () => {
    expect(computeInstallments(1500, 3)).toEqual([500, 500, 500]);
  });

  it('puts the odd cent on the last installment', () => {
    expect(computeInstallments(1000, 3)).toEqual([333.33, 333.33, 333.34]);
  });

  it('always sums to exactly the total', () => {
    for (const [total, n] of [[1000, 3], [100, 7], [99.99, 4], [0.05, 3], [1234.56, 5]]) {
      expect(sum(computeInstallments(total, n))).toBe(Math.round(total * 100) / 100);
    }
  });

  it('never leaks binary-float artifacts', () => {
    for (const amt of computeInstallments(100, 7)) {
      expect(Math.round(amt * 100) / 100).toBe(amt);
    }
  });

  it('returns the whole total for N=1', () => {
    expect(computeInstallments(1500, 1)).toEqual([1500]);
  });

  it('guards nonsense input', () => {
    expect(computeInstallments(1500, 0)).toEqual([]);
    expect(computeInstallments(1500, -2)).toEqual([]);
    expect(computeInstallments(0, 3)).toEqual([]);
    expect(computeInstallments(-10, 3)).toEqual([]);
    expect(computeInstallments('x', 3)).toEqual([]);
  });

  it('floors a fractional month count', () => {
    expect(computeInstallments(1500, 3.9)).toEqual([500, 500, 500]);
  });
});

describe('installmentLabel', () => {
  it('formats as "Vendor n/N" and trims', () => {
    expect(installmentLabel('Car Insurance', 2, 6)).toBe('Car Insurance 2/6');
    expect(installmentLabel('  Spotify ', 1, 3)).toBe('Spotify 1/3');
  });
});

describe('makeSplitPlan', () => {
  it('coerces amount and count, trims vendor, starts with empty placed', () => {
    const p = makeSplitPlan({ category: 'Car Payments', vendor: ' Car Insurance ', totalAmount: '1500', installments: '3' });
    expect(p).toMatchObject({ category: 'Car Payments', vendor: 'Car Insurance', totalAmount: 1500, installments: 3, placed: [] });
    expect(p.id).toBeTruthy();
  });

  it('omits card and startMonth when unset', () => {
    const p = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 90, installments: 3 });
    expect('card' in p).toBe(false);
    expect('startMonth' in p).toBe(false);
  });

  it('keeps card and startMonth when given', () => {
    const p = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 90, installments: 3, card: 'Chase', startMonth: 'Oct 2025' });
    expect(p.card).toBe('Chase');
    expect(p.startMonth).toBe('Oct 2025');
  });

  it('gives distinct ids', () => {
    const a = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 90, installments: 3 });
    const b = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 90, installments: 3 });
    expect(a.id).not.toBe(b.id);
  });
});

describe('nextInstallmentNumber / isPlanComplete', () => {
  const base = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });

  it('starts at 1 and advances past placed numbers', () => {
    expect(nextInstallmentNumber(base)).toBe(1);
    expect(nextInstallmentNumber({ ...base, placed: [1] })).toBe(2);
    expect(nextInstallmentNumber({ ...base, placed: [1, 2] })).toBe(3);
  });

  it('fills the earliest gap, not just the max+1', () => {
    expect(nextInstallmentNumber({ ...base, placed: [2] })).toBe(1);
  });

  it('is null once all are placed', () => {
    expect(nextInstallmentNumber({ ...base, placed: [1, 2, 3] })).toBe(null);
    expect(isPlanComplete({ ...base, placed: [1, 2, 3] })).toBe(true);
    expect(isPlanComplete(base)).toBe(false);
  });
});

describe('nextDueInstallment', () => {
  it('returns the number, label and amount of the next owed installment', () => {
    const plan = makeSplitPlan({ category: 'Car Payments', vendor: 'Car Insurance', totalAmount: 1500, installments: 3 });
    expect(nextDueInstallment(plan)).toEqual({ number: 1, label: 'Car Insurance 1/3', amount: 500 });
    expect(nextDueInstallment({ ...plan, placed: [1] })).toEqual({ number: 2, label: 'Car Insurance 2/3', amount: 500 });
  });

  it('gives the remainder installment its larger amount', () => {
    const plan = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1000, installments: 3, placed: [1, 2] });
    expect(nextDueInstallment({ ...plan, placed: [1, 2] })).toEqual({ number: 3, label: 'V 3/3', amount: 333.34 });
  });

  it('is null for a complete plan', () => {
    const plan = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });
    expect(nextDueInstallment({ ...plan, placed: [1, 2, 3] })).toBe(null);
  });
});

describe('markPlaced', () => {
  it('records an installment and keeps placed sorted', () => {
    const plan = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });
    expect(markPlaced(plan, 2).placed).toEqual([2]);
    expect(markPlaced(markPlaced(plan, 2), 1).placed).toEqual([1, 2]);
  });

  it('is idempotent', () => {
    const plan = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });
    const once = markPlaced(plan, 1);
    expect(markPlaced(once, 1).placed).toEqual([1]);
  });

  it('does not mutate the original', () => {
    const plan = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });
    markPlaced(plan, 1);
    expect(plan.placed).toEqual([]);
  });
});

describe('upsert / remove / active', () => {
  it('adds then replaces by id without duplicating', () => {
    const p = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });
    let list = upsertSplitPlan([], p);
    expect(list).toHaveLength(1);
    list = upsertSplitPlan(list, markPlaced(p, 1));
    expect(list).toHaveLength(1);
    expect(list[0].placed).toEqual([1]);
  });

  it('refuses an invalid plan', () => {
    expect(upsertSplitPlan([], { id: 'x', category: '', vendor: 'V', installments: 3 })).toHaveLength(0);
    expect(upsertSplitPlan([], { id: 'x', category: 'C', vendor: '', installments: 3 })).toHaveLength(0);
    expect(upsertSplitPlan([], { id: 'x', category: 'C', vendor: 'V', installments: 0 })).toHaveLength(0);
  });

  it('removes by id', () => {
    const p = makeSplitPlan({ category: 'C', vendor: 'V', totalAmount: 1500, installments: 3 });
    expect(removeSplitPlan(upsertSplitPlan([], p), p.id)).toHaveLength(0);
  });

  it('activeSplitPlans drops completed plans', () => {
    const a = makeSplitPlan({ category: 'C', vendor: 'A', totalAmount: 1500, installments: 3 });
    const b = { ...makeSplitPlan({ category: 'C', vendor: 'B', totalAmount: 1500, installments: 3 }), placed: [1, 2, 3] };
    expect(activeSplitPlans([a, b]).map(p => p.vendor)).toEqual(['A']);
    expect(activeSplitPlans([])).toEqual([]);
    expect(activeSplitPlans(undefined)).toEqual([]);
  });
});
