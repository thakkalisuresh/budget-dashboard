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

  it('resolves the Capital One wallet-notification title to the held card', () => {
    // The Capital One app notification is titled "Quicksilver Credit Card": no
    // containment with "Capital One Quicksilver" in either direction.
    expect(resolveCardName('Quicksilver Credit Card', CARDS)).toBe('Capital One Quicksilver');
    expect(backendResolve('Quicksilver Credit Card', CARDS)).toBe('Capital One Quicksilver');
    expect(resolveCardName('Quicksilver Credit Card', ['Chase Sapphire Reserve'])).toBe('');
  });

  it('leaves non-alias input on the original code path', () => {
    expect(resolveCardName('cash', CARDS)).toBe('Cash');
    expect(resolveCardName('totally unknown card', CARDS)).toBe('');
  });
});

describe('resolveCardName — ambiguity', () => {
  const HOUSEHOLD = [
    'Chase Sapphire Reserve',
    'American Express Blue Cash Preferred',
    'Capital One Quicksilver',
    'Chase Freedom Unlimited',
    'Chase Freedom Rise',
    'Bilt Blue Card',
    'Chase Debit Card - Anu',
    'Chase Debit Card - Sabarish',
  ];
  const both = (raw, cards) => {
    const a = resolveCardName(raw, cards);
    expect(backendResolve(raw, cards), `mirror drift on "${raw}"`).toBe(a);
    return a;
  };

  it('never guesses between two cards that both contain the text (order must not matter)', () => {
    // Bare "Chase Debit" fits both people's debit cards: first-wins used to
    // attribute it to whoever was listed first.
    expect(both('Chase Debit', HOUSEHOLD)).toBe('');
    expect(both('Chase Debit', [...HOUSEHOLD].reverse())).toBe('');
    expect(both('Chase Debit Card', HOUSEHOLD)).toBe('');
    expect(both('Chase Freedom', HOUSEHOLD)).toBe('');
  });

  it('still resolves when exactly one card contains the text', () => {
    expect(both('American Express', HOUSEHOLD)).toBe('American Express Blue Cash Preferred');
    expect(both('Sapphire Reserve', HOUSEHOLD)).toBe('Chase Sapphire Reserve');
    expect(both('Chase Debit', ['Chase Debit Card - Anu', 'Bilt Blue Card'])).toBe('Chase Debit Card - Anu');
  });

  it('exact normalized match always wins over longer names', () => {
    expect(both('Chase Debit Card - Sabarish', HOUSEHOLD)).toBe('Chase Debit Card - Sabarish');
    expect(both('chase freedom rise', HOUSEHOLD)).toBe('Chase Freedom Rise');
  });

  it('when the text contains several held card names, the longest unique one wins', () => {
    const cards = ['Chase Freedom', 'Chase Freedom Unlimited'];
    expect(both('Chase Freedom Unlimited Visa', cards)).toBe('Chase Freedom Unlimited');
    // same length -> ambiguous -> ''
    expect(both('Alpha Rewards Card Bravo Rewards Card', ['Alpha Rewards Card', 'Bravo Rewards Card'])).toBe('');
  });

  it('aliases still resolve through the same rules; unheld cards stay empty', () => {
    expect(both('Quicksilver Credit Card', HOUSEHOLD)).toBe('Capital One Quicksilver');
    expect(both('CSR', HOUSEHOLD)).toBe('Chase Sapphire Reserve');
    expect(both('Discover It', HOUSEHOLD)).toBe('');
  });
});

