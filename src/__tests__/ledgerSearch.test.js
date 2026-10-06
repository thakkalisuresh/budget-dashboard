import { describe, it, expect } from 'vitest';
import { rowMatchesQuery } from '../ledgerSearch.js';
import { txNoteKey } from '../transactionNotes.js';

describe('rowMatchesQuery — existing fields still match', () => {
  const t = { vendor: 'Costco Wholesale', category: 'Grocery', amount: 40.00 };
  it('matches vendor / category substrings', () => {
    expect(rowMatchesQuery(t, 'costco')).toBe(true);
    expect(rowMatchesQuery(t, 'groc')).toBe(true);
  });
  it('matches the row amount, whole or decimal (partial)', () => {
    expect(rowMatchesQuery(t, '40')).toBe(true);
    expect(rowMatchesQuery(t, '40.00')).toBe(true);
  });
  it('empty query matches everything', () => {
    expect(rowMatchesQuery(t, '   ')).toBe(true);
  });
  it('no match returns false', () => {
    expect(rowMatchesQuery(t, 'zzz')).toBe(false);
  });
});

describe('rowMatchesQuery — receiptTotal (search by split total)', () => {
  const row = { vendor: 'Costco', category: 'Grocery', amount: 40.00 };
  it('matches the stamped receipt total even though no row equals it', () => {
    expect(rowMatchesQuery(row, '102.54', 102.54)).toBe(true);
    expect(rowMatchesQuery(row, '102', 102.54)).toBe(true); // partial
  });
  it('does not invent a total match when the row carries no receiptTotal', () => {
    expect(rowMatchesQuery(row, '102.54', null)).toBe(false);
  });
});

/**
 * Integration mirroring LedgerTab's filter: resolve each row's receiptTotal from
 * its note by txNoteKey, then match. Proves searching the total surfaces every
 * row of one split and nothing from an unrelated same-amount row, and that two
 * same-day splits stay separable by their total.
 */
describe('ledger filter by split total (integration)', () => {
  const sheet = 'sheetA';
  // Split S1: Costco $102.54 across 3 categories.
  const s1 = [
    { vendor: 'Costco', category: 'Grocery',   amount: 40.00 },
    { vendor: 'Costco', category: 'Misc',      amount: 50.00 },
    { vendor: 'Costco', category: 'Health',    amount: 12.54 },
  ];
  // Split S2: a different same-day Costco trip, $88.00 across 2 categories.
  // (Note keys are sheet+category+vendor+amount, so a row that collided exactly
  // with an S1 row would share one note — a known UUID-less-key limitation, out
  // of scope here; these rows don't collide.)
  const s2 = [
    { vendor: 'Costco', category: 'Furniture',  amount: 48.00 },
    { vendor: 'Costco', category: 'Eating Out', amount: 40.00 },
  ];
  // Unrelated non-split transaction that happens to be $40.00.
  const u = { vendor: 'Target', category: 'Grocery', amount: 40.00 };
  const rows = [...s1, ...s2, u];

  const notes = {};
  for (const r of s1) notes[txNoteKey(sheet, r.category, r.vendor, r.amount)] = { splitId: 'sp-1', receiptTotal: 102.54, splitCount: 3 };
  for (const r of s2) notes[txNoteKey(sheet, r.category, r.vendor, r.amount)] = { splitId: 'sp-2', receiptTotal: 88.00, splitCount: 2 };
  // u gets no note.

  const filter = (q) => rows.filter(r => {
    const note = notes[txNoteKey(sheet, r.category, r.vendor, r.amount)];
    const rt = note && typeof note.receiptTotal === 'number' ? note.receiptTotal : null;
    return rowMatchesQuery(r, q, rt);
  });

  it('searching the S1 total surfaces all 3 S1 rows and not the unrelated $40 row', () => {
    const hit = filter('102.54');
    expect(hit).toHaveLength(3);
    expect(hit.every(r => r.vendor === 'Costco')).toBe(true);
    expect(hit).not.toContain(u);
  });

  it('two same-day splits stay separable by their own total', () => {
    expect(filter('102.54')).toHaveLength(3);
    expect(filter('88').map(r => r.category).sort()).toEqual(['Eating Out', 'Furniture']);
  });

  it('their notes carry distinct splitIds so a later move re-teaches the right split', () => {
    const k1 = txNoteKey(sheet, 'Grocery', 'Costco', 40.00);
    const k2 = txNoteKey(sheet, 'Furniture', 'Costco', 48.00);
    expect(notes[k1].splitId).toBe('sp-1');
    expect(notes[k2].splitId).toBe('sp-2');
  });
});
