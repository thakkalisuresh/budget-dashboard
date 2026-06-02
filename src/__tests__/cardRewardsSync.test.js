import { describe, it, expect } from 'vitest';
import * as client from '../cardRewards.js';
import * as server from '../../netlify/functions/_card-rewards.mjs';

/**
 * Flag 1 drift-guard: src/cardRewards.js and netlify/functions/_card-rewards.mjs
 * duplicate the reward rates and MCC resolution logic (the bot can't import client modules).
 * This test fails the moment they diverge — change a rate or vendor mapping in one file
 * and forget the other, and CI catches it here.
 */

const CARDS = [
  'Chase Sapphire Reserve',
  'American Express Blue Cash Preferred',
  'Capital One Quicksilver',
  'Chase Freedom Unlimited',
  'Bilt Blue Card',
  'Chase Debit Card - Anu',
  'Cash',
];
const CATEGORIES = [
  'Grocery', 'Eating Out', 'Misc', 'Travel', 'Thakkali', 'Entertainment',
  'Investment', 'Car Payments', 'Utilities', 'Rent', 'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];
const VENDORS = ['', 'Costco Wholesale', 'Walmart', 'Target', 'Safeway', "Trader Joe's", 'Zomato', 'Netflix', 'Uber', 'Uber Eats', 'Delta Airlines', 'Marriott'];
const MCCS = ['5812', '5814', '5411', '5422', '5300', '5310', '4511', '7011', '5912', '7372', '5541', '4121', '5999', '6513', '7996', '4814', 'CHASE_PORTAL'];
const BOOKING_METHODS = ['portal', 'direct'];
const AMOUNTS = [0, 12.5, 100, 7000];

describe('cardRewards client/server parity', () => {
  it('rate tables are structurally identical', () => {
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

  it('getEffectiveRates agrees: null/empty → defaults, custom → custom', () => {
    // No override → both fall back to identical CARD_REWARDS
    expect(server.getEffectiveRates({})).toEqual(client.getEffectiveRates({}));
    expect(server.getEffectiveRates({ cardRewardRates: null })).toEqual(client.CARD_REWARDS);
    expect(client.getEffectiveRates(null)).toEqual(client.CARD_REWARDS);
    // Custom override → returned as-is, identically
    const custom = { 'Capital One Quicksilver': { type: 'cashback', unit: '$', mccs: {}, default: 2 } };
    expect(server.getEffectiveRates({ cardRewardRates: custom })).toEqual(custom);
    expect(client.getEffectiveRates({ cardRewardRates: custom })).toEqual(custom);
  });

  it('resolveMCC agrees for vendor × category combinations', () => {
    for (const vendor of VENDORS) {
      for (const cat of CATEGORIES) {
        expect(server.resolveMCC(vendor, cat)).toBe(client.resolveMCC(vendor, cat));
      }
    }
  });

  it('calculateRewards agrees across card × mcc × bookingMethod × amount', () => {
    for (const card of CARDS) {
      for (const mcc of MCCS) {
        for (const bm of BOOKING_METHODS) {
          for (const amt of AMOUNTS) {
            expect(server.calculateRewards(card, mcc, amt, 0, bm))
              .toEqual(client.calculateRewards(card, mcc, amt, 0, bm));
          }
        }
      }
    }
  });

  it('calculateRewards uses custom rates when passed', () => {
    // A custom rate that bumps Quicksilver to 3% cash back
    const customRates = {
      ...client.CARD_REWARDS,
      'Capital One Quicksilver': { ...client.CARD_REWARDS['Capital One Quicksilver'], default: 3 },
    };
    const r = client.calculateRewards('Capital One Quicksilver', '5999', 100, 0, 'portal', customRates);
    expect(r.rate).toBe(3);
    expect(r.value).toBeCloseTo(3, 5);
    // Server must agree
    expect(server.calculateRewards('Capital One Quicksilver', '5999', 100, 0, 'portal', customRates))
      .toEqual(r);
  });

  it('getBestCard uses custom rates when passed', () => {
    // Bump Quicksilver to 10% cash back — should win everything
    const customRates = {
      ...client.CARD_REWARDS,
      'Capital One Quicksilver': { ...client.CARD_REWARDS['Capital One Quicksilver'], default: 10 },
    };
    expect(client.getBestCard('Grocery', '', customRates).card).toBe('Capital One Quicksilver');
    expect(server.getBestCard('Grocery', '', customRates).card).toBe('Capital One Quicksilver');
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
      for (const mcc of MCCS) {
        const r = client.calculateRewards(card, mcc, 100);
        expect(server.rewardsDollarValue(card, r)).toBeCloseTo(client.rewardsDollarValue(card, r), 10);
      }
    }
  });
});
