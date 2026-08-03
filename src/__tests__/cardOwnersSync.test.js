import { describe, it, expect } from 'vitest';
import * as client from '../cardOwners.js';
import * as server from '../../functions/lib/_card-owners.mjs';

/**
 * Drift guard for the src/cardOwners.js ↔ functions/lib/_card-owners.mjs pair.
 *
 * Cloud Functions bundle only the `functions` directory, so a backend module
 * cannot import from `src/` — the same constraint that produced the
 * cardRewards pair. Two copies of a table are safe only while something pins
 * them together, and this is that something: reassign a card in one file and
 * forget the other, and CI stops you.
 *
 * The stake is higher here than for a display label. `card_owner` is FROZEN
 * into every archived transaction at write time; if the two maps disagree, the
 * bot and the wallet webhook permanently attribute the same card to different
 * people, and no later fix can correct rows already written.
 */

const CARDS = [
  'American Express Blue Cash Preferred',
  'Capital One Quicksilver',
  'Chase Freedom Rise',
  'Chase Debit Card - Sabarish',
  'Chase Bank Account - Sabarish',
  'Chase Sapphire Reserve',
  'Bilt Blue Card',
  'Chase Freedom Unlimited',
  'Chase Debit Card - Anu',
  'Chase Bank Account - Anu',
  'Cash',
  'Some Card Nobody Has',
  '',
];

describe('card→owner map parity', () => {
  it('the default maps are byte-identical', () => {
    expect(server.DEFAULT_CARD_OWNERS).toEqual(client.DEFAULT_CARD_OWNERS);
  });

  it('the default people map matches', () => {
    expect(server.DEFAULT_PEOPLE).toEqual(client.DEFAULT_PEOPLE);
  });

  it('ownerForCard agrees on every known card, and on the ones nobody owns', () => {
    for (const card of CARDS) {
      expect(server.ownerForCard(card), `default map: ${card}`).toBe(client.ownerForCard(card));
    }
  });

  it('agrees when Settings overrides the map', () => {
    const custom = { 'Chase Sapphire Reserve': 'me', 'Brand New Card': 'wife' };
    for (const card of [...CARDS, 'Brand New Card']) {
      expect(server.ownerForCard(card, custom), `custom map: ${card}`)
        .toBe(client.ownerForCard(card, custom));
    }
  });

  it('agrees when handed junk instead of a map', () => {
    for (const bad of [null, undefined, 'nope', 42]) {
      expect(server.ownerForCard('Bilt Blue Card', bad)).toBe(client.ownerForCard('Bilt Blue Card', bad));
    }
  });

  it('cardsForOwner and ownerLabel agree too', () => {
    for (const owner of ['me', 'wife', 'nobody', null]) {
      expect(server.cardsForOwner(owner)).toEqual(client.cardsForOwner(owner));
      expect(server.ownerLabel(owner)).toBe(client.ownerLabel(owner));
    }
    expect(server.ownerLabel('me', { me: 'S' })).toBe(client.ownerLabel('me', { me: 'S' }));
  });

  it('exports the same surface, so a new helper cannot land on one side only', () => {
    expect(Object.keys(server).sort()).toEqual(Object.keys(client).sort());
  });
});
