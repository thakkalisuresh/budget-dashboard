// ════════════════════════════════════════════════════════════════════════════
// investMfView.js — pure view-model for the Indian mutual-fund section of the
// Invest tab. No React, no network. Holdings key on the SipPlan id (the BUY
// symbol), never the scheme code, so re-mapping a plan can't orphan history.
// INR is the native currency; the USD view converts values at the live rate and
// invests at each BUY's stored fxToUsd (see investMf.mfUsdCostBasis).
// ════════════════════════════════════════════════════════════════════════════
import { deriveHoldings, xirr, convert, activityUsd } from './investMath.js';
import { inrCashBalance, mfUsdCostBasis } from './investMf.js';
import { cleanCodes } from './useMfNav.js';

const DAY_MS = 86_400_000;
/** XIRR annualises, so a few weeks of history yields silly numbers — hide it. */
export const MIN_XIRR_DAYS = 30;

const up = (s) => String(s || '').toUpperCase();

/** Valid AMFI codes for the plans on screen (feeds useMfNav; [] ⇒ no fetch). */
export function mappedCodes(plans) {
  return cleanCodes((plans || []).map(p => p.schemeCode));
}

/** Latest NAV record for a plan, or null when unmapped / missing / not positive. */
export function navFor(plan, navs) {
  const rec = navs?.[String(plan?.schemeCode ?? '').trim()];
  return rec && Number(rec.nav) > 0 ? rec : null;
}

export function fmtMfMoney(n, currency = 'INR', digits = 0) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sym = currency === 'USD' ? '$' : '₹';
  const body = Math.abs(v).toLocaleString(currency === 'USD' ? 'en-US' : 'en-IN', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
  return `${v < 0 ? '−' : ''}${sym}${body}`;
}

export const fmtMfPct = (r, digits = 1) =>
  r == null || !Number.isFinite(r) ? '—' : `${r >= 0 ? '+' : '−'}${Math.abs(r * 100).toFixed(digits)}%`;

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** Cash flows (viewing currency) for the given activities; null if any is unconvertible. */
function flowsFor(rows, currency) {
  const out = [];
  for (const a of rows) {
    const sign = a.type === 'BUY' || a.type === 'FEE' ? -1
      : a.type === 'SELL' || a.type === 'DIVIDEND' ? 1 : 0;
    if (!sign) continue;
    const amt = currency === 'USD' ? activityUsd(a) : (Number(a.amount) || 0);
    if (amt == null) return null;
    if (amt) out.push({ date: a.date, amount: sign * amt });
  }
  return out;
}

function xirrWith(flows, terminalValue, today) {
  if (!flows || !(terminalValue > 0) || !flows.length) return null;
  const first = Math.min(...flows.map(f => Date.parse(f.date)));
  if (!Number.isFinite(first) || (Date.parse(today) - first) / DAY_MS < MIN_XIRR_DAYS) return null;
  return xirr([...flows, { date: today, amount: terminalValue }]);
}

/**
 * Build the whole MF section.
 * @param plans       SipPlans rows ({ id, schemeCode, mapped, name, amc, active, amountInr })
 * @param activities  activities of the MF account(s) (extra accounts are filtered out here too)
 * @param accountIds  ids of the `mf_in` accounts
 * @param navs        useMfNav().navs  (schemeCode → { nav, date })
 * @param fx          useMfNav().fx    ({ rate } INR per 1 USD)
 * @param currency    'INR' | 'USD' display currency
 */
