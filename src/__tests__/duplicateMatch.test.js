import { describe, it, expect } from 'vitest';
import {
  isSameTransaction, findDuplicates, clusterDuplicates, parseRowDate,
  AMOUNT_EPSILON, DEFAULT_WINDOW_DAYS,
} from '../duplicateMatch.js';
import * as backend from '../../functions/lib/_duplicate-match.mjs';

const tx = (vendor, amount, date) => ({ vendor, amount, date });

describe('isSameTransaction', () => {
  it('matches an identical charge', () => {
    expect(isSameTransaction(tx('Costco', 89.5, '2026-05-10'), tx('Costco', 89.5, '2026-05-10'))).toBe(true);
  });

  it('tolerates cent-level rounding between sources', () => {
    expect(isSameTransaction(tx('Costco', 89.5, '2026-05-10'), tx('Costco', 89.53, '2026-05-10'))).toBe(true);
    expect(isSameTransaction(tx('Costco', 89.5, '2026-05-10'), tx('Costco', 89.6, '2026-05-10'))).toBe(false);
  });

  it('matches vendors fuzzily', () => {
    expect(isSameTransaction(tx('COSTCO WHOLESALE #442', 50, '2026-05-10'), tx('Costco', 50, '2026-05-10'))).toBe(true);
  });

  it('rejects a different vendor at the same amount', () => {
    expect(isSameTransaction(tx('Costco', 50, '2026-05-10'), tx('Target', 50, '2026-05-10'))).toBe(false);
  });

  it('matches inside the date window and not outside it', () => {
    const a = tx('Costco', 50, '2026-05-10');
    expect(isSameTransaction(a, tx('Costco', 50, '2026-05-12'))).toBe(true);   // 2 days
    expect(isSameTransaction(a, tx('Costco', 50, '2026-05-13'))).toBe(true);   // exactly 3
    expect(isSameTransaction(a, tx('Costco', 50, '2026-05-14'))).toBe(false);  // 4
  });

  it('does not flag a recurring purchase a week apart', () => {
    // The pre-existing checkDuplicates had no date check and would have called
    // this a duplicate; the window is what prevents that.
    expect(isSameTransaction(tx('Costco', 120, '2026-05-03'), tx('Costco', 120, '2026-05-10'))).toBe(false);
  });

  it('falls back to amount + vendor when a date is missing', () => {
    // Legacy bot rows and some imports genuinely carry no date. Dropping them
    // would stop detecting exactly the duplicates this exists for.
    expect(isSameTransaction(tx('Costco', 50, ''), tx('Costco', 50, '2026-05-10'))).toBe(true);
    expect(isSameTransaction(tx('Costco', 50, ''), tx('Costco', 50, ''))).toBe(true);
  });

  it('rejects unusable amounts rather than guessing', () => {
    expect(isSameTransaction(tx('Costco', null, '2026-05-10'), tx('Costco', 50, '2026-05-10'))).toBe(false);
    expect(isSameTransaction(tx('Costco', 'abc', '2026-05-10'), tx('Costco', 50, '2026-05-10'))).toBe(false);
  });

  it('honours a custom window', () => {
    const a = tx('Costco', 50, '2026-05-10');
    expect(isSameTransaction(a, tx('Costco', 50, '2026-05-20'), 30)).toBe(true);
    expect(isSameTransaction(a, tx('Costco', 50, '2026-05-12'), 0)).toBe(false);
  });
});

describe('parseRowDate', () => {
  it('reads ISO dates and ISO timestamps', () => {
    expect(parseRowDate('2026-05-10')).toBe(Date.parse('2026-05-10T00:00:00Z'));
    // A History timestamp is used as a date stand-in; only the date part counts.
    expect(parseRowDate('2026-05-10T18:30:00Z')).toBe(Date.parse('2026-05-10T00:00:00Z'));
  });

  it('returns null for junk instead of NaN', () => {
    expect(parseRowDate('')).toBeNull();
    expect(parseRowDate(null)).toBeNull();
    expect(parseRowDate('not a date')).toBeNull();
  });
});

describe('findDuplicates', () => {
  const rows = [
    tx('Costco', 89.5, '2026-05-10'),
    tx('Target', 89.5, '2026-05-10'),
    tx('Costco', 12, '2026-05-10'),
  ];

  it('returns only the matching rows', () => {
    expect(findDuplicates(rows, tx('Costco', 89.5, '2026-05-11'))).toEqual([rows[0]]);
  });

  it('returns nothing on a clean candidate', () => {
    expect(findDuplicates(rows, tx('Shell', 40, '2026-05-11'))).toEqual([]);
  });

  it('copes with bad input rather than throwing', () => {
    expect(findDuplicates(null, tx('Costco', 1, ''))).toEqual([]);
    expect(findDuplicates(rows, null)).toEqual([]);
  });
});

