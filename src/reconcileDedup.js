/**
 * Phase 2 — Deduplication
 * Takes parsed bank transactions and classifies each one by comparing
 * against what's already logged in the month's detail sheets.
 *
 * Status values:
 *   'new'           — not in sheets, ready to import
 *   'already_logged'— exact (fuzzy) match found in sheets, skip
 *   'credit'        — refund/return from bank, user decides whether to apply
 *   'transfer'      — internal transfer/payment, user decides whether to treat as expense
 *   'cross_month'   — transaction date falls outside selected month, user decides
 */

import { fetchAllLoggedTransactions, getAllCategoryNames, fuzzyNamesMatch } from './sheetsApi.js';
import { applySmartRules } from './smartRules.js';

// ── Category guesser ──────────────────────────────────────────────────────────

const CATEGORY_RULES = [
  { patterns: [/walmart/i, /costco/i, /wholefds/i, /whole foods/i, /trader joe/i, /safeway/i, /kroger/i, /aldi/i, /publix/i, /\bh-?e-?b\b/i, /sprouts/i, /ralphs/i, /vons/i, /food.*max/i], category: 'Grocery' },
  { patterns: [/netflix/i, /spotify/i, /hulu/i, /disney\+?/i, /\bamc\b/i, /youtube.*premium/i, /apple\.com\/bill/i, /xbox/i, /playstation/i, /twitch/i, /peacock/i, /hbo/i, /paramount/i, /apple.*music/i], category: 'Entertainment' },
  { patterns: [/delta/i, /united air/i, /american air/i, /southwest/i, /alaska air/i, /jetblue/i, /airbnb/i, /marriott/i, /hilton/i, /hyatt/i, /expedia/i, /kayak/i, /booking\.com/i, /vrbo/i, /priceline/i], category: 'Travel' },
  { patterns: [/chevron/i, /\bshell\b/i, /exxon/i, /arco/i, /\bbp\b/i, /valero/i, /mobil/i, /sunoco/i, /76 station/i, /circle.?k/i, /speedway/i], category: 'Car Payments' },
  { patterns: [/\bpg&e\b/i, /\bat&t\b/i, /verizon/i, /comcast/i, /xfinity/i, /t-mobile/i, /spectrum/i, /cox comm/i, /frontier comm/i, /internet/i, /electric/i, /water.*utility/i, /utility/i], category: 'Utilities' },
  { patterns: [/mcdonald/i, /starbucks/i, /chipotle/i, /domino/i, /pizza/i, /sushi/i, /wingstop/i, /chick.?fil/i, /taco bell/i, /wendy/i, /burger king/i, /subway\s/i, /panera/i, /olive garden/i, /cheesecake/i, /doordash/i, /grubhub/i, /ubereats/i, /postmates/i], category: 'Eating Out' },
  { patterns: [/robinhood/i, /fidelity/i, /schwab/i, /vanguard/i, /e\*?trade/i, /coinbase/i, /tdameritrade/i, /acorns/i, /wealthfront/i, /betterment/i], category: 'Investment' },
  { patterns: [/cvs\b/i, /walgreens/i, /rite aid/i, /hospital/i, /\bmedical\b/i, /dental/i, /pharmacy/i, /\bdoctor\b/i, /clinic/i, /urgent care/i, /labcorp/i, /quest diag/i, /optum/i], category: 'Health' },
  { patterns: [/thakkali/i], category: 'Thakkali' },
];

export function guessCategory(vendor) {
  const v = (vendor || '').toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.some(p => p.test(v))) return rule.category;
  }
  return 'Misc';
}

// ── Month range check ─────────────────────────────────────────────────────────

export function isInMonth(dateStr, monthName) {
  if (!dateStr || !monthName) return true;
  try {
    const [year, month] = dateStr.split('-').map(Number);
    const ref = new Date(`${monthName} 1`);
    return year === ref.getFullYear() && month === ref.getMonth() + 1;
  } catch { return true; }
}

