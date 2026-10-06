import { describe, it, expect } from 'vitest';
import {
  normalizeItemName, vendorKey, reduceMemoryRows, lookupLearned,
  learnedExamples, buildMemoryRows, itemsInSplit, MEMORY_HEADER, MAX_MEMORY_ROWS,
} from '../itemMemory.js';

const H = MEMORY_HEADER;
const row = (user, vendor, item, category, at, splitId = '') => [user, vendor, item, category, at, splitId];

describe('normalizeItemName', () => {
  it('strips the store-brand prefix so KS and plain names agree', () => {
    expect(normalizeItemName('KS ORG PNT BTR')).toBe(normalizeItemName('ORG PNT BTR'));
    expect(normalizeItemName('KIRKLAND SIGNATURE Paper Towels')).toBe('paper towels');
  });

  it('strips Costco item numbers from either end', () => {
    expect(normalizeItemName('1234567 SPINDRIFT')).toBe('spindrift');
    expect(normalizeItemName('SPINDRIFT 1234567')).toBe('spindrift');
    // A short number is part of the name, not a SKU.
    expect(normalizeItemName('7UP')).toBe('7up');
  });

  it('ignores pack size, so a resized product is still the same product', () => {
    expect(normalizeItemName('SPINDRIFT 24 ct')).toBe(normalizeItemName('SPINDRIFT 12ct'));
    expect(normalizeItemName('OLIVE OIL 2 L')).toBe(normalizeItemName('OLIVE OIL'));
  });

  it('keeps size/unit tokens rather than over-reduce a name to a <=2 char key', () => {
    // Stripping brand "KS" + unit "2DZ" would leave a 2-char "fr" — a key a
    // different short item could silently inherit the learned category of.
    expect(normalizeItemName('KS FR 2DZ')).toBe('fr 2dz');
    expect(normalizeItemName('KS FR 2DZ')).not.toBe('fr');
    // Brand-strip still makes the branded and plain forms agree…
    expect(normalizeItemName('KS FR 2DZ')).toBe(normalizeItemName('FR 2DZ'));
    // …while genuinely different pack sizes stay distinct.
    expect(normalizeItemName('FR 1DZ')).not.toBe(normalizeItemName('FR 2DZ'));
  });

  it('still collapses aggressively when the stripped key is long enough', () => {
    expect(normalizeItemName('KS ORG PNT BTR 24OZ')).toBe('org pnt btr');
    expect(normalizeItemName('KS ORG PNT BTR 24OZ')).toBe(normalizeItemName('ORG PNT BTR'));
  });

  it('ignores punctuation and case', () => {
    expect(normalizeItemName('Ben & Jerry\'s')).toBe(normalizeItemName('BEN & JERRYS'));
    expect(normalizeItemName('  Milk  ')).toBe('milk');
  });

  it('returns empty for junk rather than a key that matches everything', () => {
    expect(normalizeItemName('')).toBe('');
    expect(normalizeItemName('   ')).toBe('');
    expect(normalizeItemName(null)).toBe('');
  });
});

describe('vendorKey', () => {
  it('collapses formatting differences in the vendor name', () => {
    expect(vendorKey('COSTCO WHOLESALE #1234')).toBe('costco wholesale 1234');
    expect(vendorKey('Costco')).toBe(vendorKey('costco  '));
  });
});

