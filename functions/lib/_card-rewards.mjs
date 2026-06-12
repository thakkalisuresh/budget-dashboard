/**
 * Server-side mirror of src/cardRewards.js + src/vendorMCC.js for the bot.
 * Netlify functions cannot import client (src/) modules, so the rates and
 * calculation logic are duplicated here. Keep in sync with both src/ files.
 */

export const UR_POINT_VALUE_CSR  = 0.015; // $ per UR point (CSR travel portal)
export const UR_POINT_VALUE_CFU  = 0.01;  // $ per UR point (CFU base)
export const BILT_POINT_VALUE    = 0.0125; // $ per Bilt point (~1.25¢, partner transfers)

// ── Vendor MCC table (mirror of src/vendorMCC.js) ───────────────────────────
// More specific keys must appear before shorter prefixes so the longer match wins.
const VENDOR_MCC = {
  // Airlines
  'delta': '4511', 'united': '4511', 'american airlines': '4511',
  'southwest': '4511', 'emirates': '4511', 'british airways': '4511',
  'jetblue': '4511', 'alaska airlines': '4511',

  // Hotels
  'marriott': '7011', 'hilton': '7011', 'hyatt': '7011',
  'ihg': '7011', 'wyndham': '7011', 'airbnb': '7011', 'vrbo': '7011',

  // Chase Travel portal
  'chase travel': 'CHASE_PORTAL',

  // Wholesale clubs / superstores — Amex 6% excluded
  'costco': '5300', 'sams club': '5300', 'bjs': '5300',
  'walmart': '5310', 'target': '5310',

  // US supermarkets — Amex 6%
  'kroger': '5411', 'safeway': '5411', 'trader joes': '5411',
  'whole foods': '5411', 'publix': '5411', 'aldi': '5411',
  'heb': '5411', 'wegmans': '5411',

  // Streaming — Amex 6%
  'netflix': '7372', 'spotify': '7372', 'hulu': '7372',
  'disney plus': '7372', 'disney': '7372', 'apple tv': '7372',
  'youtube premium': '7372', 'amazon prime': '7372',
  'peacock': '7372', 'paramount': '7372', 'hbo': '7372',

  // Gas stations — Amex 3%
  'shell': '5541', 'chevron': '5541', 'bp': '5541',
  'exxon': '5541', 'mobil': '5541', 'citgo': '5541',
  'sunoco': '5541', 'texaco': '5541',

  // Food delivery (before shorter rideshare keys)
  'ubereats': '5812', 'doordash': '5812', 'grubhub': '5812',

  // Rideshare — Amex 3%
  'uber': '4121', 'lyft': '4121', 'ola': '4121',

  // Pharmacies — CFU 3x
  'cvs': '5912', 'walgreens': '5912', 'rite aid': '5912',

  // Restaurants
  'starbucks': '5812', 'chipotle': '5812', 'zomato': '5812',
  'mcdonalds': '5814', 'subway': '5814', 'dominos': '5814',
};

const CATEGORY_DEFAULT_MCC = {
  'Eating Out':    '5812',
  'Thakkali':      '5999',
  'Grocery':       '5411',
  'Travel':        '4511',
  'Holiday':       '7011',
  'Health':        '5912',
  'Entertainment': '7996',
  'Wi-Fi':         '4814',
  'Utilities':     '4900',
  'Rent':          '6513',
  'Investment':    '6211',
  'Car Payments':  '5511',
  'Furniture':     '5712',
  'Misc':          '5999',
};

export function resolveMCC(vendor, category) {
  const v = (vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, mcc] of Object.entries(VENDOR_MCC)) {
    if (v.includes(key.replace(/[^a-z0-9]/g, ''))) return mcc;
  }
  return CATEGORY_DEFAULT_MCC[category] || '5999';
}

