import { describe, it, expect } from 'vitest';
import * as client from '../itemCategorizer.js';
import * as server from '../../functions/lib/_item-categorizer.mjs';

/**
 * Drift-guard + behavior tests for the receipt line-item categorizer.
 * src/itemCategorizer.js and functions/lib/_item-categorizer.mjs are mirrored
 * (the Cloud Functions bot can't import client modules), so this fails the
 * moment the keyword tables or logic diverge.
 */

describe('itemCategorizer client/server parity', () => {
  const SAMPLE = [
    { name: 'Organic Bananas', amount: 2.99 },
    { name: 'Paper Towels', amount: 18.49 },
    { name: 'Vitamin D3', amount: 12.0 },
    { name: 'Wireless Mouse', amount: 25.0 },
    { name: 'T-Shirt', amount: 14.99, item_category: 'Misc' },
  ];

  it('categorizeItems gives identical results in both copies', () => {
    expect(server.categorizeItems(SAMPLE)).toEqual(client.categorizeItems(SAMPLE));
  });

  it('default split vendors match', () => {
    expect(server.DEFAULT_SPLIT_VENDORS).toEqual(client.DEFAULT_SPLIT_VENDORS);
  });
});

describe('categorizeItems', () => {
  it('auto-sorts confident items and leaves ambiguous ones for the user', () => {
    const { autoGrouped, uncategorized } = client.categorizeItems([
      { name: 'Roma Tomatoes', amount: 3.5 },
      { name: 'Chicken Breast', amount: 9.99 },
      { name: 'Dish Soap', amount: 4.25 },
      { name: 'Melatonin Gummies', amount: 11.0 },
      { name: 'Denim Jacket', amount: 49.99, item_category: 'Misc' }, // ambiguous → ask
      { name: 'USB-C Cable', amount: 15.0 },                          // ambiguous → ask
    ]);

    const byCat = Object.fromEntries(autoGrouped.map(g => [g.category, g.subtotal]));
    expect(byCat.Grocery).toBeCloseTo(13.49, 2); // tomatoes + chicken
    expect(byCat.Misc).toBeCloseTo(4.25, 2);     // dish soap
    expect(byCat.Health).toBeCloseTo(11.0, 2);   // melatonin

    expect(uncategorized.map(u => u.name)).toEqual(['Denim Jacket', 'USB-C Cable']);
    // AI hint surfaces as a non-binding suggestion
    expect(uncategorized[0].suggestion).toBe('Misc');
    expect(uncategorized[1].suggestion).toBe(null);
  });

  it('skips items with no numeric amount', () => {
    const { autoGrouped } = client.categorizeItems([
      { name: 'Bananas', amount: 'free' },
      { name: 'Milk', amount: 3 },
    ]);
    expect(autoGrouped).toHaveLength(1);
    expect(autoGrouped[0].subtotal).toBe(3);
  });
});

describe('matchesSplitVendor', () => {
  const vendors = [{ name: 'Costco', patterns: ['costco'] }, { name: 'Amazon', patterns: ['amazon', 'amzn'] }];
  it('matches POS name variants via substring', () => {
    expect(client.matchesSplitVendor('COSTCO WHSE #4521', vendors)).toBe(true);
    expect(client.matchesSplitVendor('Costco Wholesale', vendors)).toBe(true);
    expect(client.matchesSplitVendor('AMZN Mktp US*2X4', vendors)).toBe(true);
  });
  it('does not match unrelated vendors', () => {
    expect(client.matchesSplitVendor('Trader Joe\'s', vendors)).toBe(false);
    expect(client.matchesSplitVendor('', vendors)).toBe(false);
  });
});
