// ════════════════════════════════════════════════════════════════════════════
// splitPlans.js — spread one fixed charge across several months.
//
// A split plan takes a total (e.g. a 6-month insurance premium paid in one go)
// and divides it into N installments, one per month, each row labelled
// "Vendor n/N". It is the bounded cousin of recurringExpenses: where a recurring
// template repeats the full amount every month forever, a plan divides a fixed
// total and stops after N installments.
//
// Plans live in settings.splitPlans — the central UserSettings store, not any
// month sheet — so the installments still owed exist before their months do.
// They are replayed the same way recurring expenses are: when a New Month is
// created, and on demand into an already-open month. `placed` records which
// installment numbers are already written, so replaying a month twice can't
// write the same installment again.
//
// Money is handled in integer cents so the N rows always sum to exactly the
// total; any rounding remainder lands on the LAST installment.
// ════════════════════════════════════════════════════════════════════════════

let _seq = 0;
function makeId() {
  return `sp_${Date.now().toString(36)}_${(_seq++).toString(36)}`;
}

/**
 * Divide `total` into `n` installments (2-dp) that sum to exactly `total`.
 * The remainder from integer division lands on the last installment, so it is
 * the one that absorbs the odd cent (e.g. 1000/3 → 333.33, 333.33, 333.34).
 * Returns [] for a non-positive total or an N below 1.
 */
export function computeInstallments(total, n) {
  const count = Math.floor(Number(n));
  const cents = Math.round(Number(total) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || !Number.isFinite(count) || count < 1) return [];
  const base = Math.floor(cents / count);
  const out = Array(count).fill(base);
  out[count - 1] += cents - base * count;
  return out.map(c => c / 100);
}

/** The vendor string a given installment row is written under: "Vendor n/N". */
export function installmentLabel(vendor, k, n) {
  return `${(vendor || '').trim()} ${k}/${n}`;
}

/**
 * Build a plan from a form's worth of fields. `card` and `startMonth` are
 * omitted when unset rather than stored blank, matching recurringExpenses.
 */
export function makeSplitPlan({ category, vendor, totalAmount, installments, card, startMonth }) {
  return {
    id: makeId(),
    category,
    vendor: (vendor || '').trim(),
    totalAmount: Number(totalAmount) || 0,
    installments: Math.floor(Number(installments)) || 0,
    ...(card ? { card } : {}),
    ...(startMonth ? { startMonth } : {}),
    placed: [],
  };
}

/** The smallest installment number (1-based) not yet placed, or null if done. */
export function nextInstallmentNumber(plan) {
  if (!plan || !(plan.installments >= 1)) return null;
  const placed = new Set(plan.placed || []);
  for (let k = 1; k <= plan.installments; k++) {
    if (!placed.has(k)) return k;
  }
  return null;
}

/** Has every installment been written? */
export function isPlanComplete(plan) {
  return nextInstallmentNumber(plan) === null;
}

/**
 * What the next month should receive from this plan: the installment number,
 * the "Vendor n/N" label, and the amount for that installment. null when the
 * plan is already complete.
 */
export function nextDueInstallment(plan) {
  const k = nextInstallmentNumber(plan);
  if (k === null) return null;
  const amounts = computeInstallments(plan.totalAmount, plan.installments);
  return { number: k, label: installmentLabel(plan.vendor, k, plan.installments), amount: amounts[k - 1] };
}

/** Record installment `k` as placed. Idempotent — placing it twice is a no-op. */
export function markPlaced(plan, k) {
  const placed = new Set(plan.placed || []);
  placed.add(k);
  return { ...plan, placed: [...placed].sort((a, b) => a - b) };
}

/** Add or replace a plan by id. Returns a new array; refuses an invalid plan. */
export function upsertSplitPlan(list, plan) {
  if (!plan?.category || !plan?.vendor || !(plan.installments >= 1)) return list || [];
  return [...(list || []).filter(p => p.id !== plan.id), plan];
}

/** Remove a plan by id. Returns a new array. */
export function removeSplitPlan(list, id) {
  return (list || []).filter(p => p.id !== id);
}

/** Only the plans that still owe at least one installment. */
export function activeSplitPlans(list) {
  return (list || []).filter(p => !isPlanComplete(p));
}