// ── Rate tables (mirror of src/cardRewards.js) ───────────────────────────────
export const CARD_REWARDS = {
  'Chase Sapphire Reserve': {
    type: 'points', unit: 'UR', pointValue: UR_POINT_VALUE_CSR,
    mccs: {
      '5812': 3, '5813': 3, '5814': 3,
      '4511': { portal: 8, direct: 4 },
      '7011': { portal: 8, direct: 4 },
      'CHASE_PORTAL': 8,
    },
    default: 1,
  },
  'American Express Blue Cash Preferred': {
    type: 'cashback', unit: '$',
    mccs: {
      '5411': { rate: 6, cap: { annual: 6000, then: 1 } },
      '5422': { rate: 6, cap: { annual: 6000, then: 1 } },
      '5300': 1, '5310': 1, '5311': 1,
      '7372': 6,
      '5541': 3, '5542': 3,
      '4121': 3, '4111': 3, '4131': 3,
      '4784': 3,
      '7523': 3,
    },
    default: 1,
  },
  'Capital One Quicksilver': {
    type: 'cashback', unit: '$',
    mccs: {},
    default: 1.5,
  },
  'Chase Freedom Unlimited': {
    type: 'points', unit: 'UR', pointValue: UR_POINT_VALUE_CFU,
    mccs: {
      '5812': 3, '5813': 3, '5814': 3,
      '5912': 3,
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

export function cardEarnsRewards(card, rates = CARD_REWARDS) {
  return !!(rates || CARD_REWARDS)[card];
}

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

export function calculateRewards(card, mcc, amount, ytdSpend = 0, bookingMethod = 'portal', rates = CARD_REWARDS) {
  const cfg = (rates || CARD_REWARDS)[card];
  if (!cfg || !(amount > 0)) return { type: 'none', value: 0, unit: '', rate: 0 };

  const mccCfg = cfg.mccs[mcc];

  if (mccCfg && typeof mccCfg === 'object' && 'portal' in mccCfg) {
    const rate = bookingMethod === 'direct' ? mccCfg.direct : mccCfg.portal;
    return { type: 'points', value: amount * rate, unit: cfg.unit, rate };
  }

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

export function rewardsDollarValue(card, rewards, rates = CARD_REWARDS) {
  if (!rewards || rewards.type === 'none') return 0;
  if (rewards.type === 'cashback') return rewards.value;
  const cfg = (rates || CARD_REWARDS)[card];
  return rewards.value * (cfg?.pointValue || 0.01);
}

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
    else if (Math.abs(diff) <= 1e-9 && cand.type === 'cashback' && best.type !== 'cashback') best = cand;
  }
  return best;
}

// ── Bot-specific helpers ─────────────────────────────────────────────────────

function rateLabelFull(card, mcc, bookingMethod = 'portal', rates = CARD_REWARDS) {
  const cfg = (rates || CARD_REWARDS)[card];
  const rate = rawRate(card, mcc, bookingMethod, rates);
  return cfg.type === 'cashback' ? `${rate}% cash back` : `${rate}x ${cfg.unit} points`;
}

function rateLabelShort(card, mcc, bookingMethod = 'portal', rates = CARD_REWARDS) {
  const cfg = (rates || CARD_REWARDS)[card];
  const rate = rawRate(card, mcc, bookingMethod, rates);
  return cfg.type === 'cashback' ? `${rate}%` : `${rate}x ${cfg.unit}`;
}

/**
 * Build the bot's rewards line for a logged transaction.
 * Returns '' for non-reward cards (debit/bank/cash) or zero amount.
 *  - best card used → "📊 6% cash back — best card for Grocery ✓"
 *  - suboptimal     → "⚠️ <best card> earns 6% here — saves ~$X.XX on this transaction"
 * Pass `rates` from getEffectiveRates(settings) to respect user-customised rates.
 */
export function buildRewardsLine(card, category, amount, vendor = '', rates = CARD_REWARDS) {
  const effectiveRates = rates || CARD_REWARDS;
  if (!cardEarnsRewards(card, effectiveRates) || !(amount > 0)) return '';
  const mcc  = resolveMCC(vendor, category);
  const best = getBestCard(category, vendor, effectiveRates);
  if (!best) return '';

  const usedVal = rewardsDollarValue(card, calculateRewards(card, mcc, amount, 0, 'portal', effectiveRates), effectiveRates);
  const bestVal = rewardsDollarValue(best.card, calculateRewards(best.card, mcc, amount, 0, 'portal', effectiveRates), effectiveRates);
  const savings = bestVal - usedVal;

  if (savings <= 0.005) {
    return `📊 ${rateLabelFull(card, mcc, 'portal', effectiveRates)} — best card for ${category} ✓`;
  }
  return `⚠️ ${best.card} earns ${rateLabelShort(best.card, mcc, 'portal', effectiveRates)} here — saves ~$${savings.toFixed(2)} on this transaction`;
}