// ── Net-zero pair detection ───────────────────────────────────────────────────
// Finds credits that cancel a new purchase in the same statement (no dashboard
// match on either side). These are flagged so the user can skip both at once.

function detectNetZeroPairs(annotated) {
  const newTxs    = annotated.filter(t => t.status === 'new');
  const creditTxs = annotated.filter(t => t.status === 'credit' && !t.matchedVendor);

  const pairedNewIds    = new Set();
  const pairedCreditIds = new Set();

  for (const credit of creditTxs) {
    const match = newTxs.find(n =>
      !pairedNewIds.has(n.id) &&
      Math.abs(n.amount - credit.amount) < 0.05 &&
      fuzzyNamesMatch(n.vendor, credit.vendor)
    );
    if (match) {
      pairedNewIds.add(match.id);
      pairedCreditIds.add(credit.id);
    }
  }

  if (pairedNewIds.size === 0) return annotated;

  return annotated.map(tx => {
    if (pairedNewIds.has(tx.id))    return { ...tx, netZeroPair: true, netZeroDefault: 'skip' };
    if (pairedCreditIds.has(tx.id)) return { ...tx, netZeroPair: true, netZeroDefault: 'skip' };
    return tx;
  });
}

// ── Main deduplication ────────────────────────────────────────────────────────

export function reconcileFingerprint(vendor, amount) {
  return `${(vendor || '').toLowerCase().trim()}_${Number(amount).toFixed(2)}`;
}

export async function runDeduplication(transactions, sheetId, accessToken, monthName, smartRules = [], reconciledFingerprints = []) {
  const reconciledSet = new Set(reconciledFingerprints);
  const categories = getAllCategoryNames();
  const logged = await fetchAllLoggedTransactions(categories, accessToken, sheetId);

  // Track which logged entries have been matched to avoid double-matching
  const usedLoggedIndices = new Set();

  const annotated = transactions.map(tx => {
    // 0. Previously reconciled — skip immediately
    if (reconciledSet.has(reconcileFingerprint(tx.vendor, tx.amount))) {
      return { ...tx, status: 'already_logged', matchedCategory: 'reconciled', matchedVendor: tx.vendor };
    }

    // 1. Transfers
    if (tx.type === 'transfer') {
      return { ...tx, status: 'transfer', suggestedCategory: 'Misc' };
    }

    // 2. Credits / refunds
    if (tx.type === 'credit') {
      const matchIdx = logged.findIndex((l, i) =>
        !usedLoggedIndices.has(i) &&
        Math.abs(l.amount - tx.amount) < 0.05 &&
        fuzzyNamesMatch(l.vendor, tx.vendor)
      );
      if (matchIdx >= 0) {
        return {
          ...tx, status: 'credit',
          matchedVendor:   logged[matchIdx].vendor,
          matchedCategory: logged[matchIdx].category,
        };
      }
      return { ...tx, status: 'credit', matchedVendor: null, matchedCategory: null };
    }

    // 3. Cross-month
    if (!isInMonth(tx.date, monthName)) {
      return { ...tx, status: 'cross_month', suggestedCategory: guessCategory(tx.vendor) };
    }

    // 4. Already logged
    const matchIdx = logged.findIndex((l, i) =>
      !usedLoggedIndices.has(i) &&
      Math.abs(l.amount - tx.amount) < 0.05 &&
      fuzzyNamesMatch(l.vendor, tx.vendor)
    );
    if (matchIdx >= 0) {
      usedLoggedIndices.add(matchIdx);
      return {
        ...tx, status: 'already_logged',
        matchedCategory: logged[matchIdx].category,
        matchedVendor:   logged[matchIdx].vendor,
      };
    }

    // 5. New — smart rules first, keyword guesser as fallback
    const ruleCategory = applySmartRules(tx.vendor, smartRules);
    return { ...tx, status: 'new', suggestedCategory: ruleCategory || guessCategory(tx.vendor) };
  });

  return detectNetZeroPairs(annotated);
}
