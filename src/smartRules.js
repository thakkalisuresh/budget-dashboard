// ════════════════════════════════════════════════════════════════════════════
// smartRules.js — the "Smart Rules" matching engine.
// Smart Rules let the user say "anything from vendor X should be category Y"
// (and similarly, which card to use). This file is PURE LOGIC — given a vendor
// and the user's rules, it decides the best match. No UI and no network here,
// which makes it simple to reason about and easy to unit-test.
//
// A rule looks like: { id, pattern, category }
// When several rules match at once, the MOST SPECIFIC one (longest pattern) wins.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Given a vendor name and the list of rules, return the matching category,
 * or null if nothing matches.
 */
export function applySmartRules(vendor, rules) {
  // Nothing to match against → no result. `rules?.length` uses optional chaining
  // so it won't crash if `rules` is null/undefined.
  if (!vendor || !rules?.length) return null;
  const v = vendor.toLowerCase().trim();     // normalize so matching ignores case/spacing
  // Keep every rule whose pattern appears somewhere inside the vendor name.
  const matches = rules.filter(r =>
    r.pattern?.trim() && v.includes(r.pattern.toLowerCase().trim())
  );
  if (matches.length === 0) return null;
  // Most specific wins: sort by pattern length, longest first...
  matches.sort((a, b) => b.pattern.length - a.pattern.length);
  return matches[0].category;                // ...then return the winner's category
}

/**
 * Same idea, but for choosing a CARD. Category-specific rules beat vendor-only
 * rules; among equally specific rules, the longer pattern wins.
 */
export function applyCardRules(vendor, category, rules) {
  if (!vendor || !rules?.length) return null;
  const v = vendor.toLowerCase().trim();
  const matches = rules.filter(r => {
    if (!r.vendorPattern?.trim()) return false;                  // rule must have a pattern
    if (!v.includes(r.vendorPattern.toLowerCase().trim())) return false; // pattern must appear in vendor
    if (r.category && r.category !== category) return false;     // category-locked rule must match category
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    // First tiebreaker: a rule tied to a category (spec = 1) outranks a
    // vendor-only rule (spec = 0).
    const aSpec = a.category ? 1 : 0;
    const bSpec = b.category ? 1 : 0;
    if (bSpec !== aSpec) return bSpec - aSpec;
    // Second tiebreaker: the longer vendor pattern is considered more specific.
    return b.vendorPattern.length - a.vendorPattern.length;
  });
  return matches[0].card;
}

/** Make a reasonably-unique id for a new rule: "rule-<timestamp>-<random>". */
export function newRuleId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
