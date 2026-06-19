import { describe, it, expect } from 'vitest';
import {
  buildRewardsLine, getBestCard, calculateRewards, cardEarnsRewards,
} from '../../functions/lib/_card-rewards.mjs';

// Sanity: server mirror matches the client logic we already tested in cardRewards.test.js
describe('_card-rewards.mjs parity', () => {
  it('Amex wins Grocery, CSR wins Eating Out, CFU wins Health', () => {
    expect(getBestCard('Grocery').card).toBe('American Express Blue Cash Preferred');
    expect(getBestCard('Eating Out').card).toBe('Chase Sapphire Reserve');
    expect(getBestCard('Health').card).toBe('Chase Freedom Unlimited');
  });

  it('CSR wins Travel with 8x portal rate', () => {
    const b = getBestCard('Travel');
    expect(b.card).toBe('Chase Sapphire Reserve');
    expect(b.rate).toBe(8);
  });

  it('Amex grocery cap rolls 6%→1% past $6000 YTD', () => {
    const r = calculateRewards('American Express Blue Cash Preferred', '5411', 100, 5950);
    expect(r.value).toBeCloseTo(3.5, 5);
  });

  it('debit/cash earn nothing', () => {
    expect(cardEarnsRewards('Chase Debit Card - Anu')).toBe(false);
    expect(cardEarnsRewards('Cash')).toBe(false);
  });
});

describe('buildRewardsLine', () => {
  it('returns empty for non-reward cards', () => {
    expect(buildRewardsLine('Cash', 'Grocery', 100)).toBe('');
    expect(buildRewardsLine('Chase Debit Card - Anu', 'Grocery', 100)).toBe('');
    expect(buildRewardsLine('', 'Grocery', 100)).toBe('');
  });

  it('returns empty for zero/invalid amount', () => {
    expect(buildRewardsLine('American Express Blue Cash Preferred', 'Grocery', 0)).toBe('');
  });

  it('marks the best card with a checkmark and full rate label', () => {
    const line = buildRewardsLine('American Express Blue Cash Preferred', 'Grocery', 100);
    expect(line).toBe('📊 6% cash back — best card for Grocery ✓');
  });

  it('marks CSR as best for dining with points label', () => {
    const line = buildRewardsLine('Chase Sapphire Reserve', 'Eating Out', 50);
    expect(line).toBe('📊 3x UR points — best card for Eating Out ✓');
  });

  it('marks CSR as best for travel with 8x portal label', () => {
    const line = buildRewardsLine('Chase Sapphire Reserve', 'Travel', 500);
    expect(line).toBe('📊 8x UR points — best card for Travel ✓');
  });

  it('warns with savings when a suboptimal card is used on Grocery', () => {
    // Quicksilver 1.5% = $1.50 vs Amex 6% = $6.00 on $100 → saves ~$4.50
    const line = buildRewardsLine('Capital One Quicksilver', 'Grocery', 100);
    expect(line).toContain('⚠️');
    expect(line).toContain('American Express Blue Cash Preferred earns 6% here');
    expect(line).toContain('saves ~$4.50');
  });

  it('warns when CSR is used on Grocery (1x UR @1.5¢=1.5% vs Amex 6%)', () => {
    const line = buildRewardsLine('Chase Sapphire Reserve', 'Grocery', 100);
    expect(line).toContain('⚠️');
    expect(line).toContain('saves ~$4.50');
  });

  it('treats a tie as best (no warning) — Quicksilver on a flat 1.5% category', () => {
    const line = buildRewardsLine('Capital One Quicksilver', 'Rent', 100);
    expect(line).toContain('✓');
    expect(line).not.toContain('⚠️');
  });

  it('merchant-aware: Amex on Grocery at Costco is NOT best — recommends Quicksilver', () => {
    // At Costco (MCC 5300), Amex earns 1%, Quicksilver 1.5% wins → ~$0.50 on $100
    const line = buildRewardsLine('American Express Blue Cash Preferred', 'Grocery', 100, 'Costco Wholesale');
    expect(line).toContain('⚠️');
    expect(line).toContain('Capital One Quicksilver earns 1.5% here');
    expect(line).toContain('saves ~$0.50');
  });

  it('merchant-aware: Amex on Grocery at a real supermarket IS best', () => {
    const line = buildRewardsLine('American Express Blue Cash Preferred', 'Grocery', 100, 'Safeway');
    expect(line).toBe('📊 6% cash back — best card for Grocery ✓');
  });

  it('Amex is best for streaming vendors (Netflix → 7372 → 6%)', () => {
    const line = buildRewardsLine('American Express Blue Cash Preferred', 'Entertainment', 15, 'Netflix');
    expect(line).toContain('6% cash back');
    expect(line).toContain('✓');
  });

  it('warns when non-Amex card used for Netflix streaming', () => {
    const line = buildRewardsLine('Capital One Quicksilver', 'Entertainment', 15, 'Netflix');
    expect(line).toContain('⚠️');
    expect(line).toContain('American Express Blue Cash Preferred');
  });
});
