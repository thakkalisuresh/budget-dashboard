import { describe, it, expect } from 'vitest';
import {
  buildCategoryItems,
  buildSplitNote,
  shouldWarnSettingsSize,
  MAX_LISTED_ITEMS,
  MAX_NOTE_CHARS,
  SPLIT_TAG,
} from '../splitNotes.js';
import { txNoteKey } from '../transactionNotes.js';
import { categorizeItems } from '../itemCategorizer.js';

describe('buildCategoryItems', () => {
  it('keeps the per-category items categorizeItems already produced', () => {
    // The scanner used to drop these on the floor and keep only the subtotal.
    const autoGrouped = [
      { category: 'Grocery', subtotal: 11.48, items: [{ name: 'Milk', amount: 4.49 }, { name: 'Eggs', amount: 6.99 }] },
      { category: 'Health',  subtotal: 8.99,  items: [{ name: 'Vitamins', amount: 8.99 }] },
    ];
    expect(buildCategoryItems(autoGrouped, [])).toEqual({
      Grocery: [{ name: 'Milk', amount: 4.49 }, { name: 'Eggs', amount: 6.99 }],
      Health:  [{ name: 'Vitamins', amount: 8.99 }],
    });
  });

  it('folds in items the user assigned by hand', () => {
    const auto = [{ category: 'Grocery', subtotal: 4.49, items: [{ name: 'Milk', amount: 4.49 }] }];
    const assigned = [{ name: 'Batteries', amount: 12.99, category: 'Misc' }];
    const out = buildCategoryItems(auto, assigned);
    expect(out.Misc).toEqual([{ name: 'Batteries', amount: 12.99 }]);
    expect(out.Grocery).toHaveLength(1);
  });

  it('appends an assigned item to a category that already has auto items', () => {
    const auto = [{ category: 'Grocery', subtotal: 4.49, items: [{ name: 'Milk', amount: 4.49 }] }];
    const assigned = [{ name: 'Bread', amount: 3.50, category: 'Grocery' }];
    expect(buildCategoryItems(auto, assigned).Grocery).toEqual([
      { name: 'Milk', amount: 4.49 },
      { name: 'Bread', amount: 3.50 },
    ]);
  });

  it('ignores still-unassigned items', () => {
    const assigned = [{ name: 'Mystery', amount: 5, category: '' }];
    expect(buildCategoryItems([], assigned)).toEqual({});
  });

  it('does not mutate the source groups', () => {
    // The same autoGrouped array stays in React state and is reused if the user
    // reassigns an item, so pushing into g.items would compound on every edit.
    const auto = [{ category: 'Grocery', subtotal: 4.49, items: [{ name: 'Milk', amount: 4.49 }] }];
    buildCategoryItems(auto, [{ name: 'Bread', amount: 3.5, category: 'Grocery' }]);
    expect(auto[0].items).toEqual([{ name: 'Milk', amount: 4.49 }]);
  });

  it('handles empty input', () => {
    expect(buildCategoryItems()).toEqual({});
    expect(buildCategoryItems([], [])).toEqual({});
  });
});

