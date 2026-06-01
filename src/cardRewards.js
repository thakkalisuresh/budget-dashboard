/**
 * Card rewards engine — pre-seeded rates for the household's cards.
 *
 * Two reward types, tracked SEPARATELY (never summed together):
 *   - 'cashback' → value is a dollar amount (rate is a % of spend)
 *   - 'points'   → value is a point count (rate is a multiplier ×spend in $)
 *
 * Point → dollar valuation (for comparison + estimated-value display only):
 *   - Chase UR via Sapphire Reserve travel portal ≈ 1.5¢/pt
 *   - Freedom Unlimited UR ≈ 1.0¢/pt base (1.5¢ if pooled with CSR)
 * These are display assumptions, not tracked cash.
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
// (Whole Foods is ambiguous — it often codes under Amazon — so left out.)
const AMEX_GROCERY_EXCLUDED = ['costco', 'walmart', 'target', 'samsclub', 'bjs'];

export function isAmexGroceryExcluded(vendor) {
  if (!vendor) return false;
  const v = String(vendor).toLowerCase().replace(/[^a-z0-9]/g, '');
  return AMEX_GROCERY_EXCLUDED.some(x => v.includes(x));
}

// Cards with no rewards program (debit, bank, cash)
export function cardEarnsRewards(card) {
  return !!CARD_REWARDS[card];
}

/** Raw rate for a card+category (percent for cashback, multiplier for points). */
function rawRate(card, category) {
  const cfg = CARD_REWARDS[card];
  if (!cfg) return 0;
  const cat = cfg.categories[category];
  if (cat == null) return cfg.default;
  return typeof cat === 'object' ? cat.rate : cat;
}

/**
 * Calculate rewards earned on a single transaction.
 * @param ytdCategorySpend - year-to-date spend on THIS card+category (for caps)
 * @returns { type, value, unit, rate } — value is $ (cashback) or points (points)
 */
export function calculateRewards(card, category, amount, ytdCategorySpend = 0, vendor = '') {
  const cfg = CARD_REWARDS[card];
  if (!cfg || !(amount > 0)) return { type: 'none', value: 0, unit: '', rate: 0 };

  // Amex groceries at warehouse clubs / superstores earn the 1% base, not 6%
  if (card === 'American Express Blue Cash Preferred' && category === 'Grocery' && isAmexGroceryExcluded(vendor)) {
    return { type: 'cashback', value: amount * cfg.default / 100, unit: '$', rate: cfg.default };
  }

  const catCfg = cfg.categories[category];
  let rate = rawRate(card, category);

  // Capped categories (e.g. Amex 6% groceries up to $6k/yr, then 1%)
  if (catCfg && typeof catCfg === 'object' && catCfg.cap) {
    const { annual, then } = catCfg.cap;
    const remaining = Math.max(0, annual - ytdCategorySpend);
    const atRate    = Math.min(amount, remaining);
    const overRate  = amount - atRate;
    if (cfg.type === 'cashback') {
      const value = (atRate * catCfg.rate / 100) + (overRate * then / 100);
      return { type: 'cashback', value, unit: '$', rate: catCfg.rate };
    }
  }

  if (cfg.type === 'cashback') {
    return { type: 'cashback', value: amount * rate / 100, unit: '$', rate };
  }
  // points: rate is multiplier
  return { type: 'points', value: amount * rate, unit: cfg.unit, rate };
}

/** Estimated dollar value of a rewards result (points × pointValue, or cash as-is). */
export function rewardsDollarValue(card, rewards) {
  if (!rewards || rewards.type === 'none') return 0;
  if (rewards.type === 'cashback') return rewards.value;
  const cfg = CARD_REWARDS[card];
  return rewards.value * (cfg?.pointValue || 0.01);
}

/**
 * Best card for a category by estimated dollar return per $1 spent.
 * Pass `vendor` to make it merchant-aware (e.g. Amex loses its grocery bonus at Costco).
 * Ignores caps (caps are a ceiling, not a per-$ rate change at the margin).
 * @returns { card, rate, type, unit, perDollar } or null
 */
export function getBestCard(category, vendor = '') {
  let best = null;
  for (const card of Object.keys(CARD_REWARDS)) {
    const r = calculateRewards(card, category, 1, 0, vendor);
    const perDollar = rewardsDollarValue(card, r); // $ returned per $1 spent
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
export function bestCardTable(categories) {
  return categories.map(category => {
    const best = getBestCard(category);
    const label = best
      ? (best.type === 'cashback' ? `${best.rate}% cash back` : `${best.rate}x ${best.unit}`)
      : '—';
    return { category, card: best?.card || '—', label };
  });
}
