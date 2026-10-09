// ════════════════════════════════════════════════════════════════════════════
// investMf.js — pure helpers for Indian mutual-fund (account type `mf_in`)
// tracking. Cash flow: USD DEPOSIT (Wise/Remitly mirror) → INR_RECEIVED (true
// FX, links back via note "settles:<depositUuid>") → BUY per SIP (INR, symbol =
// SipPlan id, fxToUsd = pool average at confirm time). No network, no React.
// ════════════════════════════════════════════════════════════════════════════

export const SETTLES_NOTE_PREFIX = 'settles:';

/** Note that links an INR_RECEIVED row back to the USD deposit it settles. */
export function settlesNote(depositUuid) {
  return `${SETTLES_NOTE_PREFIX}${depositUuid}`;
}

/** Deposit uuid an INR_RECEIVED note references, or ''. */
export function settlesTargetUuid(note) {
  const m = /settles:(\S+)/.exec(String(note || ''));
  return m ? m[1] : '';
}

const ORDER = { INR_RECEIVED: 0 }; // same-day receipts land before debits

function chronological(activities, accountId) {
  return (activities || [])
    .filter(a => a.accountId === accountId)
    .map((a, i) => ({ a, i }))
    .sort((x, y) =>
      String(x.a.date).localeCompare(String(y.a.date))
      || (ORDER[x.a.type] ?? 1) - (ORDER[y.a.type] ?? 1)
      || x.i - y.i)
    .map(x => x.a);
}

/**
 * Average-cost INR pool for an mf_in account: INR received but not yet spent.
 * Returns { inr, usd, fx } — fx is the weighted-average USD per INR, null when
 * the pool is empty. BUY/FEE draw down at the running average.
 */
export function inrPool(activities, accountId) {
  let inr = 0, usd = 0;
  for (const a of chronological(activities, accountId)) {
    const amt = Number(a.amount) || 0;
    if (a.type === 'INR_RECEIVED') {
      inr += amt;
      usd += amt * (Number(a.fxToUsd) || 0);
    } else if ((a.type === 'BUY' || a.type === 'FEE') && inr > 0) {
      const take = Math.min(amt, inr);
      usd -= usd * (take / inr);
      inr -= take;
    }
  }
  if (inr <= 1e-9) return { inr: Math.max(0, inr), usd: 0, fx: null };
  return { inr, usd, fx: usd / inr };
}

/** INR cash sitting in the NRO account: received minus SIP debits and fees. */
export function inrCashBalance(activities, accountId) {
  let bal = 0;
  for (const a of activities || []) {
    if (a.accountId !== accountId) continue;
    const amt = Number(a.amount) || 0;
    if (a.type === 'INR_RECEIVED') bal += amt;
    else if (a.type === 'BUY' || a.type === 'FEE') bal -= amt;
  }
  return bal;
}

/**
 * USD deposits on mf_in accounts that no INR_RECEIVED references yet — the
 * "in transit" money the INR-received nudge is driven off.
 */
export function inTransitDeposits(activities, accounts) {
  const mf = new Set((accounts || []).filter(a => a.type === 'mf_in').map(a => a.id));
  const settled = new Set();
  for (const a of activities || []) {
    if (a.type === 'INR_RECEIVED') {
      const t = settlesTargetUuid(a.note);
      if (t) settled.add(t);
    }
  }
  return (activities || []).filter(a =>
    a.type === 'DEPOSIT' && a.uuid && mf.has(a.accountId)
    && (!a.currency || a.currency === 'USD') && !settled.has(a.uuid));
}

/**
 * USD cost basis of one fund (average-cost): BUYs add amount×fxToUsd, SELLs
 * remove the proportional share of the remaining cost. `symbol` is the SipPlan
 * id, compared case-insensitively (activityRow upper-cases stored symbols).
 */
export function mfUsdCostBasis(activities, symbol) {
  const sym = String(symbol || '').toUpperCase();
  let qty = 0, usd = 0;
  const rows = (activities || [])
    .filter(a => String(a.symbol || '').toUpperCase() === sym && (a.type === 'BUY' || a.type === 'SELL'))
    .sort((x, y) => String(x.date).localeCompare(String(y.date)));
  for (const a of rows) {
    const q = Number(a.qty) || 0;
    if (a.type === 'BUY') {
      qty += q;
      usd += (Number(a.amount) || 0) * (Number(a.fxToUsd) || 0);
    } else if (qty > 0) {
      const frac = Math.min(1, q / qty);
      usd -= usd * frac;
      qty -= Math.min(q, qty);
    }
  }
  return Math.max(0, usd);
}
