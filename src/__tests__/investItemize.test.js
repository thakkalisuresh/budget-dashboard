import { describe, it, expect } from 'vitest';
import {
  pendingItemizations, itemizeRemainder, rowsCost, lineCost,
  itemizeNote, itemizeTargetUuid, ITEMIZE_NOTE_PREFIX,
} from '../investItemize.js';

const ACCOUNTS = [
  { id: 'fidelity', name: 'Fidelity', type: 'brokerage' },
  { id: 'amex-hysa', name: 'Amex Savings', type: 'hysa' },
];

const deposit = (uuid, accountId, over = {}) => ({
  type: 'DEPOSIT', accountId, amount: 2000, date: '2026-10-07', note: 'Auto from Investment expense', uuid, ...over,
});
const buy = (note, over = {}) => ({
  type: 'BUY', accountId: 'fidelity', symbol: 'VOO', qty: 2, price: 500, amount: 1000, note, uuid: 'act_buy1', ...over,
});

describe('pendingItemizations', () => {
  it('flags a brokerage deposit with no referencing BUY', () => {
    const out = pendingItemizations([deposit('act_dep1', 'fidelity')], ACCOUNTS, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ uuid: 'act_dep1', accountId: 'fidelity', accountName: 'Fidelity', amount: 2000, date: '2026-10-07' });
  });

  it('does NOT flag a deposit once a BUY references it via "itemize:" note', () => {
    const activities = [
      deposit('act_dep1', 'fidelity'),
      buy(itemizeNote('act_dep1')),
    ];
    expect(pendingItemizations(activities, ACCOUNTS, [])).toHaveLength(0);
  });

  it('does NOT flag a dismissed deposit', () => {
    const out = pendingItemizations([deposit('act_dep1', 'fidelity')], ACCOUNTS, ['act_dep1']);
    expect(out).toHaveLength(0);
  });

  it('never flags a HYSA deposit', () => {
    const out = pendingItemizations([deposit('act_dep2', 'amex-hysa')], ACCOUNTS, []);
    expect(out).toHaveLength(0);
  });

  it('flags only the unitemized, undismissed brokerage deposits among a mix', () => {
    const activities = [
      deposit('act_dep1', 'fidelity'),                 // pending
      deposit('act_dep2', 'fidelity'),                 // itemized below
      deposit('act_dep3', 'fidelity'),                 // dismissed
      deposit('act_dep4', 'amex-hysa'),                // HYSA → never
      buy(itemizeNote('act_dep2')),
    ];
    const out = pendingItemizations(activities, ACCOUNTS, ['act_dep3']);
    expect(out.map(p => p.uuid)).toEqual(['act_dep1']);
  });

  it('returns [] when there is no brokerage account to join against', () => {
    const hysaOnly = [{ id: 'amex-hysa', name: 'Amex', type: 'hysa' }];
    expect(pendingItemizations([deposit('act_dep1', 'fidelity')], hysaOnly, [])).toHaveLength(0);
  });

  it('ignores deposits with no uuid', () => {
    expect(pendingItemizations([deposit('', 'fidelity')], ACCOUNTS, [])).toHaveLength(0);
  });

  it('tolerates empty inputs', () => {
    expect(pendingItemizations()).toEqual([]);
    expect(pendingItemizations([], [], [])).toEqual([]);
  });
});

describe('itemizeNote / itemizeTargetUuid', () => {
  it('round-trips a deposit uuid', () => {
    expect(itemizeNote('act_dep1')).toBe(`${ITEMIZE_NOTE_PREFIX}act_dep1`);
    expect(itemizeTargetUuid(itemizeNote('act_dep1'))).toBe('act_dep1');
  });
  it('returns "" for a non-link note', () => {
    expect(itemizeTargetUuid('manual')).toBe('');
    expect(itemizeTargetUuid('')).toBe('');
    expect(itemizeTargetUuid(null)).toBe('');
  });
});

describe('lineCost / rowsCost', () => {
  it('multiplies shares × price', () => {
    expect(lineCost({ qty: 2, price: 500 })).toBe(1000);
  });
  it('treats missing/invalid shares or price as 0', () => {
    expect(lineCost({ qty: '', price: 500 })).toBe(0);
    expect(lineCost({ qty: 2, price: 0 })).toBe(0);
    expect(lineCost({})).toBe(0);
  });
  it('sums rows and rounds to cents', () => {
    expect(rowsCost([{ qty: 1, price: 10.005 }, { qty: 2, price: 5 }])).toBe(20.01);
  });
});

describe('itemizeRemainder', () => {
  it('is exactly 0 when rows match the deposit', () => {
    expect(itemizeRemainder(2000, [{ qty: 2, price: 500 }, { qty: 2, price: 500 }])).toBe(0);
  });
  it('is positive when under (leftover cash)', () => {
    expect(itemizeRemainder(2000, [{ qty: 3, price: 500 }])).toBe(500);
  });
  it('is negative when over the deposit', () => {
    expect(itemizeRemainder(2000, [{ qty: 3, price: 500 }, { qty: 2, price: 350 }])).toBe(-200);
  });
  it('equals the deposit with no rows', () => {
    expect(itemizeRemainder(2000, [])).toBe(2000);
    expect(itemizeRemainder(2000)).toBe(2000);
  });
});
