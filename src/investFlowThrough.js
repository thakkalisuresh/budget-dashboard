// ════════════════════════════════════════════════════════════════════════════
// investFlowThrough.js — contribution flow-through. When an expense lands in
// the Investment budget category, mirror it into the Investments sheet as a
// DEPOSIT (and bump the HYSA balance so the FDIC gauges move immediately).
// Vendor → account resolution uses settings.investAccountRules with the same
// "vendor contains pattern" semantics as smart rules. Always non-fatal: a
// mirror failure never blocks the expense that triggered it.
// ════════════════════════════════════════════════════════════════════════════
import { appendActivity, updateAccount, fetchAccounts } from './sheetInvest.js';
import { investCache } from './useInvestData.js';

export function matchInvestAccount(vendor, rules = []) {
  const v = String(vendor || '').toLowerCase();
  if (!v) return null;
  const matches = rules.filter(r => r.pattern?.trim() && v.includes(r.pattern.toLowerCase().trim()));
  if (!matches.length) return null;
  matches.sort((a, b) => b.pattern.length - a.pattern.length); // most specific wins
  return matches[0].accountId;
}

/**
 * Mirror one Investment-category expense into the Investments sheet.
 * Returns { mirrored, accountId } — callers may surface a small toast, or ignore.
 */
export async function mirrorInvestContribution({ settings, accessToken, vendor, amount, txDate }) {
  try {
    const sheetId = settings?.investSheetId;
    if (!sheetId || !(amount > 0)) return { mirrored: false };
    const accountId = matchInvestAccount(vendor, settings.investAccountRules || []);
    if (!accountId) return { mirrored: false };

    await appendActivity(sheetId, accessToken, {
      date: txDate || undefined,
      accountId,
      type: 'DEPOSIT',
      amount,
      note: `Auto from Investment expense: ${String(vendor).slice(0, 60)}`,
    });

    // HYSA deposits also raise the balance anchor so gauges track without a
    // manual update. (A later manual balance entry simply overwrites this.)
    const accounts = await fetchAccounts(sheetId, accessToken);
    const acct = accounts.find(a => a.id === accountId);
    if (acct?.type === 'hysa') {
      await updateAccount(sheetId, accessToken, accountId, { balance: acct.balance + amount });
    }

    // Invalidate caches so the Invest tab reflects the mirror on next open.
    investCache.delete(sheetId);
    try { localStorage.removeItem(`budget_invest_cache_${sheetId}`); } catch { /* ignore */ }

    return { mirrored: true, accountId };
  } catch (e) {
    console.warn('invest flow-through failed (non-fatal):', e?.message);
    return { mirrored: false };
  }
}