describe('reduceMemoryRows + lookupLearned', () => {
  const rows = [
    H,
    row('me@x.com', 'Costco', 'KS ORG PNT BTR', 'Grocery', '2026-01-01'),
    row('me@x.com', 'Costco', 'PAPER TOWELS', 'Misc', '2026-01-02'),
    row('other@x.com', 'Costco', 'BANANAS', 'Health', '2026-01-03'),
  ];

  it('reads back what this user filed', () => {
    const m = reduceMemoryRows(rows, 'me@x.com');
    expect(lookupLearned(m, 'Costco', 'KS ORG PNT BTR')).toBe('Grocery');
    expect(lookupLearned(m, 'Costco', 'Paper Towels')).toBe('Misc');
  });

  it('matches through normalization, not just exact strings', () => {
    const m = reduceMemoryRows(rows, 'me@x.com');
    // Different spelling of the same product on a later receipt.
    expect(lookupLearned(m, 'COSTCO', 'ORG PNT BTR 16 oz')).toBe('Grocery');
  });

  it('never returns another user\'s answer from the shared tab', () => {
    const m = reduceMemoryRows(rows, 'me@x.com');
    expect(lookupLearned(m, 'Costco', 'BANANAS')).toBeNull();
  });

  it('keeps memory scoped per vendor', () => {
    const m = reduceMemoryRows(rows, 'me@x.com');
    // Same abbreviation, different store — a cross-store match would be a
    // confident wrong answer.
    expect(lookupLearned(m, 'Safeway', 'KS ORG PNT BTR')).toBeNull();
  });

  it('lets the most recent row win — a correction is a mind-change, not a vote', () => {
    const corrected = [
      H,
      row('me@x.com', 'Costco', 'WIPES', 'Grocery', '2026-01-01'),
      row('me@x.com', 'Costco', 'WIPES', 'Grocery', '2026-01-08'),
      row('me@x.com', 'Costco', 'WIPES', 'Misc', '2026-02-01'),
    ];
    const m = reduceMemoryRows(corrected, 'me@x.com');
    // Two Grocery rows do not outvote one later correction.
    expect(lookupLearned(m, 'Costco', 'WIPES')).toBe('Misc');
  });

  it('ignores the header and rows missing a category', () => {
    const m = reduceMemoryRows([H, row('me@x.com', 'Costco', 'THING', '', '2026-01-01')], 'me@x.com');
    expect(m.size).toBe(0);
  });

  it('drops the oldest rows past the read cap', () => {
    const many = [H];
    for (let i = 0; i < MAX_MEMORY_ROWS + 50; i++) {
      many.push(row('me@x.com', 'Costco', `ITEM ${i}`, 'Grocery', '2026-01-01'));
    }
    const m = reduceMemoryRows(many, 'me@x.com');
    expect(m.size).toBeLessThanOrEqual(MAX_MEMORY_ROWS);
    expect(lookupLearned(m, 'Costco', 'ITEM 0')).toBeNull();
    expect(lookupLearned(m, 'Costco', `ITEM ${MAX_MEMORY_ROWS + 49}`)).toBe('Grocery');
  });

  it('survives a missing memory instead of throwing into the scan', () => {
    expect(lookupLearned(null, 'Costco', 'MILK')).toBeNull();
    expect(lookupLearned(new Map(), 'Costco', '')).toBeNull();
  });
});

describe('lookupLearned — article-code key', () => {
  // 7-column rows: the 7th cell is the article code.
  const rowc = (user, vendor, item, category, at, splitId, code) => [user, vendor, item, category, at, splitId, code];

  it('matches by code even when the name is truncated differently next time', () => {
    const m = reduceMemoryRows([H, rowc('me@x.com', 'Costco', 'KS FRENCH ROAST 2DZ', 'Grocery', '2026-01-01', 'sp-1', '1860911')], 'me@x.com');
    // A later receipt abbreviates the name to something the name key can't reach…
    expect(lookupLearned(m, 'Costco', 'KS FR 2DZ')).toBeNull();
    // …but the article code still finds it.
    expect(lookupLearned(m, 'Costco', 'KS FR 2DZ', '1860911')).toBe('Grocery');
    // Code comparison ignores leading zeros / punctuation.
    expect(lookupLearned(m, 'Costco', 'anything', '0001860911')).toBe('Grocery');
  });

  it('still matches a code row by its name (both keys are written)', () => {
    const m = reduceMemoryRows([H, rowc('me@x.com', 'Costco', 'SCOTCHNSODA', 'Misc', '2026-01-01', 'sp-1', '1860911')], 'me@x.com');
    expect(lookupLearned(m, 'Costco', 'SCOTCHNSODA')).toBe('Misc');
  });

  it('REGRESSION: existing name-only rows (no code) still match by name', () => {
    // The pre-upgrade sheet has 6-column rows. They must keep working, with or
    // without a code on the query item.
    const m = reduceMemoryRows([H, row('me@x.com', 'Costco', 'KS ORG PNT BTR', 'Grocery', '2026-01-01')], 'me@x.com');
    expect(lookupLearned(m, 'Costco', 'ORG PNT BTR 16 oz')).toBe('Grocery');
    // A code on the query doesn't exist in the (code-less) memory, so it falls
    // through to the name key rather than returning null.
    expect(lookupLearned(m, 'Costco', 'ORG PNT BTR 16 oz', '9999999')).toBe('Grocery');
  });

  it('keeps the code key scoped per vendor', () => {
    const m = reduceMemoryRows([H, rowc('me@x.com', 'Costco', 'SCOTCHNSODA', 'Misc', '2026-01-01', 'sp-1', '1860911')], 'me@x.com');
    expect(lookupLearned(m, 'Safeway', 'x', '1860911')).toBeNull();
  });
});