describe('clusterDuplicates', () => {
  it('groups two copies of one purchase', () => {
    const rows = [tx('Costco', 89.5, '2026-05-10'), tx('Costco', 89.5, '2026-05-11'), tx('Shell', 40, '2026-05-10')];
    const clusters = clusterDuplicates(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(2);
  });

  it('leaves non-duplicates alone', () => {
    expect(clusterDuplicates([tx('Costco', 10, '2026-05-10'), tx('Shell', 20, '2026-05-10')])).toEqual([]);
  });

  it('keeps three copies of one purchase in a single cluster', () => {
    // Chained: 10↔12 and 12↔14 match, 10↔14 does not. They are still one
    // purchase and should be reviewed together, not split into pairs.
    const rows = [
      tx('Costco', 50, '2026-05-10'),
      tx('Costco', 50, '2026-05-12'),
      tx('Costco', 50, '2026-05-14'),
    ];
    const clusters = clusterDuplicates(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(3);
  });

  it('clusters across categories', () => {
    // The real case: wallet logs to Misc, the receipt is filed under Grocery.
    const rows = [
      { ...tx('Costco', 89.5, '2026-05-10'), category: 'Misc' },
      { ...tx('Costco', 89.5, '2026-05-10'), category: 'Grocery' },
    ];
    const clusters = clusterDuplicates(rows);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].map(r => r.category).sort()).toEqual(['Grocery', 'Misc']);
  });

  it('orders the worst offenders first', () => {
    const rows = [
      tx('Shell', 40, '2026-05-10'), tx('Shell', 40, '2026-05-10'),
      tx('Costco', 50, '2026-05-10'), tx('Costco', 50, '2026-05-10'), tx('Costco', 50, '2026-05-10'),
    ];
    const clusters = clusterDuplicates(rows);
    expect(clusters[0]).toHaveLength(3);   // most copies first
    expect(clusters[0][0].vendor).toBe('Costco');
  });

  it('ignores rows with no usable amount', () => {
    expect(clusterDuplicates([tx('Costco', null, '2026-05-10'), tx('Costco', null, '2026-05-10')])).toEqual([]);
  });
});

describe('frontend/backend mirror parity', () => {
  // src/duplicateMatch.js and functions/lib/_duplicate-match.mjs are duplicated
  // deliberately (the frontend can't import from functions/). This is the guard
  // against them drifting — same pattern as the card resolver and smart rules.
  it('shares the same constants', () => {
    expect(backend.AMOUNT_EPSILON).toBe(AMOUNT_EPSILON);
    expect(backend.DEFAULT_WINDOW_DAYS).toBe(DEFAULT_WINDOW_DAYS);
  });

  it('agrees on every pair exercised above', () => {
    const cases = [
      [tx('Costco', 89.5, '2026-05-10'), tx('Costco', 89.5, '2026-05-10')],
      [tx('Costco', 89.5, '2026-05-10'), tx('Costco', 89.53, '2026-05-10')],
      [tx('COSTCO WHOLESALE #442', 50, '2026-05-10'), tx('Costco', 50, '2026-05-10')],
      [tx('Costco', 50, '2026-05-10'), tx('Target', 50, '2026-05-10')],
      [tx('Costco', 50, '2026-05-10'), tx('Costco', 50, '2026-05-14')],
      [tx('Costco', 120, '2026-05-03'), tx('Costco', 120, '2026-05-10')],
      [tx('Costco', 50, ''), tx('Costco', 50, '2026-05-10')],
      [tx('Costco', null, '2026-05-10'), tx('Costco', 50, '2026-05-10')],
      [tx('', 50, '2026-05-10'), tx('Costco', 50, '2026-05-10')],
    ];
    for (const [a, b] of cases) {
      expect(backend.isSameTransaction(a, b), `mirror drift on ${a.vendor}/${b.vendor}`)
        .toBe(isSameTransaction(a, b));
    }
  });

  it('agrees on fuzzy vendor matching', () => {
    const names = [['Costco', 'COSTCO WHOLESALE'], ['Shell', 'Shell Oil'], ['Target', 'Costco'], ['', 'Costco']];
    for (const [a, b] of names) {
      expect(backend.fuzzyNamesMatch(a, b), `drift on "${a}"/"${b}"`).toBe(
        // The frontend copy lives in sheetHelpers; isSameTransaction is the
        // observable contract, so compare through it at a fixed amount/date.
        isSameTransaction(tx(a, 10, '2026-05-10'), tx(b, 10, '2026-05-10'))
      );
    }
  });
});

/*
 * Sheets serial dates.
 *
 * getRecentExpenses reads with UNFORMATTED_VALUE, so txDate arrives as a serial
 * number (46234), not '2026-07-24'. Date.parse('46234') does NOT return NaN —
 * it returns the year 46234. So parseRowDate produced a non-null date 44,000
 * years in the future, isSameTransaction applied the ±3-day filter instead of
 * skipping it, and every duplicate comparison against a row with a txDate
 * failed. The whole duplicate feature was inert on live data.
 */
describe('Sheets serial dates', () => {
  it('reads a serial as the date it represents', () => {
    // 46234 = 2026-07-31 in Sheets' 1899-12-30 epoch. Confirmed against a real
    // History row whose timestamp was 2026-07-31 and whose txDate was 46234.
    const ms = parseRowDate(46234);
    expect(new Date(ms).toISOString().slice(0, 10)).toBe('2026-07-31');
  });

  it('matches a serial-dated row against an ISO-dated candidate', () => {
    expect(isSameTransaction(
      { vendor: 'WINGSTOP', amount: 16.48, date: 46234 },
      { vendor: 'Wingstop', amount: 16.48, date: '2026-07-31' },
    )).toBe(true);
  });

  it('still respects the window when both sides are serials', () => {
    expect(isSameTransaction(
      { vendor: 'Safeway', amount: 4.19, date: 46234 },
      { vendor: 'Safeway', amount: 4.19, date: '2026-08-24' },
    )).toBe(false);
  });

  it('does not mistake a plain number for a date', () => {
    expect(parseRowDate(42)).toBeNull();
    expect(parseRowDate(999999)).toBeNull();
  });
});
