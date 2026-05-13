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

/** Generate a simple unique ID for a new rule */
export function newRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
