import { describe, it, expect } from 'vitest';
import {
  isRecurring,
  upsertRecurring,
  removeRecurring,
  resolveImportDate,
  detectRecurring,
  sameRecurring,
  MIN_CONSECUTIVE_MONTHS,
} from '../recurringExpenses.js';

describe('identity is (category, vendor)', () => {
  it('matches regardless of vendor case and padding', () => {
    expect(sameRecurring(
      { category: 'Thakkali', vendor: 'Netflix' },
      { category: 'Thakkali', vendor: '  netflix ' },
    )).toBe(true);
  });

  it('treats the same vendor in a different category as separate', () => {
    expect(sameRecurring(
      { category: 'Thakkali', vendor: 'Amazon' },
      { category: 'Misc', vendor: 'Amazon' },
    )).toBe(false);
  });

  it('isRecurring reads the list', () => {
    const list = [{ category: 'Thakkali', vendor: 'Netflix', amount: 17.68 }];
    expect(isRecurring(list, 'Thakkali', 'NETFLIX')).toBe(true);
    expect(isRecurring(list, 'Misc', 'Netflix')).toBe(false);
    expect(isRecurring(undefined, 'Misc', 'Netflix')).toBe(false);
  });
});

describe('upsertRecurring', () => {
  it('adds a new entry without mutating the original list', () => {
    const list = [];
    const out = upsertRecurring(list, { category: 'Thakkali', vendor: 'Netflix', amount: 17.68 });
    expect(out).toHaveLength(1);
    expect(list).toHaveLength(0);
  });

  it('updates in place rather than duplicating', () => {
    // Re-tagging a vendor must not leave two templates that both import.
    let list = upsertRecurring([], { category: 'Thakkali', vendor: 'Netflix', amount: 17.68 });
    list = upsertRecurring(list, { category: 'Thakkali', vendor: 'netflix', amount: 19.99 });
    expect(list).toHaveLength(1);
    expect(list[0].amount).toBe(19.99);
  });

  it('stores card and day when given', () => {
    const [e] = upsertRecurring([], {
      category: 'Utilities', vendor: 'PG&E', amount: 80, card: 'Chase Freedom Rise', dayOfMonth: 14,
    });
    expect(e.card).toBe('Chase Freedom Rise');
    expect(e.dayOfMonth).toBe(14);
  });

  it('omits card and day rather than storing empty values', () => {
    // Entries written before those fields existed have neither; writing '' or
    // null would make "unset" indistinguishable from "explicitly blank".
    const [e] = upsertRecurring([], { category: 'Thakkali', vendor: 'Netflix', amount: 17.68 });
    expect('card' in e).toBe(false);
    expect('dayOfMonth' in e).toBe(false);
  });

  it('trims the vendor and coerces the amount', () => {
    const [e] = upsertRecurring([], { category: 'C', vendor: '  Spotify ', amount: '11.99' });
    expect(e.vendor).toBe('Spotify');
    expect(e.amount).toBe(11.99);
  });

  it('refuses an entry with no category or vendor', () => {
    expect(upsertRecurring([], { category: '', vendor: 'X', amount: 1 })).toHaveLength(0);
    expect(upsertRecurring([], { category: 'C', vendor: '   ', amount: 1 })).toHaveLength(0);
  });
});

describe('removeRecurring', () => {
  it('removes only the matching entry', () => {
    const list = [
      { category: 'Thakkali', vendor: 'Netflix', amount: 17.68 },
      { category: 'Thakkali', vendor: 'Apple', amount: 9.99 },
    ];
    const out = removeRecurring(list, 'Thakkali', 'NETFLIX');
    expect(out).toHaveLength(1);
    expect(out[0].vendor).toBe('Apple');
  });
});

