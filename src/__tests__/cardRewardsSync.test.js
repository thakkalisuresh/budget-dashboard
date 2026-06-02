import { describe, it, expect } from 'vitest';
import * as client from '../cardRewards.js';
import * as server from '../../netlify/functions/_card-rewards.mjs';

/**
 * Flag 1 drift-guard: src/cardRewards.js and netlify/functions/_card-rewards.mjs
 * duplicate the reward rates (the bot can't import client modules). This test
 * fails the moment they diverge — change a rate in one file and forget the
 * other, and CI catches it here.
 */

const CARDS = [
  'Chase Sapphire Reserve',
  'American Express Blue Cash Preferred',
  'Capital One Quicksilver',
  'Chase Freedom Unlimited',
  'Chase Debit Card - Anu',
  'Cash',
];
const CATEGORIES = [
  'Grocery', 'Eating Out', 'Misc', 'Travel', 'Thakkali', 'Entertainment',
  'Investment', 'Car Payments', 'Utilities', 'Rent', 'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];
const VENDORS = ['', 'Costco Wholesale', 'Walmart', 'Target', 'Safeway', "Trader Joe's", 'Zomato'];
const AMOUNTS = [0, 12.5, 100, 7000];

describe('cardRewards client/server parity', () => {
  it('rate tables are byte-identical', () => {
    expect(server.CARD_REWARDS).toEqual(client.CARD_REWARDS);
  });

  it('point-value constants match', () => {
    expect(server.UR_POINT_VALUE_CSR).toBe(client.UR_POINT_VALUE_CSR);
    expect(server.UR_POINT_VALUE_CFU).toBe(client.UR_POINT_VALUE_CFU);
  });

  it('cardEarnsRewards agrees across all cards', () => {
    for (const c of CARDS) {
      expect(server.cardEarnsRewards(c)).toBe(client.cardEarnsRewards(c));
    }
  });

  it('isAmexGroceryExcluded agrees across vendors', () => {
    for (const v of VENDORS) {
      expect(server.isAmexGroceryExcluded(v)).toBe(client.isAmexGroceryExcluded(v));
    }
  });

  it('calculateRewards agrees across card × category × vendor × amount', () => {
    for (const card of CARDS) {
      for (const cat of CATEGORIES) {
        for (const vendor of VENDORS) {
          for (const amt of AMOUNTS) {
            expect(server.calculateRewards(card, cat, amt, 0, vendor))
              .toEqual(client.calculateRewards(card, cat, amt, 0, vendor));
          }
        }
      }
    }
  });

  it('getBestCard agrees across category × vendor', () => {
    for (const cat of CATEGORIES) {
      for (const vendor of VENDORS) {
        expect(server.getBestCard(cat, vendor)).toEqual(client.getBestCard(cat, vendor));
      }
    }
  });

  it('rewardsDollarValue agrees for representative results', () => {
    for (const card of CARDS) {
      for (const cat of CATEGORIES) {
        const r = client.calculateRewards(card, cat, 100);
        expect(server.rewardsDollarValue(card, r)).toBeCloseTo(client.rewardsDollarValue(card, r), 10);
      }
    }
  });
});
