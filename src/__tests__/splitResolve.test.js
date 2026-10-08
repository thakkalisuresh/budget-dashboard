import { describe, it, expect } from 'vitest';
import {
  resolveKnownItems, pendingItems, applyLlmSuggestions, groupItems, foldRemainder,
  SPLIT_CONFIDENCE_THRESHOLD,
} from '../splitResolve.js';
import { reduceMemoryRows, MEMORY_HEADER } from '../itemMemory.js';

const memoryOf = (...rows) => reduceMemoryRows([MEMORY_HEADER, ...rows], 'me@x.com');
const learned = (item, category) => ['me@x.com', 'Costco', item, category, '2026-01-01', 'sp-1'];

describe('resolveKnownItems', () => {
  it('prefers a remembered answer over the keyword table', () => {
    // "chicken" is a keyword-table Grocery hit, but this user files their
    // Costco rotisserie chicken under Eating Out. Memory is evidence about
    // THIS shopper and must win.
    const memory = memoryOf(learned('ROTISSERIE CHICKEN', 'Eating Out'));
    const [item] = resolveKnownItems([{ name: 'ROTISSERIE CHICKEN', amount: 4.99 }], { memory, vendor: 'Costco' });
    expect(item.category).toBe('Eating Out');
    expect(item.source).toBe('learned');
  });

  it('falls back to keywords when nothing is remembered', () => {
    const [item] = resolveKnownItems([{ name: 'BANANAS', amount: 2 }], { memory: memoryOf(), vendor: 'Costco' });
    expect(item).toMatchObject({ category: 'Grocery', source: 'keyword' });
  });

  it('leaves genuinely unknown items blank, with the extractor hint as a suggestion only', () => {
    const [item] = resolveKnownItems(
      [{ name: 'ZX9 WIDGET', amount: 12, item_category: 'Furniture' }],
      { memory: memoryOf(), vendor: 'Costco' }
    );
    expect(item.category).toBe('');
    expect(item.suggestion).toBe('Furniture');
    expect(item.source).toBeNull();
  });

  it('drops lines with no usable amount', () => {
    const out = resolveKnownItems([{ name: 'SUBTOTAL' }, { name: 'MILK', amount: 3 }], { memory: memoryOf(), vendor: 'Costco' });
    expect(out).toHaveLength(1);
  });

  it('works with no memory at all (first ever scan)', () => {
    const out = resolveKnownItems([{ name: 'BANANAS', amount: 2 }], { memory: null, vendor: 'Costco' });
    expect(out[0].category).toBe('Grocery');
  });
});

describe('pendingItems + applyLlmSuggestions', () => {
  const items = [
    { name: 'BANANAS', amount: 2 },        // keyword → Grocery
    { name: 'ZX9 WIDGET', amount: 12 },    // unknown
    { name: 'QQ THING', amount: 5 },       // unknown
  ];
  const resolved = resolveKnownItems(items, { memory: null, vendor: 'Costco' });

  it('only sends the undecided items to the LLM', () => {
    expect(pendingItems(resolved).map(p => p.item.name)).toEqual(['ZX9 WIDGET', 'QQ THING']);
  });

  it('fills in confident answers and marks their source', () => {
    const pending = pendingItems(resolved);
    const next = applyLlmSuggestions(resolved, pending, [
      { category: 'Furniture', confidence: 0.9 },
      { category: 'Misc', confidence: 0.8 },
    ]);
    expect(next[1]).toMatchObject({ category: 'Furniture', source: 'llm' });
    expect(next[2]).toMatchObject({ category: 'Misc', source: 'llm' });
    expect(next[0].source).toBe('keyword'); // untouched
  });

  it('offers but does not apply an answer below the threshold', () => {
    const pending = pendingItems(resolved);
    const next = applyLlmSuggestions(resolved, pending, [
      { category: 'Furniture', confidence: SPLIT_CONFIDENCE_THRESHOLD - 0.01 },
      null,
    ]);
    // Left blank on purpose: the save stays blocked so the user has to look.
    expect(next[1].category).toBe('');
    expect(next[1].suggestion).toBe('Furniture');
    expect(next[1].source).toBe('llm-low');
  });

  it('leaves everything alone when the LLM is unavailable', () => {
    const pending = pendingItems(resolved);
    expect(applyLlmSuggestions(resolved, pending, [null, null])).toEqual(resolved);
  });

  it('never overwrites a pick the user made while the call was in flight', () => {
    const pending = pendingItems(resolved);
    // User answered item 1 themselves before the answer came back.
    const answered = resolved.map((it, i) => i === 1 ? { ...it, category: 'Health', source: 'user' } : it);
    const next = applyLlmSuggestions(answered, pending, [
      { category: 'Furniture', confidence: 0.99 },
      { category: 'Misc', confidence: 0.9 },
    ]);
    expect(next[1]).toMatchObject({ category: 'Health', source: 'user' });
    expect(next[2]).toMatchObject({ category: 'Misc', source: 'llm' });
  });
});

describe('groupItems + foldRemainder', () => {
  const items = [
    { name: 'A', amount: 10.01, category: 'Grocery' },
    { name: 'B', amount: 5.02, category: 'Grocery' },
    { name: 'C', amount: 3, category: 'Misc' },
  ];

  it('totals per category without float drift', () => {
    expect(groupItems(items)).toEqual({ Grocery: 15.03, Misc: 3 });
  });

  it('ignores unassigned items', () => {
    expect(groupItems([...items, { name: 'D', amount: 99, category: '' }]).Grocery).toBe(15.03);
  });

  it('folds tax into the largest category so the split sums to the receipt', () => {
    const { groups, remainder, remainderCategory } = foldRemainder(groupItems(items), 20.03);
    expect(remainder).toBe(2);
    expect(remainderCategory).toBe('Grocery');
    expect(Object.values(groups).reduce((a, b) => a + b, 0)).toBeCloseTo(20.03, 2);
  });

  it('folds a negative remainder (a discount) the same way', () => {
    const { groups, remainder } = foldRemainder(groupItems(items), 17.03);
    expect(remainder).toBe(-1);
    expect(Object.values(groups).reduce((a, b) => a + b, 0)).toBeCloseTo(17.03, 2);
  });

  it('does nothing when the items already sum to the total', () => {
    const { groups, remainderCategory } = foldRemainder(groupItems(items), 18.03);
    expect(remainderCategory).toBeNull();
    expect(groups).toEqual({ Grocery: 15.03, Misc: 3 });
  });

  it('handles a receipt where nothing is assigned yet', () => {
    expect(foldRemainder({}, 50)).toEqual({ groups: {}, remainder: 0, remainderCategory: null });
  });
});
