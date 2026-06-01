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
    expect(calculateRewards('Cash', '5812', 100).type).toBe('none');
  });

  it('CSR earns 3x UR points on dining (MCC 5812)', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '5812', 100);
    expect(r).toMatchObject({ type: 'points', unit: 'UR', rate: 3 });
    expect(r.value).toBe(300);
  });

  it('CSR earns 1x default on grocery (MCC 5411)', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '5411', 100);
    expect(r).toMatchObject({ type: 'points', rate: 1 });
    expect(r.value).toBe(100);
  });

  it('CSR earns 8x UR on airlines via portal (MCC 4511)', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '4511', 100, 0, 'portal');
    expect(r).toMatchObject({ type: 'points', unit: 'UR', rate: 8 });
    expect(r.value).toBe(800);
  });

  it('CSR earns 4x UR on airlines booked direct (MCC 4511)', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '4511', 100, 0, 'direct');
    expect(r).toMatchObject({ type: 'points', unit: 'UR', rate: 4 });
    expect(r.value).toBe(400);
  });

  it('CSR earns 8x UR on hotels via portal (MCC 7011)', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '7011', 100, 0, 'portal');
    expect(r).toMatchObject({ type: 'points', rate: 8 });
    expect(r.value).toBe(800);
  });

  it('CSR Chase Travel portal catch-all → 8x', () => {
    const r = calculateRewards('Chase Sapphire Reserve', 'CHASE_PORTAL', 100);
    expect(r.rate).toBe(8);
    expect(r.value).toBe(800);
  });

  it('Amex earns 6% cash back on US supermarkets (MCC 5411) under the cap', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '5411', 100, 0);
    expect(r).toMatchObject({ type: 'cashback', unit: '$', rate: 6 });
    expect(r.value).toBeCloseTo(6, 5);
  });

  it('Amex grocery cap: drops to 1% past $6000 YTD', () => {
    // $5950 already spent; a $100 charge → $50 at 6% + $50 at 1%
    const r = calculateRewards('American Express Blue Cash Preferred', '5411', 100, 5950);
    expect(r.value).toBeCloseTo(50 * 0.06 + 50 * 0.01, 5); // 3.00 + 0.50 = 3.50
  });

  it('Amex grocery fully over cap → all at 1%', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '5411', 100, 7000);
    expect(r.value).toBeCloseTo(1, 5);
  });

  it('Amex earns 1% at wholesale clubs (MCC 5300 — Costco, BJs)', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '5300', 100, 0);
    expect(r).toMatchObject({ type: 'cashback', rate: 1 });
    expect(r.value).toBeCloseTo(1, 5);
  });

  it('Amex earns 1% at superstores (MCC 5310 — Walmart, Target)', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '5310', 100, 0);
    expect(r).toMatchObject({ type: 'cashback', rate: 1 });
    expect(r.value).toBeCloseTo(1, 5);
  });

  it('Amex earns 6% on streaming (MCC 7372 — Netflix, Spotify)', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '7372', 100);
    expect(r).toMatchObject({ type: 'cashback', rate: 6 });
    expect(r.value).toBeCloseTo(6, 5);
  });

  it('Amex earns 3% on gas stations (MCC 5541)', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '5541', 100);
    expect(r).toMatchObject({ type: 'cashback', rate: 3 });
    expect(r.value).toBeCloseTo(3, 5);
  });

  it('Amex earns 3% on rideshare/transit (MCC 4121)', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '4121', 100);
    expect(r).toMatchObject({ type: 'cashback', rate: 3 });
    expect(r.value).toBeCloseTo(3, 5);
  });

  it('Amex earns 1% on entertainment (MCC 7996 — unknown category default)', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '7996', 100);
    expect(r).toMatchObject({ type: 'cashback', rate: 1 });
    expect(r.value).toBeCloseTo(1, 5);
  });

  it('Thakkali (MCC 5999) earns base rate, not a bonus', () => {
    expect(calculateRewards('Chase Sapphire Reserve', '5999', 100).value).toBe(100); // 1x
    expect(calculateRewards('Chase Freedom Unlimited', '5999', 100).value).toBe(150); // 1.5x
  });

  it('Quicksilver flat 1.5% everywhere', () => {
    expect(calculateRewards('Capital One Quicksilver', '6513', 200).value).toBeCloseTo(3, 5); // Rent
    expect(calculateRewards('Capital One Quicksilver', '5812', 200).value).toBeCloseTo(3, 5); // Dining
    expect(calculateRewards('Capital One Quicksilver', '5300', 200).value).toBeCloseTo(3, 5); // Costco
  });

  it('CFU earns 1.5x default, 3x on dining and pharmacy', () => {
    expect(calculateRewards('Chase Freedom Unlimited', '5999', 100).value).toBe(150);
    expect(calculateRewards('Chase Freedom Unlimited', '5812', 100).value).toBe(300);
    expect(calculateRewards('Chase Freedom Unlimited', '5912', 100).value).toBe(300);
  });
});