describe('learnedExamples', () => {
  const rows = [
    H,
    row('me@x.com', 'Costco', 'BANANAS', 'Grocery', '2026-01-01'),
    row('me@x.com', 'Costco', 'APPLES', 'Grocery', '2026-01-02'),
    row('me@x.com', 'Costco', 'PAPER TOWELS', 'Misc', '2026-01-03'),
    row('me@x.com', 'Costco', 'VITAMIN D', 'Health', '2026-01-04'),
    row('me@x.com', 'Safeway', 'BREAD', 'Grocery', '2026-01-05'),
  ];

  it('only offers examples from the vendor being split', () => {
    const names = learnedExamples(reduceMemoryRows(rows, 'me@x.com'), 'Costco').map(e => e.name);
    expect(names).not.toContain('BREAD');
  });

  it('spreads across categories so the sample is not all Grocery', () => {
    const first3 = learnedExamples(reduceMemoryRows(rows, 'me@x.com'), 'Costco', 3);
    expect(new Set(first3.map(e => e.category)).size).toBe(3);
  });

  it('respects the limit and tolerates an empty memory', () => {
    expect(learnedExamples(reduceMemoryRows(rows, 'me@x.com'), 'Costco', 2)).toHaveLength(2);
    expect(learnedExamples(new Map(), 'Costco')).toEqual([]);
    expect(learnedExamples(null, 'Costco')).toEqual([]);
  });
});

describe('buildMemoryRows', () => {
  const items = [
    { name: 'BANANAS', amount: 3, category: 'Grocery' },
    { name: 'PAPER TOWELS', amount: 20, category: 'Misc' },
  ];

  it('records one row per item in header order (code column empty when absent)', () => {
    const rows = buildMemoryRows({ userId: 'me@x.com', vendor: 'Costco', items, splitId: 'sp-1', at: new Date('2026-03-01T00:00:00Z') });
    expect(rows).toEqual([
      ['me@x.com', 'Costco', 'BANANAS', 'Grocery', '2026-03-01T00:00:00.000Z', 'sp-1', ''],
      ['me@x.com', 'Costco', 'PAPER TOWELS', 'Misc', '2026-03-01T00:00:00.000Z', 'sp-1', ''],
    ]);
  });

  it('writes the article code in the 7th column when the item carries one', () => {
    const rows = buildMemoryRows({
      userId: 'u', vendor: 'Costco', splitId: 'sp-9', at: new Date('2026-03-01T00:00:00Z'),
      items: [{ name: 'SCOTCHNSODA', category: 'Misc', code: '1860911' }],
    });
    expect(rows).toEqual([['u', 'Costco', 'SCOTCHNSODA', 'Misc', '2026-03-01T00:00:00.000Z', 'sp-9', '1860911']]);
  });

  it('skips items with no category — an unanswered item teaches nothing', () => {
    const rows = buildMemoryRows({ userId: 'u', vendor: 'Costco', items: [{ name: 'X', category: '' }] });
    expect(rows).toEqual([]);
  });

  it('records a repeated product once', () => {
    const rows = buildMemoryRows({
      userId: 'u', vendor: 'Costco',
      items: [{ name: 'KS MILK', category: 'Grocery' }, { name: 'MILK 1 gal', category: 'Grocery' }],
    });
    expect(rows).toHaveLength(1);
  });

  it('skips names that normalize away rather than writing a key that matches everything', () => {
    const rows = buildMemoryRows({ userId: 'u', vendor: 'Costco', items: [{ name: '  ', category: 'Grocery' }] });
    expect(rows).toEqual([]);
  });
});

describe('itemsInSplit', () => {
  const rows = [
    H,
    row('me@x.com', 'Costco', 'BANANAS', 'Grocery', '2026-01-01', 'sp-1'),
    row('me@x.com', 'Costco', 'APPLES', 'Grocery', '2026-01-01', 'sp-1'),
    row('me@x.com', 'Costco', 'PAPER TOWELS', 'Misc', '2026-01-01', 'sp-1'),
    row('me@x.com', 'Costco', 'BREAD', 'Grocery', '2026-02-01', 'sp-2'),
    row('other@x.com', 'Costco', 'CHEESE', 'Grocery', '2026-01-01', 'sp-1'),
  ];

  it('returns only the items that went into that category of that split', () => {
    const items = itemsInSplit(rows, { userId: 'me@x.com', splitId: 'sp-1', category: 'Grocery' });
    expect(items.map(i => i.name)).toEqual(['BANANAS', 'APPLES']);
  });

  it('excludes other users and other splits', () => {
    const items = itemsInSplit(rows, { userId: 'me@x.com', splitId: 'sp-1', category: 'Grocery' });
    expect(items.map(i => i.name)).not.toContain('CHEESE');
    expect(items.map(i => i.name)).not.toContain('BREAD');
  });

  it('returns nothing without a splitId, so a hand-typed transaction teaches nothing', () => {
    expect(itemsInSplit(rows, { userId: 'me@x.com', splitId: '', category: 'Grocery' })).toEqual([]);
  });
});
