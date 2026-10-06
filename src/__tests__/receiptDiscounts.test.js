import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyDiscounts, normDiscountCode } from '../receiptDiscounts.js';
import * as server from '../../functions/lib/_receipt-discounts.mjs';
import { groupItems } from '../splitResolve.js';

/**
 * applyDiscounts nets Costco instant-savings lines into the item they reference
 * (by article code) BEFORE anything categorizes or groups them. See
 * receiptDiscounts.js for the phantom-charge bug this kills.
 */

describe('applyDiscounts — matching', () => {
  it('nets a discount into the item it references (real receipt case)', () => {
    const { items, unmatched, remainderAdjustment } = applyDiscounts(
      [{ name: 'SCOTCHNSODA', amount: 17.99, code: '1860911' }],
      [{ applies_to_code: '1860911', amount: 4 }],
    );
    expect(items).toEqual([{ name: 'SCOTCHNSODA', amount: 13.99, code: '1860911', discount: 4 }]);
    expect(unmatched).toEqual([]);
    expect(remainderAdjustment).toBe(0);
  });

  it('matches even when codes differ only by punctuation / leading zeros', () => {
    const { items } = applyDiscounts(
      [{ name: 'NATIVE BW', amount: 26.99, code: '0002067295' }],
      [{ applies_to_code: '2067295', amount: 7 }],
    );
    expect(items[0].amount).toBe(19.99);
  });

  it('ignores the sign of the discount amount (−7 and 7 behave alike)', () => {
    const neg = applyDiscounts([{ name: 'X', amount: 10, code: 'c1' }], [{ applies_to_code: 'c1', amount: -3 }]);
    const pos = applyDiscounts([{ name: 'X', amount: 10, code: 'c1' }], [{ applies_to_code: 'c1', amount: 3 }]);
    expect(neg.items[0].amount).toBe(7);
    expect(pos.items[0].amount).toBe(7);
  });
});

describe('applyDiscounts — unmatched', () => {
  it('keeps the item whole and reports the discount as a remainder adjustment', () => {
    const { items, unmatched, remainderAdjustment } = applyDiscounts(
      [{ name: 'MILK', amount: 5, code: 'c1' }],
      [{ applies_to_code: 'c9', amount: 4 }], // references no present item (OCR dropped it)
    );
    expect(items).toEqual([{ name: 'MILK', amount: 5, code: 'c1' }]);
    expect(unmatched).toEqual([{ code: 'c9', amount: 4 }]);
    expect(remainderAdjustment).toBe(-4); // never dropped — folds into the tax/fees remainder
  });

  it('treats a discount with no code at all as unmatched', () => {
    const { unmatched, remainderAdjustment } = applyDiscounts(
      [{ name: 'MILK', amount: 5, code: 'c1' }],
      [{ amount: 2 }],
    );
    expect(unmatched).toEqual([{ code: null, amount: 2 }]);
    expect(remainderAdjustment).toBe(-2);
  });
});

describe('applyDiscounts — duplicate code (one discount per unit)', () => {
  it('a single discount nets the first unit, leaving the others whole', () => {
    const { items } = applyDiscounts(
      [
        { name: 'SCOTCHNSODA', amount: 17.99, code: '1860911' },
        { name: 'SCOTCHNSODA', amount: 5.00, code: '1860911' },
      ],
      [{ applies_to_code: '1860911', amount: 4 }],
    );
    expect(items[0].amount).toBe(13.99);
    expect(items[1].amount).toBe(5.00);
  });

  it('distributes one discount per unit across identical items (not all onto the first)', () => {
    const { items, remainderAdjustment } = applyDiscounts(
      [
        { name: 'SCOTCHNSODA', amount: 17.99, code: '1860911' },
        { name: 'SCOTCHNSODA', amount: 17.99, code: '1860911' },
      ],
      [
        { applies_to_code: '1860911', amount: 4 },
        { applies_to_code: '1860911', amount: 4 },
      ],
    );
    expect(items.map(i => i.amount)).toEqual([13.99, 13.99]); // not [9.99, 17.99]
    expect(remainderAdjustment).toBe(0);
  });

  it('folds an extra discount (more lines than units) into the remainder', () => {
    const { items, unmatched, remainderAdjustment } = applyDiscounts(
      [{ name: 'SCOTCHNSODA', amount: 17.99, code: '1860911' }],
      [
        { applies_to_code: '1860911', amount: 4 },
        { applies_to_code: '1860911', amount: 4 }, // no second unit to land on
      ],
    );
    expect(items[0].amount).toBe(13.99);
    expect(unmatched).toEqual([]); // the code exists — it's an extra, not unmatched
    expect(remainderAdjustment).toBe(-4);
  });
});

describe('applyDiscounts — over-discount (clamp + carry)', () => {
  it('clamps the item at 0 and carries the overflow into the remainder adjustment', () => {
    const { items, remainderAdjustment } = applyDiscounts(
      [{ name: 'CHEAP', amount: 3, code: 'c1' }],
      [{ applies_to_code: 'c1', amount: 4 }],
    );
    // A $0 line is nothing to categorize, so it is dropped from the product list.
    expect(items).toEqual([]);
    expect(remainderAdjustment).toBe(-1); // the $1 the item couldn't absorb
  });

  it('drops an item a coupon zeroes out exactly, with no overflow', () => {
    const { items, remainderAdjustment } = applyDiscounts(
      [{ name: 'FREE', amount: 4, code: 'c1' }],
      [{ applies_to_code: 'c1', amount: 4 }],
    );
    expect(items).toEqual([]);
    expect(remainderAdjustment).toBe(0);
  });
});