export function buildMfView({ plans = [], activities = [], accountIds = [], navs = {}, fx = null, currency = 'INR', today = new Date().toISOString().slice(0, 10) }) {
  const ids = new Set(accountIds);
  const acts = activities.filter(a => ids.has(a.accountId));
  const usd = currency === 'USD';
  const inrPerUsd = Number(fx?.rate) > 0 ? Number(fx.rate) : null;
  const usdPerInr = inrPerUsd ? 1 / inrPerUsd : null;
  const rateMissing = usd && !usdPerInr;

  const holdings = new Map(deriveHoldings(acts).map(h => [h.symbol, h]));
  const planById = new Map(plans.map(p => [up(p.id), p]));
  const rows = [
    ...plans.filter(p => p.active !== false || holdings.has(up(p.id))),
    // History whose plan row is gone still shows up rather than vanishing.
    ...[...holdings.keys()].filter(s => !planById.has(s)).map(s => ({ id: s, schemeCode: 'unmapped', mapped: false, name: s, amc: 'Other' })),
  ];

  const funds = rows.map(plan => {
    const key = up(plan.id);
    const h = holdings.get(key);
    const mine = acts.filter(a => up(a.symbol) === key);
    const units = h?.qty || 0;
    const investedInr = h?.costBasis || 0;
    const nav = navFor(plan, navs);
    const mapped = plan.schemeCode && plan.schemeCode !== 'unmapped';
    const priced = !!nav && units > 0;

    const invested = usd ? mfUsdCostBasis(mine, plan.id) : investedInr;
    const valueInr = priced ? units * nav.nav : null;
    // Unpriced holdings are carried at cost (the "cost basis" badge).
    const value = units === 0 ? 0
      : priced ? (usd ? convert(valueInr, 'INR', 'USD', usdPerInr) : valueInr)
      : invested;
    const costBasis = units > 0 && !priced;
    const gain = priced && value != null ? value - invested : null;

    const flows = flowsFor(mine, currency);
    return {
      planId: plan.id, name: plan.name || plan.id, amc: plan.amc || 'Other',
      schemeCode: plan.schemeCode, amountInr: plan.amountInr || 0, active: plan.active !== false,
      needsMapping: !mapped, costBasis,
      units, investedInr, invested, valueInr, value, nav: nav?.nav ?? null, navDate: nav?.date ?? null,
      avgCost: units > 0 ? invested / units : 0,
      gain, gainPct: gain != null && invested > 0 ? gain / invested : null,
      xirr: priced && value != null ? xirrWith(flows, value, today) : null,
      flows,
    };
  }).sort((a, b) => a.amc.localeCompare(b.amc) || a.name.localeCompare(b.name));

  const amcs = [];
  for (const f of funds) {
    let g = amcs.find(x => x.amc === f.amc);
    if (!g) amcs.push(g = { amc: f.amc, funds: [] });
    g.funds.push(f);
  }
  for (const g of amcs) {
    g.invested = sum(g.funds.map(f => f.invested));
    g.value = g.funds.some(f => f.value == null) ? null : sum(g.funds.map(f => f.value));
    g.gain = g.value == null || g.funds.some(f => f.costBasis) ? null : g.value - g.invested;
    g.gainPct = g.gain != null && g.invested > 0 ? g.gain / g.invested : null;
  }

  const held = funds.filter(f => f.units > 0);
  const partial = held.some(f => f.costBasis);
  const totalValue = rateMissing || held.some(f => f.value == null) ? null : sum(held.map(f => f.value));
  const totalInvested = sum(held.map(f => f.invested));
  const gain = totalValue != null && !partial ? totalValue - totalInvested : null;

  const allFlows = held.map(f => f.flows);
  const totalXirr = !partial && totalValue != null && held.length && allFlows.every(Boolean)
    ? xirrWith(allFlows.flat(), totalValue, today) : null;

  // FX part of the USD gain: the INR cost re-priced at the live rate vs what it cost.
  let fxGain = null, marketGain = null;
  if (usd && gain != null && usdPerInr) {
    fxGain = sum(held.map(f => f.investedInr)) * usdPerInr - totalInvested;
    marketGain = gain - fxGain;
  }

  const cashInr = sum(accountIds.map(id => inrCashBalance(acts, id)));
  const cash = { inr: cashInr, display: usd ? convert(cashInr, 'INR', 'USD', usdPerInr) : cashInr };

  const basis = usd
    ? (inrPerUsd
      ? `Invested at each SIP’s recorded rate; value at live ₹${inrPerUsd.toFixed(2)}/USD`
      : 'Live INR/USD rate unavailable')
    : 'Native INR, units × latest AMFI NAV';

  return {
    currency, usdPerInr, inrPerUsd, rateMissing, basis, today,
    hasActivity: acts.some(a => a.type === 'BUY'),
    funds, amcs,
    unmappedCount: funds.filter(f => f.active && f.needsMapping).length,
    cash,
    total: { invested: totalInvested, value: totalValue, gain, gainPct: gain != null && totalInvested > 0 ? gain / totalInvested : null, xirr: totalXirr, partial, fxGain, marketGain },
  };
}

// ── Scheme picker helpers ────────────────────────────────────────────────────

const SEEDS = {
  'birla-flexi': 'Flexi Cap',
  'birla-conglomerate': 'Conglomerate',
  'sbi-retirement': 'SBI Retirement Benefit',
  'iti-small-cap': 'ITI Small Cap',
};

/** Initial search text for a plan — a query, never a preselected result. */
export function searchSeed(plan) {
  const known = SEEDS[String(plan?.id || '').toLowerCase()];
  if (known) return known;
  return String(plan?.name || '')
    .replace(/\b(direct|regular|plan|growth|idcw|option|fund)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** SipPlans patch for a picked result; the display name is only changed on request. */
export function mapPatchFor(result, rename) {
  return rename ? { schemeCode: String(result.code), name: result.name } : { schemeCode: String(result.code) };
}

const SUB_PLAN_RE = /aggressive hybrid|conservative hybrid|aggressive|conservative/gi;

/** Warn when results hold several sub-plans of one fund (e.g. SBI Retirement Benefit). */
export function subPlanHint(results) {
  const seen = new Set();
  for (const r of results || []) for (const m of String(r.name).match(SUB_PLAN_RE) || []) seen.add(m.toLowerCase());
  return seen.size >= 2
    ? 'This fund has several sub-plans (Aggressive, Aggressive Hybrid, Conservative, Conservative Hybrid); check the statement.'
    : '';
}
