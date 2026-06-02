import { describe, it, expect } from 'vitest';
import { resolveCardName } from '../receiptHelpers.js';

const CARDS = [
  'Chase Sapphire Reserve',
  'American Express Blue Cash Preferred',
  'Capital One Quicksilver',
  'Chase Freedom Unlimited',
  'Chase Debit Card - Anu',
  'Cash',
];

describe('resolveCardName', () => {
  it('returns empty for falsy raw or empty cards', () => {
    expect(resolveCardName('', CARDS)).toBe('');
    expect(resolveCardName(null, CARDS)).toBe('');
    expect(resolveCardName('Chase Sapphire Reserve', [])).toBe('');
  });

  it('matches exact name ignoring case and punctuation', () => {
    expect(resolveCardName('chase sapphire reserve', CARDS)).toBe('Chase Sapphire Reserve');
    expect(resolveCardName('CAPITAL ONE QUICKSILVER', CARDS)).toBe('Capital One Quicksilver');
  });

  it('matches when Vision returns a shorter card label', () => {
    // Apple Wallet often shows just "Sapphire Reserve"
    expect(resolveCardName('Sapphire Reserve', CARDS)).toBe('Chase Sapphire Reserve');
    expect(resolveCardName('Blue Cash Preferred', CARDS)).toBe('American Express Blue Cash Preferred');
  });

  it('matches when Vision returns a longer string containing the card', () => {
    expect(resolveCardName('Capital One Quicksilver Cash Rewards', CARDS)).toBe('Capital One Quicksilver');
  });

  it('returns empty when nothing matches confidently', () => {
    expect(resolveCardName('Discover It', CARDS)).toBe('');
    expect(resolveCardName('Wells Fargo Active Cash', CARDS)).toBe('');
  });

  it('matches Cash', () => {
    expect(resolveCardName('cash', CARDS)).toBe('Cash');
  });
});
