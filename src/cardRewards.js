/**
 * Card rewards engine — MCC-based rates for the household's cards.
 *
 * Two reward types, tracked SEPARATELY (never summed together):
 *   - 'cashback' → value is a dollar amount (rate is a % of spend)
 *   - 'points'   → value is a point count (rate is a multiplier ×spend in $)
 *
 * Point → dollar valuation (for comparison + estimated-value display only):
 *   - Chase UR via Sapphire Reserve travel portal ≈ 1.5¢/pt
 *   - Freedom Unlimited UR ≈ 1.0¢/pt base (1.5¢ if pooled with CSR)
 */

import { resolveMCC } from './vendorMCC.js';
export { resolveMCC };

export const UR_POINT_VALUE_CSR  = 0.015; // $ per UR point (CSR travel portal)
export const UR_POINT_VALUE_CFU  = 0.01;  // $ per UR point (CFU base)
export const BILT_POINT_VALUE    = 0.0125; // $ per Bilt point (~1.25¢, partner transfers)

// rate semantics: cashback → percent (6 = 6%); points → multiplier (3 = 3x)
// MCC entries: number = flat rate; { portal, direct } = booking-method split;
//              { rate, cap } = annual-capped category
export const CARD_REWARDS = {
  'Chase Sapphire Reserve': {
    type: 'points', unit: 'UR', pointValue: UR_POINT_VALUE_CSR,
    mccs: {
      '5812': 3, '5813': 3, '5814': 3,            // dining
      '4511': { portal: 8, direct: 4 },            // airlines
      '7011': { portal: 8, direct: 4 },            // hotels
      'CHASE_PORTAL': 8,                            // catch-all Chase Travel portal
    },
    default: 1,
  },
  'American Express Blue Cash Preferred': {
    type: 'cashback', unit: '$',
    mccs: {
      '5411': { rate: 6, cap: { annual: 6000, then: 1 } }, // US supermarkets
      '5422': { rate: 6, cap: { annual: 6000, then: 1 } }, // specialty food
      '5300': 1, '5310': 1, '5311': 1,            // wholesale/superstore exclusions → base
      '7372': 6,                                    // streaming
      '5541': 3, '5542': 3,                        // gas stations
      '4121': 3, '4111': 3, '4131': 3,            // rideshare, local transit, bus
      '4784': 3,                                    // bridge/road tolls
      '7523': 3,                                    // parking lots/garages
    },
    default: 1,
  },
  'Capital One Quicksilver': {
    type: 'cashback', unit: '$',
    mccs: {},
    default: 1.5,
  },
  'Chase Freedom Rise': {
    type: 'cashback', unit: '$',
    mccs: {},
    default: 1.5,                                 // flat 1.5% cash back, all purchases
  },
  'Chase Freedom Unlimited': {
    type: 'points', unit: 'UR', pointValue: UR_POINT_VALUE_CFU,
    mccs: {
      '5812': 3, '5813': 3, '5814': 3,            // dining
      '5912': 3,                                    // pharmacy/drugstore
    },
    default: 1.5,
  },
  'Bilt Blue Card': {
    type: 'points', unit: 'Bilt', pointValue: BILT_POINT_VALUE,
    mccs: {
      '5812': 3, '5813': 3, '5814': 3,            // dining
      '4511': 2, '7011': 2,                        // airlines, hotels
    },
    default: 1,
  },
};

// Cards with no rewards program (debit, bank, cash)
export function cardEarnsRewards(card, rates = CARD_REWARDS) {
  return !!(rates || CARD_REWARDS)[card];
}

/**
 * Effective rate table: user-overridden rates from settings if present,
 * otherwise the hardcoded CARD_REWARDS defaults. `cardRewardRates` is set by
 * the Settings UI.
 */
export function getEffectiveRates(settings) {
  const custom = settings && settings.cardRewardRates;
  return (custom && typeof custom === 'object' && Object.keys(custom).length > 0)
    ? custom
    : CARD_REWARDS;
}

function rawRate(card, mcc, bookingMethod = 'portal', rates = CARD_REWARDS) {
  const cfg = (rates || CARD_REWARDS)[card];
  if (!cfg) return 0;
  const mccCfg = cfg.mccs[mcc];
  if (mccCfg == null) return cfg.default;
  if (typeof mccCfg === 'number') return mccCfg;
  if ('portal' in mccCfg) return bookingMethod === 'direct' ? mccCfg.direct : mccCfg.portal;
  if ('rate' in mccCfg) return mccCfg.rate;
  return cfg.default;
}

