// Ported from etfray (MIT) — see NOTICE
// ════════════════════════════════════════════════════════════════════════════
// investInsights.js — pure portfolio analytics for the Invest tab. No React, no
// fetch: every function takes plain data and returns plain data, all unit-tested.
//
// Builds on investMath.js (valuePortfolio / isEtf / deriveHoldings). This module
// adds the holdings-SET math the recommendation engine needs:
//   • computeOverlap     — weight-adjusted overlap between two holdings sets
//   • concentration      — HHI / effective-N / verdict over one holdings set
//   • aggregatePortfolio — explode the user's ETFs into a combined look-through set
//
// HOLDINGS SHAPE (the shared contract, produced by edgarService.parseNportXml and
// by aggregatePortfolio): { name, cusip, ticker, weight } where weight is PERCENT
// (0–100). A set need not sum to exactly 100 — every function here renormalizes
// against the actual column sum, so partial N-PORT filings are handled.
//
// IDENTITY-KEY PRECEDENCE (documented contract): a holding is keyed by the first
// available of CUSIP → normalized ticker → normalized name. CUSIP is the most
// reliable (N-PORT's primary identifier) and matches across ETFs that all report
// the same security by CUSIP. LIMITATION: without a CUSIP↔ticker lookup table we
// cannot reconcile a CUSIP-keyed ETF underlying against a ticker-keyed direct
// stock of the same company — they are treated as distinct keys. This is the
// same trade-off etfray makes; a mapping table is a future enhancement.
// ════════════════════════════════════════════════════════════════════════════
import { valuePortfolio, isEtf } from './investMath.js';

/** Collapse a name to a stable comparison key (uppercase, alnum-only). */
function normName(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

/** Canonical identity key for a holding: CUSIP → ticker → name (precedence). */
export function holdingKey(h) {
  const cusip = String(h.cusip || '').trim();
  if (cusip && !/^0+$/.test(cusip)) return `C:${cusip}`;
  const ticker = String(h.ticker || '').trim().toUpperCase();
  if (ticker) return `T:${ticker}`;
  return `N:${normName(h.name)}`;
}

/** Human label for a holding: name → ticker → cusip. */
function holdingLabel(h) {
  return String(h.name || '').trim() || String(h.ticker || '').trim() || String(h.cusip || '').trim();
}

/**
 * Group a holdings set by canonical key and renormalize weights to sum 100.
 * Returns Map<key, { weight, label }>. Partial filings (sum ≠ 100) are rescaled
 * against the actual sum so every set is on a consistent 0–100 scale.
 */
function normalizeSet(holdings) {
  const byKey = new Map();
  let total = 0;
  for (const h of holdings || []) {
    const w = Number(h.weight) || 0;
    if (w <= 0) continue;
    total += w;
    const key = holdingKey(h);
    const prev = byKey.get(key);
    if (prev) prev.weight += w;
    else byKey.set(key, { weight: w, label: holdingLabel(h) });
  }
  if (total > 0) for (const v of byKey.values()) v.weight = (v.weight / total) * 100;
  return byKey;
}

/**
 * Weight-adjusted overlap between two holdings sets (etfray
 * `calculate_weight_overlap`). Each set is renormalized to sum 100, grouped by
 * canonical key, then overlap = Σ min(wA, wB) over shared keys.
 *
 * Returns { overlapPct, sharedCount, topShared: [{ key, label, wA, wB }] }
 * (topShared sorted by min(wA,wB) desc, capped at 10).
 */
export function computeOverlap(holdingsA, holdingsB) {
  const a = normalizeSet(holdingsA);
  const b = normalizeSet(holdingsB);
  if (a.size === 0 || b.size === 0) return { overlapPct: 0, sharedCount: 0, topShared: [] };

  const shared = [];
  let overlap = 0;
  for (const [key, va] of a) {
    const vb = b.get(key);
    if (!vb) continue;
    const m = Math.min(va.weight, vb.weight);
    overlap += m;
    shared.push({ key, label: va.label || vb.label, wA: va.weight, wB: vb.weight, _m: m });
  }
  shared.sort((x, y) => y._m - x._m);
  return {
    overlapPct: Math.round(overlap * 100) / 100,
    sharedCount: shared.length,
    topShared: shared.slice(0, 10).map(({ key, label, wA, wB }) => ({
      key, label, wA: Math.round(wA * 100) / 100, wB: Math.round(wB * 100) / 100,
    })),
  };
}

/**
 * Concentration metrics for one holdings set (etfray `calculate_concentration`).
 * Weights are renormalized to sum 100 first. Returns:
 *   { numHoldings, top1, top5, top10, hhi, effectiveN, verdict }
 * hhi = Σ (w/100)² (fractional Herfindahl), effectiveN = 1/hhi, verdict:
 *   effectiveN > 100 → "broadly diversified"
 *   effectiveN > 30  → "moderately concentrated"
 *   else             → "highly concentrated"
 */
export function concentration(holdings) {
  const byKey = normalizeSet(holdings);
  const weights = [...byKey.values()].map((v) => v.weight).sort((x, y) => y - x);
  const n = weights.length;
  if (n === 0) {
    return { numHoldings: 0, top1: 0, top5: 0, top10: 0, hhi: 0, effectiveN: 0, verdict: 'no data' };
  }
  const sum = (arr) => arr.reduce((s, w) => s + w, 0);
  const hhi = sum(weights.map((w) => (w / 100) ** 2));
  const effectiveN = hhi > 0 ? 1 / hhi : n;
  const verdict = effectiveN > 100 ? 'broadly diversified'
    : effectiveN > 30 ? 'moderately concentrated'
      : 'highly concentrated';
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    numHoldings: n,
    top1: r2(weights[0]),
    top5: r2(sum(weights.slice(0, 5))),
    top10: r2(sum(weights.slice(0, 10))),
    hhi: Math.round(hhi * 1e6) / 1e6,
    effectiveN: Math.round(effectiveN * 10) / 10,
    verdict,
  };
}

