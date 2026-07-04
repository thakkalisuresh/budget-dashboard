/**
 * Receipt line-item → budget-category classifier (deterministic, keyword-based).
 *
 * Used to split a mixed-category receipt (Costco, Amazon, Walmart…) into
 * per-category groups. The keyword layer auto-assigns only the categories we're
 * confident about (groceries, household, health). Anything it can't place — most
 * notably clothing and electronics, which are genuinely ambiguous — is returned
 * as "uncategorized" so the user picks the category. The AI's per-item
 * `item_category` hint (when present) is surfaced as a non-binding suggestion to
 * pre-select the picker, but never auto-assigns on its own.
 *
 * ⚠️  MIRROR: this file is duplicated at functions/lib/_item-categorizer.mjs for
 * the Telegram + wallet paths (the frontend can't import from the functions
 * package). Keep the two byte-identical except for the export style.
 */

// Confident keyword → category map. First matching rule wins (order matters:
// put more specific rules before broad ones). Keywords match as case-insensitive
// substrings of the item name.
const KEYWORD_RULES = [
  {
    category: 'Health',
    keywords: [
      'vitamin', 'supplement', 'protein', 'medicine', 'advil', 'tylenol', 'ibuprofen',
      'bandage', 'band-aid', 'first aid', 'pharmacy', 'prescription', 'cough', 'cold',
      'allergy', 'probiotic', 'fish oil', 'melatonin', 'multivitamin', 'sunscreen',
    ],
  },
  {
    category: 'Grocery',
    keywords: [
      // produce
      'tomato', 'onion', 'potato', 'banana', 'apple', 'orange', 'lettuce', 'spinach',
      'carrot', 'broccoli', 'pepper', 'cucumber', 'avocado', 'garlic', 'ginger', 'lemon',
      'lime', 'grape', 'berry', 'strawberr', 'mango', 'produce', 'vegetable', 'veggie', 'fruit',
      // proteins
      'chicken', 'beef', 'pork', 'turkey', 'fish', 'salmon', 'shrimp', 'seafood', 'meat',
      'egg', 'tofu', 'bacon', 'sausage',
      // dairy & staples
      'milk', 'cheese', 'yogurt', 'butter', 'cream', 'dairy', 'bread', 'bagel', 'tortilla',
      'rice', 'pasta', 'flour', 'sugar', 'cereal', 'oats', 'oatmeal', 'beans', 'lentil',
      // pantry / general food
      'organic', 'snack', 'chips', 'cracker', 'cookie', 'coffee', 'tea', 'juice', 'water',
      'soda', 'sauce', 'oil', 'spice', 'salt', 'pepper', 'honey', 'jam', 'peanut butter',
      'frozen', 'pizza', 'ice cream', 'chocolate', 'candy',
    ],
  },
  {
    // Household / consumables → Misc (the app's catch-all for non-food household)
    category: 'Misc',
    keywords: [
      'trash bag', 'paper towel', 'toilet paper', 'tissue', 'napkin', 'soap', 'detergent',
      'cleaner', 'cleaning', 'lysol', 'clorox', 'bleach', 'ziploc', 'foil', 'plastic wrap',
      'sponge', 'dish soap', 'laundry', 'fabric softener', 'air freshener', 'shampoo',
      'conditioner', 'toothpaste', 'toothbrush', 'deodorant', 'razor', 'diaper', 'wipes',
      'battery', 'batteries', 'light bulb', 'lightbulb',
    ],
  },
];

/**
 * Best-effort category for a single line item, or null if we can't place it
 * confidently (caller should ask the user).
 *   name → keyword scan (confident, auto-assign)
 */
export function categorizeItem(item) {
  const name = String(item?.name || '').toLowerCase();
  if (!name) return null;
  for (const rule of KEYWORD_RULES) {
    if (rule.keywords.some(kw => name.includes(kw))) return rule.category;
  }
  return null;
}

/**
 * Split a list of {name, amount, item_category?} line items into confident
 * category groups plus an uncategorized remainder.
 *
 * @returns {{ autoGrouped: Array<{category, items, subtotal}>,
 *             uncategorized: Array<{name, amount, suggestion}> }}
 */
export function categorizeItems(items = []) {
  const groups = new Map(); // category → { category, items, subtotal }
  const uncategorized = [];

  for (const item of items) {
    if (!item || typeof item.amount !== 'number') continue;
    const category = categorizeItem(item);
    if (category) {
      if (!groups.has(category)) groups.set(category, { category, items: [], subtotal: 0 });
      const g = groups.get(category);
      g.items.push({ name: item.name, amount: item.amount });
      g.subtotal = Math.round((g.subtotal + item.amount) * 100) / 100;
    } else {
      // Non-binding suggestion to pre-select the picker (AI hint if it gave one).
      const suggestion = typeof item.item_category === 'string' && item.item_category
        ? item.item_category
        : null;
      uncategorized.push({ name: item.name, amount: item.amount, suggestion });
    }
  }

  return { autoGrouped: [...groups.values()], uncategorized };
}

/**
 * Does this vendor match one of the user's configured split-receipt vendors?
 * Reuses the {name, patterns[]} shape shared with disabledWalletVendors.
 */
export function matchesSplitVendor(vendor, splitVendors = []) {
  if (!vendor) return false;
  const v = vendor.toLowerCase();
  return splitVendors.some(sv =>
    (sv.patterns || []).some(p => p && v.includes(String(p).toLowerCase()))
  );
}

/** Default split vendors (seed). Mirrored in useSettings.js DEFAULT_SETTINGS. */
export const DEFAULT_SPLIT_VENDORS = [
  { name: 'Costco', patterns: ['costco'] },
  { name: 'Amazon', patterns: ['amazon', 'amzn'] },
];
