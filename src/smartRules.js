/**
 * Smart Rules matching engine.
 * Rules shape: { id, pattern, category }
 * Most specific (longest pattern) wins when multiple rules match.
 */

/**
 * Given a vendor name and a list of rules, returns the matching category
 * or null if no rule matches.
 */
export function applySmartRules(vendor, rules) {
  if (!vendor || !rules?.length) return null;
  const v = vendor.toLowerCase().trim();
  const matches = rules.filter(r =>
    r.pattern?.trim() && v.includes(r.pattern.toLowerCase().trim())
  );
  if (matches.length === 0) return null;
  // Most specific wins — longest pattern length
  matches.sort((a, b) => b.pattern.length - a.pattern.length);
  return matches[0].category;
}

/**
 * Given a vendor name, category, and card rules, returns the matching card name
 * or null if no rule matches. Category-specific rules beat vendor-only rules;
 * longer patterns beat shorter ones within the same specificity.
 */
export function applyCardRules(vendor, category, rules) {
  if (!vendor || !rules?.length) return null;
  const v = vendor.toLowerCase().trim();
  const matches = rules.filter(r => {
    if (!r.vendorPattern?.trim()) return false;
    if (!v.includes(r.vendorPattern.toLowerCase().trim())) return false;
    if (r.category && r.category !== category) return false;
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const aSpec = a.category ? 1 : 0;
    const bSpec = b.category ? 1 : 0;
    if (bSpec !== aSpec) return bSpec - aSpec;
    return b.vendorPattern.length - a.vendorPattern.length;
  });
  return matches[0].card;
}

/** Generate a simple unique ID for a new rule */
export function newRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
