/**
 * Server-side mirror of src/cardRewards.js for the bot.
 * Netlify functions cannot import client (src/) modules, so the rates and
 * calculation logic are duplicated here. Keep in sync with src/cardRewards.js.
 */

export const UR_POINT_VALUE_CSR = 0.015; // $ per UR point (CSR travel portal)
export const UR_POINT_VALUE_CFU = 0.01;  // $ per UR point (CFU base)

// rate semantics: cashback → percent (6 = 6%); points → multiplier (3 = 3x)
export const CARD_REWARDS = {
  'Chase Sapphire Reserve': {
    type: 'points', unit: 'UR', pointValue: UR_POINT_VALUE_CSR,
    // 'Thakkali' is a personal-spend bucket (no single merchant type) → base rate
    categories: { 'Eating Out': 3, 'Travel': 3, 'Holiday': 3 },
    default: 1,
  },
  'American Express Blue Cash Preferred': {
    type: 'cashback', unit: '$',
    categories: { 'Grocery': { rate: 6, cap: { annual: 6000, then: 1 } } },
    default: 1,
  },
  'Capital One Quicksilver': {
    type: 'cashback', unit: '$',
    categories: {},
    default: 1.5,
  },
  'Chase Freedom Unlimited': {
    type: 'points', unit: 'UR', pointValue: UR_POINT_VALUE_CFU,
    categories: { 'Eating Out': 3, 'Health': 3 },
    default: 1.5,
  },
};

// Amex's 6% "US supermarkets" bonus EXCLUDES warehouse clubs and superstores —
// purchases there earn the 1% base instead. Matched by vendor substring.
const AMEX_GROCERY_EXCLUDED = ['costco', 'walmart', 'target', 'samsclub', 'bjs'];

export function isAmexGroceryExcluded(vendor) {
  if (!vendor) return false;
  const v = String(vendor).toLowerCase().replace(/[^a-z0-9]/g, '');
  return AMEX_GROCERY_EXCLUDED.some(x => v.includes(x));
}

export function cardEarnsRewards(card) {
  return !!CARD_REWARDS[card];
}

function rawRate(card, category) {
  const cfg = CARD_REWARDS[card];
  if (!cfg) return 0;
  const cat = cfg.categories[category];
  if (cat == null) return cfg.default;
  return typeof cat === 'object' ? cat.rate : cat;
}

export function calculateRewards(card, category, amount, ytdCategorySpend = 0, vendor = '') {
  const cfg = CARD_REWARDS[card];
  if (!cfg || !(amount > 0)) return { type: 'none', value: 0, unit: '', rate: 0 };

  // Amex groceries at warehouse clubs / superstores earn the 1% base, not 6%
  if (card === 'American Express Blue Cash Preferred' && category === 'Grocery' && isAmexGroceryExcluded(vendor)) {
    return { type: 'cashback', value: amount * cfg.default / 100, unit: '$', rate: cfg.default };
  }

  const catCfg = cfg.categories[category];
  const rate = rawRate(card, category);

  if (catCfg && typeof catCfg === 'object' && catCfg.cap && cfg.type === 'cashback') {
    const { annual, then } = catCfg.cap;
    const remaining = Math.max(0, annual - ytdCategorySpend);
    const atRate    = Math.min(amount, remaining);
    const overRate  = amount - atRate;
    const value = (atRate * catCfg.rate / 100) + (overRate * then / 100);
    return { type: 'cashback', value, unit: '$', rate: catCfg.rate };
  }

  if (cfg.type === 'cashback') {
    return { type: 'cashback', value: amount * rate / 100, unit: '$', rate };
  }
  return { type: 'points', value: amount * rate, unit: cfg.unit, rate };
}

export function rewardsDollarValue(card, rewards) {
  if (!rewards || rewards.type === 'none') return 0;
  if (rewards.type === 'cashback') return rewards.value;
  const cfg = CARD_REWARDS[card];
  return rewards.value * (cfg?.pointValue || 0.01);
}

export function getBestCard(category, vendor = '') {
  let best = null;
  for (const card of Object.keys(CARD_REWARDS)) {
    const r = calculateRewards(card, category, 1, 0, vendor);
    const perDollar = rewardsDollarValue(card, r);
    const cand = { card, rate: r.rate, type: r.type, unit: r.unit, perDollar };
    if (!best) { best = cand; continue; }
    const diff = perDollar - best.perDollar;
    if (diff > 1e-9) best = cand;
    // On a tie, prefer cash back — more flexible than points needing travel redemption
    else if (Math.abs(diff) <= 1e-9 && cand.type === 'cashback' && best.type !== 'cashback') best = cand;
  }
  return best;
}

/** "6% cash back" / "3x UR points" */
function rateLabelFull(card, category) {
  const cfg = CARD_REWARDS[card];
  const rate = rawRate(card, category);
  return cfg.type === 'cashback' ? `${rate}% cash back` : `${rate}x ${cfg.unit} points`;
}

/** "6%" / "3x UR" */
function rateLabelShort(card, category) {
  const cfg = CARD_REWARDS[card];
  const rate = rawRate(card, category);
  return cfg.type === 'cashback' ? `${rate}%` : `${rate}x ${cfg.unit}`;
}

/**
 * Build the bot's rewards line for a logged transaction.
 * Returns '' for non-reward cards (debit/bank/cash) or zero amount.
 *  - best card used → "📊 6% cash back — best card for Grocery ✓"
 *  - suboptimal     → "⚠️ <best card> earns 6% here — saves ~$4.38 on this transaction"
 */
export function buildRewardsLine(card, category, amount, vendor = '') {
  if (!cardEarnsRewards(card) || !(amount > 0)) return '';
  const best = getBestCard(category, vendor);
  if (!best) return '';

  const usedVal = rewardsDollarValue(card, calculateRewards(card, category, amount, 0, vendor));
  const bestVal = rewardsDollarValue(best.card, calculateRewards(best.card, category, amount, 0, vendor));
  const savings = bestVal - usedVal;

  if (savings <= 0.005) {
    return `📊 ${rateLabelFull(card, category)} — best card for ${category} ✓`;
  }
  return `⚠️ ${best.card} earns ${rateLabelShort(best.card, category)} here — saves ~$${savings.toFixed(2)} on this transaction`;
}