describe('applyDiscounts — discount leaked into items[] as a negative amount', () => {
  it('pulls it out as a discount signal and nets it by code', () => {
    const { items } = applyDiscounts([
      { name: 'SCOTCHNSODA', amount: 17.99, code: '1860911' },
      { name: 'INSTANT SAVINGS', amount: -4, code: '1860911' },
    ]);
    expect(items).toEqual([{ name: 'SCOTCHNSODA', amount: 13.99, code: '1860911', discount: 4 }]);
  });

  it('never lets a negative amount survive into the returned items', () => {
    const { items } = applyDiscounts([
      { name: 'A', amount: 10, item_category: 'Grocery', code: 'c1' },
      { name: 'DISCOUNT', amount: -4, item_category: 'Misc', code: 'c1' },
    ]);
    expect(items.some(i => i.amount < 0)).toBe(false);
  });
});

describe('applyDiscounts — robustness', () => {
  it('handles empty / missing / non-array inputs', () => {
    expect(applyDiscounts()).toEqual({ items: [], unmatched: [], remainderAdjustment: 0 });
    expect(applyDiscounts(null, null)).toEqual({ items: [], unmatched: [], remainderAdjustment: 0 });
    expect(applyDiscounts([{ name: 'A', amount: 5 }], undefined).items).toEqual([{ name: 'A', amount: 5 }]);
  });

  it('leaves a non-numeric item amount untouched for downstream guards', () => {
    const { items } = applyDiscounts([{ name: 'WEIRD', amount: 'n/a' }], []);
    expect(items).toEqual([{ name: 'WEIRD', amount: 'n/a' }]);
  });

  it('skips a zero-amount discount', () => {
    const { items, remainderAdjustment } = applyDiscounts([{ name: 'A', amount: 5, code: 'c1' }], [{ applies_to_code: 'c1', amount: 0 }]);
    expect(items[0].amount).toBe(5);
    expect(remainderAdjustment).toBe(0);
  });
});

/**
 * Fails-without-the-fix regression. Routes the raw extraction through the REAL
 * grouping used on save (groupItems). Without the applyDiscounts guard a
 * discount line survives as a negative category total — the exact bug class
 * (its sign-flipped twin was the +$4 phantom charge). If applyDiscounts were
 * neutered to a passthrough, the first and third assertions below go red.
 */
describe('regression: a −amount survives into a category without the guard', () => {
  const raw = [
    { name: 'SCOTCHNSODA', amount: 17.99, item_category: 'Grocery', code: '1860911' },
    { name: 'INSTANT SAVINGS', amount: -4, item_category: 'Misc', code: '1860911' },
  ];

  it('shows the defect the guard removes, then proves the guard removes it', () => {
    // The bug: feed the raw items straight to the grouper and the −4 lands in a
    // category as a negative total.
    const rawGroups = groupItems(raw.map(it => ({ ...it, category: it.item_category })));
    expect(rawGroups.Misc).toBe(-4);

    // The guard: net the saving into the item it references first.
    const { items } = applyDiscounts(raw);
    expect(items.some(i => i.amount < 0)).toBe(false);
    const fixed = groupItems(items.map(it => ({ ...it, category: it.item_category })));
    expect(fixed.Misc).toBeUndefined();
    expect(fixed.Grocery).toBe(13.99);
  });
});

/**
 * Drift-guard: the bot (Cloud Functions) cannot import the client module, so the
 * logic is duplicated. Drift is silent — one surface would net discounts and the
 * other wouldn't. The bodies are compared verbatim below the marker, and the
 * behaviour is spot-checked on shared fixtures.
 */
describe('receiptDiscounts client/server parity', () => {
  const read = (p) => readFileSync(resolve(process.cwd(), p), 'utf8');
  const marker = '/** Round to cents';
  const body = (src) => src.slice(src.indexOf(marker));

  it('implementations are byte-identical below the header', () => {
    expect(body(read('functions/lib/_receipt-discounts.mjs'))).toBe(body(read('src/receiptDiscounts.js')));
  });

  it('normDiscountCode agrees', () => {
    for (const c of ['1860911', '0002067295', ' 18-609/11 ', null, 42]) {
      expect(server.normDiscountCode(c)).toBe(normDiscountCode(c));
    }
  });

  it('applyDiscounts agrees on representative receipts', () => {
    const cases = [
      [[{ name: 'A', amount: 17.99, code: '1860911' }], [{ applies_to_code: '1860911', amount: 4 }]],
      [[{ name: 'A', amount: 5, code: 'c1' }], [{ applies_to_code: 'c9', amount: 4 }]],
      [[{ name: 'A', amount: 3, code: 'c1' }], [{ applies_to_code: 'c1', amount: 4 }]],
      [[{ name: 'A', amount: 10, code: 'c1' }, { name: 'D', amount: -4, code: 'c1' }], []],
      [[{ name: 'A', amount: 17.99, code: 'c1' }, { name: 'B', amount: 17.99, code: 'c1' }],
       [{ applies_to_code: 'c1', amount: 4 }, { applies_to_code: 'c1', amount: 4 }]],
    ];
    for (const [items, discounts] of cases) {
      expect(server.applyDiscounts(items, discounts)).toEqual(applyDiscounts(items, discounts));
    }
  });
});
