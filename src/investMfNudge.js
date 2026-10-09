// ════════════════════════════════════════════════════════════════════════════
// investMfNudge.js — pure logic behind the Indian-MF nudges on the Invest tab:
// "INR received" prompts for in-transit USD deposits, pending SIP confirmations
// (one per active plan per unsatisfied month), the monthly transfer planner and
// the low-cash check. No network, no React — data in, data out.
// ════════════════════════════════════════════════════════════════════════════
import { inTransitDeposits, inrCashBalance, inrPool, settlesNote } from './investMf.js';

export const MF_ACCOUNT_ID = 'nro-mf';
export const DEFAULT_BUFFER_PCT = 2;
export const FX_WARN_PCT = 5; // implied vs live; catches typos (2,000 vs 20,000), not real spreads

const num = (v) => Number(v);
const ym = (iso) => String(iso || '').slice(0, 7);

/** Key under which a skipped plan-month is stored in settings.mfSipSkipped. */
export function sipKey(planId, month) {
  return `${planId}:${month}`;
}

/** Implied FX from a transfer: { usdPerInr, inrPerUsd }, or null on bad input. */
export function impliedFx(usd, inr) {
  const u = num(usd), i = num(inr);
  if (!(u > 0) || !(i > 0)) return null;
  return { usdPerInr: u / i, inrPerUsd: i / u };
}

/** Absolute % the implied INR-per-USD sits off the live rate; null if either is unusable. */
export function fxDeviationPct(inrPerUsd, liveInrPerUsd) {
  const a = num(inrPerUsd), b = num(liveInrPerUsd);
  if (!(a > 0) || !(b > 0)) return null;
  return Math.abs(a - b) / b * 100;
}

/** Unsettled, undismissed mf_in USD deposits, shaped for the nudge card. */
export function pendingInrReceipts(activities = [], accounts = [], dismissedUuids = []) {
  const names = new Map(accounts.map(a => [a.id, a.name]));
  const dismissed = new Set(dismissedUuids || []);
  return inTransitDeposits(activities, accounts)
    .filter(d => !dismissed.has(d.uuid))
    .map(d => ({
      uuid: d.uuid,
      accountId: d.accountId,
      accountName: names.get(d.accountId) || d.accountId,
      amount: Number(d.amount) || 0,
      date: d.date || '',
    }));
}

function nextMonth(m) {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
}

function dueDate(month, day) {
  const d = Number(day);
  if (!(d > 0)) return `${month}-01`;
  const [y, mo] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${month}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * SIP debits awaiting confirmation. Gated on the first INR_RECEIVED on the
 * plan's account (money must arrive before a SIP can debit); then every month
 * from that one through `today`'s is checked per active plan: satisfied by any
 * BUY with a matching (case-insensitive) symbol dated in the month, hidden if
 * skipped, and — when `day` is set — due only on/after that day.
 * Returns oldest month first, plan order within a month.
 */
export function pendingSips(plans = [], activities = [], { today, skipped = [] } = {}) {
  const todayIso = today || new Date().toISOString().slice(0, 10);
  const skip = new Set(skipped || []);
  const out = [];
  for (const p of plans) {
    if (!p?.active) continue;
    const firstRcv = (activities || [])
      .filter(a => a.type === 'INR_RECEIVED' && a.accountId === p.accountId && a.date)
      .map(a => String(a.date)).sort()[0];
    if (!firstRcv) continue;
    const id = String(p.id).toUpperCase();
    const bought = new Set((activities || [])
      .filter(a => a.type === 'BUY' && a.accountId === p.accountId && String(a.symbol || '').toUpperCase() === id)
      .map(a => ym(a.date)));
    for (let m = ym(firstRcv); m <= ym(todayIso); m = nextMonth(m)) {
      const due = dueDate(m, p.day);
      if (todayIso < due || bought.has(m) || skip.has(sipKey(p.id, m))) continue;
      out.push({
        planId: p.id, name: p.name, amountInr: Number(p.amountInr) || 0, month: m, dueDate: due,
        schemeCode: p.schemeCode, mapped: !!p.schemeCode && p.schemeCode !== 'unmapped', accountId: p.accountId,
      });
    }
  }
  const order = new Map(plans.map((p, i) => [p.id, i]));
  return out.sort((a, b) => a.month.localeCompare(b.month) || order.get(a.planId) - order.get(b.planId));
}

const activeTotal = (plans) =>
  (plans || []).filter(p => p?.active).reduce((s, p) => s + (Number(p.amountInr) || 0), 0);

/**
 * This month's transfer target and the USD to send at the live rate.
 * usdLow = target ÷ rate; usdHigh adds the buffer. Rate unknown → USD fields null.
 * `cashInr` already sitting in the NRO account is reported with the USD it saves.
 */
export function planTransfer({ plans = [], liveInrPerUsd, bufferPct = DEFAULT_BUFFER_PCT, cashInr = 0 } = {}) {
  const targetInr = activeTotal(plans);
  const cash = Math.max(0, Number(cashInr) || 0);
  const rate = num(liveInrPerUsd);
  if (!(rate > 0)) return { targetInr, usdLow: null, usdHigh: null, cashInr: cash, usdSaved: null };
  const usdLow = targetInr / rate;
  const usdHigh = usdLow * (1 + (Number(bufferPct) || 0) / 100);
  return { targetInr, usdLow, usdHigh, cashInr: cash, usdSaved: Math.min(cash, targetInr) / rate };
}

/**
 * Warns when INR cash in the NRO account won't cover the next SIP round.
 * Suppressed until something has actually been sent (an INR_RECEIVED row or an
 * in-transit deposit exists).
 */
export function cashLowCheck(activities = [], plans = [], accountId = MF_ACCOUNT_ID) {
  const needInr = activeTotal(plans.filter(p => p.accountId === accountId));
  const cashInr = inrCashBalance(activities, accountId);
  const started = activities.some(a => a.accountId === accountId
    && (a.type === 'INR_RECEIVED' || (a.type === 'DEPOSIT' && (!a.currency || a.currency === 'USD'))));
  const shortfallInr = Math.max(0, needInr - cashInr);
  return { low: started && needInr > 0 && cashInr < needInr, cashInr, needInr, shortfallInr };
}

/** Default units for a SIP debit: amount ÷ NAV, 3 decimals; null on a bad NAV. */
export function sipUnits(amountInr, nav) {
  const a = num(amountInr), n = num(nav);
  if (!(a > 0) || !(n > 0)) return null;
  return Math.round((a / n) * 1000) / 1000;
}

/** The INR_RECEIVED activity that settles one in-transit USD deposit (fx = USD sent ÷ INR received). */
export function buildInrReceived({ deposit, inrReceived, date }) {
  const inr = num(inrReceived);
  return {
    date,
    accountId: deposit.accountId,
    type: 'INR_RECEIVED',
    currency: 'INR',
    amount: inr,
    fxToUsd: num(deposit.amount) / inr,
    note: settlesNote(deposit.uuid),
  };
}

/**
 * The BUY for a confirmed SIP debit. fxToUsd is the average-cost INR pool rate
 * as of now — callers must build this BEFORE appending the BUY. An empty pool
 * leaves fx blank (never guessed).
 */
export function buildSipBuy({ plan, date, nav, units, amount, activities }) {
  const pool = inrPool(activities, plan.accountId);
  return {
    date,
    accountId: plan.accountId,
    type: 'BUY',
    currency: 'INR',
    symbol: plan.id,
    qty: num(units),
    price: num(nav),
    amount: amount != null ? num(amount) : num(plan.amountInr),
    fxToUsd: pool.fx ?? '',
  };
}