describe('resolveCardName — masked last-four suffix and truncation', () => {
  // The Capital One app titles its notification "Quicksilver Credit Card…NNNN".
  // Digits below are obviously fake.
  const both = (raw, cards = CARDS) => {
    const a = resolveCardName(raw, cards);
    expect(backendResolve(raw, cards), `mirror drift on "${raw}"`).toBe(a);
    return a;
  };

  it('strips an ellipsis + last four before matching', () => {
    expect(both('Quicksilver Credit Card…0000')).toBe('Capital One Quicksilver');
    expect(both('Quicksilver Credit Card...0000')).toBe('Capital One Quicksilver');
    expect(both('Quicksilver Credit Card … 0000')).toBe('Capital One Quicksilver');
    expect(both('Quicksilver Credit Card…000')).toBe('Capital One Quicksilver');
  });

  it('strips "ending in", bullets, asterisks, parens, x and dash forms', () => {
    for (const raw of [
      'Quicksilver Credit Card ending in 0000',
      'Quicksilver Credit Card ending 0000',
      'Quicksilver Credit Card •••• 0000',
      'Quicksilver Credit Card **** 0000',
      'Quicksilver Credit Card (…0000)',
      'Quicksilver Credit Card (••••0000)',
      'Quicksilver Credit Card x0000',
      'Quicksilver Credit Card - 0000',
    ]) expect(both(raw), raw).toBe('Capital One Quicksilver');
  });

  it('also works for names that resolve by containment, not alias', () => {
    expect(both('Chase Sapphire Reserve…0000')).toBe('Chase Sapphire Reserve');
    expect(both('Sapphire Reserve ending in 0000')).toBe('Chase Sapphire Reserve');
  });

  it('only strips a short (3-4 digit) suffix at the end', () => {
    // 5 digits after the ellipsis is not a last-four mask: left alone.
    expect(both('Quicksilver Credit Card…00000')).toBe('');
    // digits in the middle are untouched
    expect(both('Quicksilver 0000 Credit Card')).toBe('');
  });

  it('does not mangle a held name that legitimately contains digits', () => {
    const cards = ['Gold 5000', 'Visa - 1234', 'Chase Sapphire Reserve'];
    expect(both('Gold 5000', cards)).toBe('Gold 5000');
    expect(both('gold5000', cards)).toBe('Gold 5000');
    // exact match on the unstripped string wins before any stripping
    expect(both('Visa - 1234', cards)).toBe('Visa - 1234');
    // the real suffix comes off, leaving the held name itself
    expect(both('Visa - 1234…0000', cards)).toBe('Visa - 1234');
  });

  it('keeps ambiguity => empty after stripping', () => {
    const cards = ['Chase Debit Card - A', 'Chase Debit Card - B'];
    expect(both('Chase Debit Card…0000', cards)).toBe('');
    expect(both('Chase Debit Card…0000', [...cards].reverse())).toBe('');
  });

  it('never invents an unheld card, with or without the suffix', () => {
    expect(both('Quicksilver Credit Card…0000', ['Chase Sapphire Reserve'])).toBe('');
  });

  it('resolves a truncated title through a unique alias prefix', () => {
    expect(both('Quicksilver Credit C…')).toBe('Capital One Quicksilver');
    expect(both('Quicksilver Credit C...')).toBe('Capital One Quicksilver');
    expect(both('Quicksilver Credit C…', ['Chase Sapphire Reserve'])).toBe('');
  });

  it('truncation needs >= 5 chars and exactly one target', () => {
    expect(both('Quic…')).toBe('');            // 4 chars
    // "c1" prefixes nothing >= 5; "bilt" family is too short / unheld
    expect(both('Blue…')).toBe('');
    // two different canonical targets share the prefix "chase": ambiguous
    expect(both('Chase…', ['Chase Sapphire Reserve', 'Chase Freedom Unlimited'])).toBe('');
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


describe('resolveCardName — Chase text-alert card prefixes', () => {
  const HELD = ['Chase Sapphire Reserve', 'Chase Freedom Unlimited', 'Chase Debit Card - Anu', 'Bilt Blue Card'];

  it.each([
    ['Chase Sapphire Reserve Visa', 'Chase Sapphire Reserve'],
    ['Chase Freedom Unlimited Visa', 'Chase Freedom Unlimited'],
    ['Chase Freedom Unlimited Mastercard', 'Chase Freedom Unlimited'],
  ])('resolves "%s" to the held card', (raw, held) => {
    expect(resolveCardName(raw, HELD)).toBe(held);
  });

  it('never resolves a Chase credit-card prefix to the Chase debit card', () => {
    expect(resolveCardName('Chase Sapphire Reserve Visa', HELD)).not.toMatch(/debit/i);
    expect(resolveCardName('Chase Freedom Unlimited Visa', HELD)).not.toMatch(/debit/i);
  });

  it('does not invent a card the user does not hold', () => {
    expect(resolveCardName('Chase Sapphire Preferred Visa', HELD)).toBe('');
    expect(resolveCardName('Chase Sapphire Reserve Visa', ['Chase Debit Card - Anu'])).toBe('');
  });
});