describe('resolveImportDate', () => {
  it('uses the stored day of month', () => {
    expect(resolveImportDate({ dayOfMonth: 14 }, 2026, 7)).toBe('2026-08-14');
  });

  it('falls back to the 1st for entries with no day', () => {
    // Every template written before this feature is in this state.
    expect(resolveImportDate({}, 2026, 7)).toBe('2026-08-01');
    expect(resolveImportDate(undefined, 2026, 0)).toBe('2026-01-01');
  });

  it('clamps into a short month', () => {
    // A "31st" template imported into February must not roll into March.
    expect(resolveImportDate({ dayOfMonth: 31 }, 2026, 1)).toBe('2026-02-28');
    expect(resolveImportDate({ dayOfMonth: 31 }, 2028, 1)).toBe('2028-02-29');  // leap year
  });

  it('clamps a nonsense day', () => {
    expect(resolveImportDate({ dayOfMonth: 0 }, 2026, 7)).toBe('2026-08-01');
    expect(resolveImportDate({ dayOfMonth: -5 }, 2026, 7)).toBe('2026-08-01');
  });
});

describe('detectRecurring', () => {
  const month = (name, txs) => ({ monthKey: name, transactions: txs });
  const tx = (vendor, amount, txDate = '', category = 'Thakkali', paymentMethod = '') =>
    ({ category, vendor, amount, txDate, paymentMethod });

  it('flags a vendor present in enough consecutive months', () => {
    const found = detectRecurring([
      month('May', [tx('Netflix', 17.68)]),
      month('Jun', [tx('Netflix', 17.68)]),
      month('Jul', [tx('Netflix', 17.68)]),
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ vendor: 'Netflix', category: 'Thakkali', months: 3 });
  });

  it('ignores a vendor that appears in too few months', () => {
    const found = detectRecurring([
      month('May', [tx('Netflix', 17.68)]),
      month('Jun', [tx('Netflix', 17.68)]),
      month('Jul', []),
    ]);
    expect(found).toHaveLength(0);
  });

  it('requires the months to be consecutive', () => {
    // Three appearances with a gap is not a subscription.
    const found = detectRecurring([
      month('Apr', [tx('Netflix', 17.68)]),
      month('May', [tx('Netflix', 17.68)]),
      month('Jun', []),
      month('Jul', [tx('Netflix', 17.68)]),
    ]);
    expect(found).toHaveLength(0);
  });

  it('skips vendors already tagged recurring', () => {
    const existing = [{ category: 'Thakkali', vendor: 'netflix', amount: 17.68 }];
    const found = detectRecurring([
      month('May', [tx('Netflix', 17.68)]),
      month('Jun', [tx('Netflix', 17.68)]),
      month('Jul', [tx('Netflix', 17.68)]),
    ], existing);
    expect(found).toHaveLength(0);
  });

  it('takes the amount, day and card from the most recent month', () => {
    const found = detectRecurring([
      month('May', [tx('Netflix', 15.00, '2026-05-03', 'Thakkali', 'Old Card')]),
      month('Jun', [tx('Netflix', 16.00, '2026-06-03', 'Thakkali', 'Old Card')]),
      month('Jul', [tx('Netflix', 17.68, '2026-07-05', 'Thakkali', 'Chase Freedom Rise')]),
    ]);
    expect(found[0].amount).toBe(17.68);
    expect(found[0].dayOfMonth).toBe(5);
    expect(found[0].card).toBe('Chase Freedom Rise');
  });

  it('marks a bill whose amount moves as varying', () => {
    const found = detectRecurring([
      month('May', [tx('PG&E', 80, '', 'Utilities')]),
      month('Jun', [tx('PG&E', 140, '', 'Utilities')]),
      month('Jul', [tx('PG&E', 95, '', 'Utilities')]),
    ]);
    expect(found[0].varies).toBe(true);
  });

  it('does not mark a steady subscription as varying', () => {
    const found = detectRecurring([
      month('May', [tx('Netflix', 17.68)]),
      month('Jun', [tx('Netflix', 17.68)]),
      month('Jul', [tx('Netflix', 17.68)]),
    ]);
    expect(found[0].varies).toBe(false);
  });

  it('treats the same vendor in two categories separately', () => {
    const found = detectRecurring([
      month('May', [tx('Amazon', 10, '', 'Misc'), tx('Amazon', 20, '', 'Grocery')]),
      month('Jun', [tx('Amazon', 10, '', 'Misc'), tx('Amazon', 20, '', 'Grocery')]),
      month('Jul', [tx('Amazon', 10, '', 'Misc'), tx('Amazon', 20, '', 'Grocery')]),
    ]);
    expect(found).toHaveLength(2);
    expect(found.map(f => f.category).sort()).toEqual(['Grocery', 'Misc']);
  });

  it('counts a month once even when the vendor is charged twice in it', () => {
    const found = detectRecurring([
      month('May', [tx('Netflix', 17.68), tx('Netflix', 17.68)]),
      month('Jun', [tx('Netflix', 17.68)]),
      month('Jul', [tx('Netflix', 17.68)]),
    ]);
    expect(found[0].months).toBe(3);
  });

  it('sorts the most-recurring first', () => {
    const found = detectRecurring([
      month('Apr', [tx('Apple', 9.99)]),
      month('May', [tx('Apple', 9.99), tx('Netflix', 17.68)]),
      month('Jun', [tx('Apple', 9.99), tx('Netflix', 17.68)]),
      month('Jul', [tx('Apple', 9.99), tx('Netflix', 17.68)]),
    ]);
    expect(found[0].vendor).toBe('Apple');
    expect(found[0].months).toBe(4);
  });

  it('handles empty input', () => {
    expect(detectRecurring()).toEqual([]);
    expect(detectRecurring([], [])).toEqual([]);
    expect(detectRecurring([month('May', [])])).toEqual([]);
  });

  it('ignores rows missing a category or vendor', () => {
    const found = detectRecurring([
      month('May', [{ category: '', vendor: 'X', amount: 1 }]),
      month('Jun', [{ category: 'C', vendor: '', amount: 1 }]),
      month('Jul', [{ amount: 1 }]),
    ]);
    expect(found).toEqual([]);
  });

  it('needs exactly MIN_CONSECUTIVE_MONTHS, not more', () => {
    const months = Array.from({ length: MIN_CONSECUTIVE_MONTHS }, (_, i) =>
      month(`M${i}`, [tx('Netflix', 17.68)]));
    expect(detectRecurring(months)).toHaveLength(1);
  });
});