describe('rewardsDollarValue', () => {
  it('cashback value passes through', () => {
    const r = calculateRewards('Capital One Quicksilver', '5999', 100);
    expect(rewardsDollarValue('Capital One Quicksilver', r)).toBeCloseTo(1.5, 5);
  });

  it('CSR points valued at 1.5¢', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '5812', 100); // 300 pts
    expect(rewardsDollarValue('Chase Sapphire Reserve', r)).toBeCloseTo(300 * 0.015, 5); // 4.50
  });

  it('CFU points valued at 1¢', () => {
    const r = calculateRewards('Chase Freedom Unlimited', '5999', 100); // 150 pts
    expect(rewardsDollarValue('Chase Freedom Unlimited', r)).toBeCloseTo(1.5, 5);
  });

  it('CSR travel portal 8x → $12 per $100', () => {
    const r = calculateRewards('Chase Sapphire Reserve', '4511', 100, 0, 'portal'); // 800 pts
    expect(rewardsDollarValue('Chase Sapphire Reserve', r)).toBeCloseTo(800 * 0.015, 5); // 12.00
  });
});

describe('getBestCard', () => {
  it('Amex wins Grocery (6% >> all)', () => {
    const b = getBestCard('Grocery');
    expect(b.card).toBe('American Express Blue Cash Preferred');
    expect(b.rate).toBe(6);
  });

  it('CSR wins Eating Out (3x @ 1.5¢ = 4.5% beats Quicksilver 1.5%)', () => {
    expect(getBestCard('Eating Out').card).toBe('Chase Sapphire Reserve');
  });

  it('CSR wins Travel — 8x portal (not 3x as before)', () => {
    const b = getBestCard('Travel');
    expect(b.card).toBe('Chase Sapphire Reserve');
    expect(b.rate).toBe(8);
  });

  it('CSR wins Holiday — 8x portal via hotel MCC', () => {
    const b = getBestCard('Holiday');
    expect(b.card).toBe('Chase Sapphire Reserve');
    expect(b.rate).toBe(8);
  });

  it('CFU wins Health (3x @ 1¢ = 3% beats Quicksilver 1.5%)', () => {
    expect(getBestCard('Health').card).toBe('Chase Freedom Unlimited');
  });

  it('Quicksilver wins flat categories on a tie (cash preferred over UR points)', () => {
    expect(getBestCard('Rent').card).toBe('Capital One Quicksilver');
    expect(getBestCard('Misc').card).toBe('Capital One Quicksilver');
  });

  it('Amex wins Entertainment streaming vendors (Netflix → 7372 → 6%)', () => {
    expect(getBestCard('Entertainment', 'Netflix').card).toBe('American Express Blue Cash Preferred');
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

  it('Travel shows 8x UR (corrected from 3x)', () => {
    const [row] = bestCardTable(['Travel']);
    expect(row).toMatchObject({ card: 'Chase Sapphire Reserve', label: '8x UR' });
  });
});