/**
 * Calculate rewards earned on a single transaction.
 * @param mcc        - MCC resolved via resolveMCC(vendor, category)
 * @param ytdSpend   - year-to-date spend qualifying for the same cap bucket (Amex supermarkets)
 * @param bookingMethod - 'portal' (default) or 'direct' — only relevant for CSR travel MCCs
 * @param rates      - effective rate table (defaults to CARD_REWARDS; pass getEffectiveRates(settings))
 * @returns { type, value, unit, rate }
 */
export function calculateRewards(card, mcc, amount, ytdSpend = 0, bookingMethod = 'portal', rates = CARD_REWARDS) {
  const cfg = (rates || CARD_REWARDS)[card];
  if (!cfg || !(amount > 0)) return { type: 'none', value: 0, unit: '', rate: 0 };

  const mccCfg = cfg.mccs[mcc];

  // Travel MCCs with portal/direct split (CSR airlines + hotels)
  if (mccCfg && typeof mccCfg === 'object' && 'portal' in mccCfg) {
    const rate = bookingMethod === 'direct' ? mccCfg.direct : mccCfg.portal;
    return { type: 'points', value: amount * rate, unit: cfg.unit, rate };
  }

  // Capped categories (Amex US supermarkets — 6% up to $6k/yr, then 1%)
  if (mccCfg && typeof mccCfg === 'object' && mccCfg.cap) {
    const { rate, cap: { annual, then } } = mccCfg;
    const remaining = Math.max(0, annual - ytdSpend);
    const atRate    = Math.min(amount, remaining);
    const overRate  = amount - atRate;
    const value     = (atRate * rate / 100) + (overRate * then / 100);
    return { type: 'cashback', value, unit: '$', rate };
  }

  const rate = typeof mccCfg === 'number' ? mccCfg : cfg.default;

  if (cfg.type === 'cashback') {
    return { type: 'cashback', value: amount * rate / 100, unit: '$', rate };
  }
  return { type: 'points', value: amount * rate, unit: cfg.unit, rate };
}

/** Estimated dollar value of a rewards result (points × pointValue, or cash as-is). */
export function rewardsDollarValue(card, rewards, rates = CARD_REWARDS) {
  if (!rewards || rewards.type === 'none') return 0;
  if (rewards.type === 'cashback') return rewards.value;
  const cfg = (rates || CARD_REWARDS)[card];
  return rewards.value * (cfg?.pointValue || 0.01);
}

/**
 * Best card for a category by estimated dollar return per $1 spent.
 * Pass `vendor` for merchant-aware comparison (e.g. Costco → Quicksilver beats Amex).
 * Pass `rates` (from getEffectiveRates) to respect user-customised rates.
 * Uses portal booking for CSR travel (the typical/default case).
 * Ignores annual caps (ceiling, not a per-$ rate change at the margin).
 */
export function getBestCard(category, vendor = '', rates = CARD_REWARDS) {
  const effectiveRates = rates || CARD_REWARDS;
  const mcc = resolveMCC(vendor, category);
  let best = null;
  for (const card of Object.keys(effectiveRates)) {
    const r = calculateRewards(card, mcc, 1, 0, 'portal', effectiveRates);
    const perDollar = rewardsDollarValue(card, r, effectiveRates);
    const cand = { card, rate: r.rate, type: r.type, unit: r.unit, perDollar };
    if (!best) { best = cand; continue; }
    const diff = perDollar - best.perDollar;
    if (diff > 1e-9) best = cand;
    // On a tie, prefer cash back — more flexible than points needing travel redemption
    else if (Math.abs(diff) <= 1e-9 && cand.type === 'cashback' && best.type !== 'cashback') best = cand;
  }
  return best;
}

/** Pre-computed best-card-per-category table for UI display. */
export function bestCardTable(categories, rates = CARD_REWARDS) {
  const effectiveRates = rates || CARD_REWARDS;
  return categories.map(category => {
    const best = getBestCard(category, '', effectiveRates);
    const label = best
      ? (best.type === 'cashback' ? `${best.rate}% cash back` : `${best.rate}x ${best.unit}`)
      : '—';
    return { category, card: best?.card || '—', label };
  });
}