// ── History action ─────────────────────────────────────────────────────────
import { historyAction, WRITE_ACTIONS, METHOD_LABELS } from '../historyActions.js';

describe('historyAction', () => {
  it('gives recurring imports their own action', () => {
    // Previously collapsed to 'Added', so an auto-imported subscription was
    // indistinguishable from a manual entry.
    expect(historyAction('recurring')).toBe('Recurring');
  });

  it('leaves the existing sources alone', () => {
    expect(historyAction('scan')).toBe('Receipt Scan');
    expect(historyAction('import')).toBe('Import');
    expect(historyAction('manual')).toBe('Added');
    expect(historyAction(undefined)).toBe('Added');
  });
});

describe('writer and ledger agree on the action list', () => {
  it('every action the writer can emit is one the ledger reconciles', () => {
    // The drift this guards: an action the writer emits but the ledger doesn't
    // list isn't dropped — the row loses its date and badge and sinks to the
    // bottom of a date sort, which reads as a missing transaction.
    const emitted = new Set(
      ['scan', 'import', 'recurring', 'manual', undefined, 'anything-else'].map(historyAction)
    );
    for (const action of emitted) {
      expect(WRITE_ACTIONS).toContain(action);
    }
  });

  it('every reconciled action has a badge label', () => {
    for (const action of WRITE_ACTIONS) {
      expect(METHOD_LABELS[action]).toBeTruthy();
    }
  });
});