/**
 * Combined look-through holdings set for the user's whole portfolio.
 *
 * For each valued position (via investMath.valuePortfolio): if it's an ETF and
 * we have its looked-through holdings, explode it into underlyings scaled by the
 * position's portfolio weight; otherwise add the stock directly at its weight.
 * Same-security underlyings across different ETFs merge by canonical key.
 *
 * @param {object} args
 * @param {Array}  args.holdings            derived holdings (investMath.deriveHoldings)
 * @param {object} args.quotes              { [symbol]: { price, prevClose } }
 * @param {object} args.etfHoldingsByTicker { [TICKER]: { holdings:[{name,cusip,ticker,weight}] } }
 * @param {Array}  args.extraEtfs           extra symbols to treat as ETFs
 * @returns {Array} normalized holdings [{ name, cusip, ticker, weight }] summing ~100,
 *                  ready for computeOverlap / concentration.
 */
export function aggregatePortfolio({ holdings = [], quotes = {}, etfHoldingsByTicker = {}, extraEtfs = [] } = {}) {
  const { positions, total } = valuePortfolio(holdings, quotes, extraEtfs);
  if (total <= 0) return [];

  const byKey = new Map(); // key → { name, cusip, ticker, weight }
  const add = (h, weight) => {
    if (!(weight > 0)) return;
    const key = holdingKey(h);
    const prev = byKey.get(key);
    if (prev) prev.weight += weight;
    else byKey.set(key, { name: h.name || '', cusip: h.cusip || '', ticker: h.ticker || '', weight });
  };

  for (const p of positions) {
    const sym = String(p.symbol || '').toUpperCase();
    const lookThrough = etfHoldingsByTicker[sym]?.holdings;
    if (isEtf(sym, extraEtfs) && Array.isArray(lookThrough) && lookThrough.length) {
      // Explode: each underlying's share of the ETF × the ETF's portfolio weight.
      const subTotal = lookThrough.reduce((s, u) => s + (Number(u.weight) || 0), 0);
      if (subTotal > 0) {
        for (const u of lookThrough) {
          const uw = (Number(u.weight) || 0) / subTotal; // fraction of the ETF
          add(u, p.weight * uw);
        }
        continue;
      }
    }
    // Direct holding (stock, or an ETF we have no look-through for).
    add({ name: sym, cusip: '', ticker: sym }, p.weight);
  }

  // Renormalize the merged set to sum 100 (positions already ~100, but explosion
  // of a partial filing can drift; keep the contract exact).
  const merged = [...byKey.values()];
  const sum = merged.reduce((s, h) => s + h.weight, 0);
  if (sum > 0) for (const h of merged) h.weight = Math.round((h.weight / sum) * 100 * 1e6) / 1e6;
  return merged.sort((x, y) => y.weight - x.weight);
}