describe('buildSplitNote', () => {
  it('lists the items with their amounts and tags the transaction', () => {
    const note = buildSplitNote([
      { name: 'Milk', amount: 4.49 },
      { name: 'Eggs', amount: 6.99 },
    ]);
    expect(note.note).toBe('2 items: Milk $4.49, Eggs $6.99');
    expect(note.tags).toEqual([SPLIT_TAG]);
  });

  it('labels the tax/fees remainder instead of hiding it in an item price', () => {
    // The remainder is folded into the largest category so the split sums to the
    // receipt total. Rolling it into an item would claim a price the receipt
    // never showed.
    const note = buildSplitNote([{ name: 'Milk', amount: 4.49 }], { remainder: 1.23 });
    expect(note.note).toContain('Milk $4.49');
    expect(note.note).toContain('Tax/fees +$1.23');
    expect(note.note).not.toContain('5.72');
  });

  it('renders a negative remainder (a discount) with a minus', () => {
    const note = buildSplitNote([{ name: 'Milk', amount: 4.49 }], { remainder: -0.75 });
    expect(note.note).toContain('Tax/fees -$0.75');
  });

  it('ignores a sub-cent remainder', () => {
    const note = buildSplitNote([{ name: 'Milk', amount: 4.49 }], { remainder: 0.004 });
    expect(note.note).not.toContain('Tax/fees');
  });

  it('caps the listed items and says how many are hidden', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ name: `Item ${i}`, amount: 1 }));
    const note = buildSplitNote(many);
    expect(note.note).toContain('25 items');
    expect(note.note).toContain(`+${25 - MAX_LISTED_ITEMS} more`);
    expect(note.note).toContain('Item 0');
    expect(note.note).not.toContain('Item 20');
  });

  it('never exceeds the character cap', () => {
    // Notes share one spreadsheet cell with every other setting; blowing the
    // 50k cell limit fails the whole settings save, not just the note.
    const huge = Array.from({ length: 10 }, () => ({ name: 'X'.repeat(200), amount: 1 }));
    const note = buildSplitNote(huge);
    expect(note.note.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
  });

  it('uses the singular for one item', () => {
    expect(buildSplitNote([{ name: 'Milk', amount: 4.49 }]).note).toBe('1 item: Milk $4.49');
  });

  it('honours a non-dollar currency symbol', () => {
    const note = buildSplitNote([{ name: 'Milk', amount: 4.49 }], { currencySymbol: '£' });
    expect(note.note).toBe('1 item: Milk £4.49');
  });

  it('returns null when there is nothing to record', () => {
    expect(buildSplitNote([])).toBeNull();
    expect(buildSplitNote([], { remainder: 0 })).toBeNull();
  });

  it('still records a remainder-only note', () => {
    expect(buildSplitNote([], { remainder: 2.5 }).note).toBe('Tax/fees +$2.50');
  });

  it('survives items with a missing name or amount', () => {
    const note = buildSplitNote([{ name: '', amount: 3 }, { name: 'Thing' }]);
    expect(note.note).toContain('Item $3.00');
    expect(note.note).toContain('Thing');
  });
});

describe('txNoteKey', () => {
  it('matches the format the ledger and panel read back', () => {
    expect(txNoteKey('sheet1', 'Grocery', 'Costco', 84.1)).toBe('sheet1_Grocery_costco_84.10');
  });

  it('lowercases the vendor and pads the amount to 2dp', () => {
    expect(txNoteKey('s', 'C', 'COSTCO', 5)).toBe('s_C_costco_5.00');
  });

  it('accepts a string amount', () => {
    expect(txNoteKey('s', 'C', 'v', '12.5')).toBe('s_C_v_12.50');
  });

  it('trims the vendor', () => {
    // addOrUpdateExpense writes vendor.trim() to the sheet, so a padded vendor
    // here would key the note differently from what the ledger reads back —
    // and a note under an unread key is invisible, not broken. AddExpenseDialog
    // already trimmed; nothing else did, so the two disagreed.
    expect(txNoteKey('s', 'C', '  Costco  ', 5)).toBe('s_C_costco_5.00');
    expect(txNoteKey('s', 'C', 'Costco', 5)).toBe(txNoteKey('s', 'C', ' Costco ', 5));
  });
});

describe('end-to-end shape from a real categorizeItems call', () => {
  it('turns a mixed receipt into per-category notes', () => {
    // Guards the seam: categorizeItems' output shape is what buildCategoryItems
    // consumes, so a change to either would break the split notes silently.
    const { autoGrouped, uncategorized } = categorizeItems([
      { name: 'Bananas', amount: 2.99 },
      { name: 'Whole Milk', amount: 4.49 },
      { name: 'Zzzz Unknownthing', amount: 9.99 },
    ]);
    const items = buildCategoryItems(
      autoGrouped,
      uncategorized.map(u => ({ ...u, category: 'Misc' })),
    );
    expect(Object.keys(items).length).toBeGreaterThan(0);
    for (const [, list] of Object.entries(items)) {
      const note = buildSplitNote(list);
      if (note) expect(note.tags).toContain(SPLIT_TAG);
    }
  });
});

describe('shouldWarnSettingsSize', () => {
  it('warns before the cell ceiling, not after', () => {
    expect(shouldWarnSettingsSize(39_000)).toBe(false);
    expect(shouldWarnSettingsSize(41_000)).toBe(true);
  });
});
