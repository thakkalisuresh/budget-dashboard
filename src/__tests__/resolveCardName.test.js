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

/* ── Alias layer + backend/frontend mirror parity ── */

import { resolveCardName as backendResolve, CARD_ALIASES as BACKEND_ALIASES } from '../../functions/lib/_card-resolver.mjs';
import { CARD_ALIASES as FRONTEND_ALIASES } from '../receiptHelpers.js';

describe('resolveCardName — alias layer', () => {
  it('resolves abbreviations the substring matcher cannot reach', () => {
    // "bcp" is 3 chars, below the >=5 guard, and shares no usable substring
    // with the canonical name — it is unreachable without the alias map.
    expect(resolveCardName('BCP', CARDS)).toBe('American Express Blue Cash Preferred');
    expect(resolveCardName('csr', CARDS)).toBe('Chase Sapphire Reserve');
    expect(resolveCardName('CFU', CARDS)).toBe('Chase Freedom Unlimited');
  });

  it('still resolves the plain shortening that already worked by containment', () => {
    expect(resolveCardName('Blue Cash Preferred', CARDS)).toBe('American Express Blue Cash Preferred');
  });

  it('never invents a card the user does not hold', () => {
    // 'bilt' is a known alias, but this user has no Bilt card. Returning the
    // canonical name anyway would create a new bucket — the exact bug class
    // this function exists to prevent.
    expect(resolveCardName('bilt', CARDS)).toBe('');
    expect(resolveCardName('BCP', ['Chase Sapphire Reserve'])).toBe('');
  });

  it('leaves non-alias input on the original code path', () => {
    expect(resolveCardName('cash', CARDS)).toBe('Cash');
    expect(resolveCardName('totally unknown card', CARDS)).toBe('');
  });
});

describe('card resolver — backend/frontend mirror parity', () => {
  // src/receiptHelpers.js and functions/lib/_card-resolver.mjs are duplicated
  // deliberately (the frontend bundle can't import from functions/). This test
  // is the thing that catches them drifting apart.
  it('ships identical alias maps', () => {
    expect(FRONTEND_ALIASES).toEqual(BACKEND_ALIASES);
  });

  it('agrees on every case exercised above', () => {
    const inputs = [
      'BCP', 'csr', 'CFU', 'Blue Cash Preferred', 'bilt', 'cash',
      'chase sapphire reserve', 'CAPITAL ONE QUICKSILVER', 'totally unknown card',
      '', null, 'Sapphire Reserve',
    ];
    for (const raw of inputs) {
      expect(backendResolve(raw, CARDS), `mirror drift on "${raw}"`)
        .toBe(resolveCardName(raw, CARDS));
    }
  });
});
