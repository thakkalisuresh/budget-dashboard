import { describe, it, expect } from 'vitest';
import {
  calculateRewards, rewardsDollarValue, getBestCard, bestCardTable, cardEarnsRewards,
} from '../cardRewards.js';

describe('cardEarnsRewards', () => {
  it('true for reward cards, false for debit/cash', () => {
    expect(cardEarnsRewards('Chase Sapphire Reserve')).toBe(true);
    expect(cardEarnsRewards('Capital One Quicksilver')).toBe(true);
    expect(cardEarnsRewards('Chase Debit Card - Anu')).toBe(false);
    expect(cardEarnsRewards('Cash')).toBe(false);
    expect(cardEarnsRewards('')).toBe(false);
  });
});

describe('calculateRewards', () => {
  it('returns none for non-reward cards', () => {
    expect(calculateRewards('Cash', 'Grocery', 100).type).toBe('none');
  });

  it('CSR earns 3x UR points on dining (Eating Out)', () => {
    const r = calculateRewards('Chase Sapphire Reserve', 'Eating Out', 100);
    expect(r).toMatchObject({ type: 'points', unit: 'UR', rate: 3 });
    expect(r.value).toBe(300);
  });

  it('CSR earns 1x default on Grocery', () => {
    const r = calculateRewards('Chase Sapphire Reserve', 'Grocery', 100);
    expect(r.value).toBe(100);
  });

  it('Amex earns 6% cash back on Grocery under the cap', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 0);
    expect(r).toMatchObject({ type: 'cashback', unit: '$', rate: 6 });
    expect(r.value).toBeCloseTo(6, 5);
  });

  it('Amex grocery cap: drops to 1% past $6000 YTD', () => {
    // $5950 already spent; a $100 charge → $50 at 6% + $50 at 1%
    const r = calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 5950);
    expect(r.value).toBeCloseTo(50 * 0.06 + 50 * 0.01, 5); // 3.00 + 0.50 = 3.50
  });

  it('Amex grocery fully over cap → all at 1%', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 7000);
    expect(r.value).toBeCloseTo(1, 5);
  });

  it('Amex grocery at Costco/Walmart/Target earns 1% base, not 6%', () => {
    expect(calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 0, 'Costco Wholesale').value).toBeCloseTo(1, 5);
    expect(calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 0, 'Walmart Supercenter').value).toBeCloseTo(1, 5);
    expect(calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 0, 'Target').value).toBeCloseTo(1, 5);
  });

  it('Amex grocery at a real supermarket still earns 6%', () => {
    expect(calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 0, "Trader Joe's").value).toBeCloseTo(6, 5);
    expect(calculateRewards('American Express Blue Cash Preferred', 'Grocery', 100, 0, 'Safeway').value).toBeCloseTo(6, 5);
  });

  it('Thakkali (personal-spend bucket) earns base rate, not a dining bonus', () => {
    expect(calculateRewards('Chase Sapphire Reserve', 'Thakkali', 100).value).toBe(100); // 1x, not 3x
    expect(calculateRewards('Chase Freedom Unlimited', 'Thakkali', 100).value).toBe(150); // 1.5x default, not 3x
  });

  it('Quicksilver flat 1.5% everywhere', () => {
    expect(calculateRewards('Capital One Quicksilver', 'Rent', 200).value).toBeCloseTo(3, 5);
    expect(calculateRewards('Capital One Quicksilver', 'Eating Out', 200).value).toBeCloseTo(3, 5);
  });

  it('CFU earns 1.5x default, 3x on Health', () => {
    expect(calculateRewards('Chase Freedom Unlimited', 'Misc', 100).value).toBe(150);
    expect(calculateRewards('Chase Freedom Unlimited', 'Health', 100).value).toBe(300);
  });
});

describe('rewardsDollarValue', () => {
  it('cashback value passes through', () => {
    const r = calculateRewards('Capital One Quicksilver', 'Misc', 100);
    expect(rewardsDollarValue('Capital One Quicksilver', r)).toBeCloseTo(1.5, 5);
  });

  it('CSR points valued at 1.5¢', () => {
    const r = calculateRewards('Chase Sapphire Reserve', 'Eating Out', 100); // 300 pts
    expect(rewardsDollarValue('Chase Sapphire Reserve', r)).toBeCloseTo(300 * 0.015, 5); // 4.50
  });

  it('CFU points valued at 1¢', () => {
    const r = calculateRewards('Chase Freedom Unlimited', 'Misc', 100); // 150 pts
    expect(rewardsDollarValue('Chase Freedom Unlimited', r)).toBeCloseTo(1.5, 5);
  });
});

describe('getBestCard', () => {
  it('Amex wins Grocery (6% > all)', () => {
    expect(getBestCard('Grocery').card).toBe('American Express Blue Cash Preferred');
  });

  it('CSR wins Eating Out (3x @ 1.5¢ = 4.5% beats Quicksilver 1.5%)', () => {
    expect(getBestCard('Eating Out').card).toBe('Chase Sapphire Reserve');
  });

  it('CSR wins Travel', () => {
    expect(getBestCard('Travel').card).toBe('Chase Sapphire Reserve');
  });

  it('CFU wins Health (3x @ 1¢ = 3% beats Quicksilver 1.5%)', () => {
    expect(getBestCard('Health').card).toBe('Chase Freedom Unlimited');
  });

  it('Quicksilver wins flat categories on a tie (cash preferred over UR points)', () => {
    // Rent/Misc: Quicksilver 1.5% cash ties CSR 1x UR @1.5¢ and CFU 1.5x @1¢ — cash wins
    expect(getBestCard('Rent').card).toBe('Capital One Quicksilver');
    expect(getBestCard('Misc').card).toBe('Capital One Quicksilver');
  });

  it('best Grocery card is merchant-aware: Amex normally, Quicksilver at Costco', () => {
    expect(getBestCard('Grocery').card).toBe('American Express Blue Cash Preferred');
    expect(getBestCard('Grocery', 'Costco Wholesale').card).toBe('Capital One Quicksilver');
  });
});

describe('bestCardTable', () => {
  it('produces a labelled row per category', () => {
    const table = bestCardTable(['Grocery', 'Eating Out']);
    expect(table).toHaveLength(2);
    expect(table[0]).toMatchObject({ category: 'Grocery', card: 'American Express Blue Cash Preferred', label: '6% cash back' });
    expect(table[1]).toMatchObject({ category: 'Eating Out', card: 'Chase Sapphire Reserve', label: '3x UR' });
  });
});
