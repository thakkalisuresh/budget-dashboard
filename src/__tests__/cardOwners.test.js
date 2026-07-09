import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CARD_OWNERS, DEFAULT_PEOPLE,
  ownerForCard, cardsForOwner, ownerLabel,
} from '../cardOwners.js';
import { escapeRe, ownerRegex } from '../sheetSplit.js';

describe('ownerForCard', () => {
  it('resolves seeded cards to their owner', () => {
    expect(ownerForCard('American Express Blue Cash Preferred')).toBe('me');
    expect(ownerForCard('Chase Freedom Rise')).toBe('me');
    expect(ownerForCard('Chase Sapphire Reserve')).toBe('wife');
    expect(ownerForCard('Chase Freedom Unlimited')).toBe('wife');
  });

  it('returns null for unowned / unknown / empty cards', () => {
    expect(ownerForCard('Cash')).toBeNull();
    expect(ownerForCard('Some Random Card')).toBeNull();
    expect(ownerForCard('')).toBeNull();
    expect(ownerForCard(null)).toBeNull();
  });

  it('honours a custom owner map over the default', () => {
    const custom = { 'Chase Freedom Unlimited': 'me' };
    expect(ownerForCard('Chase Freedom Unlimited', custom)).toBe('me');
    expect(ownerForCard('Chase Sapphire Reserve', custom)).toBeNull();
  });
});

describe('cardsForOwner', () => {
  it('lists exactly the cards assigned to each owner', () => {
    const mine = cardsForOwner('me');
    expect(mine).toContain('Chase Freedom Rise');
    expect(mine).toContain('Capital One Quicksilver');
    expect(mine).not.toContain('Chase Sapphire Reserve');

    const hers = cardsForOwner('wife');
    expect(hers).toContain('Bilt Blue Card');
    expect(hers).not.toContain('Chase Freedom Rise');
  });

  it('partitions the default map with no overlap', () => {
    const mine = cardsForOwner('me');
    const hers = cardsForOwner('wife');
    expect(mine.some(c => hers.includes(c))).toBe(false);
    expect(mine.length + hers.length).toBe(Object.keys(DEFAULT_CARD_OWNERS).length);
  });
});

describe('ownerLabel', () => {
  it('uses provided names, falls back to defaults', () => {
    expect(ownerLabel('me', { me: 'Bob', wife: 'Alice' })).toBe('Bob');
    expect(ownerLabel('wife')).toBe(DEFAULT_PEOPLE.wife);
    expect(ownerLabel(null)).toBe('Unassigned');
  });
});

describe('ownerRegex / escapeRe', () => {
  it('escapes regex metacharacters but leaves plain text (incl. hyphens) intact', () => {
    expect(escapeRe('Chase Bank Account - Anu')).toBe('Chase Bank Account - Anu');
    expect(escapeRe('Card (Visa)')).toBe('Card \\(Visa\\)');
    expect(escapeRe('A+B')).toBe('A\\+B');
  });

  it('joins a person’s cards into an alternation', () => {
    const re = ownerRegex(['American Express Blue Cash Preferred', 'Capital One Quicksilver']);
    expect(re).toBe('American Express Blue Cash Preferred|Capital One Quicksilver');
  });

  it('returns a non-matching token when a person has no cards', () => {
    expect(ownerRegex([])).toBe('__no_cards__');
  });
});
