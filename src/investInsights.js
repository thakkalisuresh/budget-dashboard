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
// the same security by CUSIP.
//
// CUSIP↔TICKER RECONCILIATION (PR2): the precedence above still treats a
// CUSIP-keyed ETF underlying (Apple-in-VOO, C:037833100) as DISTINCT from a
// ticker-keyed direct stock (T:AAPL), understating overlap/concentration. The
// reconciliation layer below closes that gap WITHOUT rewriting holdingKey: given
// a CUSIP→ticker map (built cheaply from the EtfHoldings cache, enriched via the
// OpenFIGI proxy), `canonicalizeHoldings` rewrites a holding to its ticker when
// its CUSIP resolves, so holdingKey then keys it on T:<ticker>. aggregatePortfolio
// accepts the same map; apply it to BOTH sides before computeOverlap/concentration
// so they share one identity space.
// ════════════════════════════════════════════════════════════════════════════
import { valuePortfolio, isEtf, concentrationAfterBuy } from './investMath.js';

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

/** A CUSIP is usable as a map key when non-empty and not an all-zero placeholder. */
function usableCusip(cusip) {
  const c = String(cusip || '').trim();
  return c && !/^0+$/.test(c) ? c : '';
}

/**
 * Build a CUSIP→ticker map (the cheap, cache-derived reconciliation tier) from
 * EtfHoldings rows. N-PORT frequently carries a best-effort ticker alongside the
 * CUSIP (PR1 stores both), and the megacaps that dominate overlap almost always
 * do — so this one pass over the cache covers the cases that matter, for free.
 *
 * Accepts the holding objects readEtfHoldings returns ({ cusip, ticker }) as well
 * as raw rows exposing `holdingTicker`. Only rows with BOTH a usable CUSIP and a
 * ticker contribute; first ticker seen for a CUSIP wins (stable).
 *
 * @param {Array} rows  [{ cusip, ticker } | { cusip, holdingTicker }]
 * @returns {Map<string,string>} usableCusip → UPPERCASE ticker
 */
export function buildCusipTickerMap(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const cusip = usableCusip(r?.cusip);
    if (!cusip || map.has(cusip)) continue;
    const ticker = String(r?.ticker || r?.holdingTicker || '').trim().toUpperCase();
    if (ticker) map.set(cusip, ticker);
  }
  return map;
}

/**
 * Canonicalize one holding against a CUSIP→ticker map: when its CUSIP resolves,
 * return a copy keyed on the ticker (cusip cleared) so holdingKey yields T:<ticker>
 * and it collapses onto any directly-held position of the same company. A no-op
 * when there is no map, no usable CUSIP, or no resolution — PR1 precedence stands.
 */
export function canonicalizeHolding(h, cusipTicker) {
  const cusip = usableCusip(h?.cusip);
  if (cusipTicker && cusip) {
    const ticker = cusipTicker.get(cusip);
    if (ticker) return { ...h, ticker: String(ticker).toUpperCase(), cusip: '' };
  }
  return h;
}

/** Canonicalize a whole holdings set (see canonicalizeHolding). */
export function canonicalizeHoldings(holdings, cusipTicker) {
  if (!cusipTicker || cusipTicker.size === 0) return holdings || [];
  return (holdings || []).map((h) => canonicalizeHolding(h, cusipTicker));
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
 * @param {Map}    args.cusipTicker         optional CUSIP→ticker map; when given,
 *                 every underlying is canonicalized so a CUSIP-keyed ETF holding
 *                 collapses onto a directly-held ticker of the same company.
 * @returns {Array} normalized holdings [{ name, cusip, ticker, weight }] summing ~100,
 *                  ready for computeOverlap / concentration.
 */
export function aggregatePortfolio({ holdings = [], quotes = {}, etfHoldingsByTicker = {}, extraEtfs = [], cusipTicker = null } = {}) {
  const { positions, total } = valuePortfolio(holdings, quotes, extraEtfs);
  if (total <= 0) return [];

  const byKey = new Map(); // key → { name, cusip, ticker, weight }
  const add = (raw, weight) => {
    if (!(weight > 0)) return;
    const h = canonicalizeHolding(raw, cusipTicker); // identity-space reconciliation
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

// ════════════════════════════════════════════════════════════════════════════
// Candidate Check — decision-support engine (PR2). Pure: deterministic flags
// from the user's own thresholds, NEVER a buy/sell verdict. No LLM anywhere.
// ════════════════════════════════════════════════════════════════════════════

/** Finite number or null (so a missing Finnhub field degrades, never NaN). */
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/** Scale every weight in a holdings set by `factor` (relative weights preserved). */
function scaleHoldings(holdings, factor) {
  return (holdings || []).map((h) => ({ ...h, weight: (Number(h.weight) || 0) * factor }));
}

/**
 * 52-week position from a Finnhub `metric` payload (metric.all) + current price.
 * Returns { high, low, nearHighPct, rangePct } or null when the data is absent.
 * `nearHighPct` is the distance BELOW the 52-wk high (0 = at the high).
 */
export function fiftyTwoWeekPosition(metricRaw, price) {
  const m = metricRaw?.metric || metricRaw || {};
  const high = num(m['52WeekHigh']);
  const low = num(m['52WeekLow']);
  const p = num(price);
  if (!(high > 0) || !(p > 0)) return null; // a real quote is always > 0
  const nearHighPct = ((high - p) / high) * 100;
  const rangePct = (low != null && high > low) ? ((p - low) / (high - low)) * 100 : null;
  return {
    high, low,
    nearHighPct: Math.round(nearHighPct * 100) / 100,
    rangePct: rangePct == null ? null : Math.max(0, Math.min(100, Math.round(rangePct * 100) / 100)),
  };
}

/** Valuation facts from a Finnhub `metric` payload. No fabricated sector baseline. */
export function valuationFactors(metricRaw) {
  const m = metricRaw?.metric || metricRaw || {};
  return {
    peTTM: num(m.peTTM) ?? num(m.peBasicExclExtraTTM),
    beta: num(m.beta),
  };
}

/**
 * Analyst snapshot from Finnhub /stock/recommendation (array, newest first).
 * Returns { counts, trend } where trend ∈ improving|deteriorating|flat|null
 * (null when fewer than two periods — a single period has no trend).
 */
export function analystSnapshot(rec) {
  const arr = Array.isArray(rec) ? rec.filter(Boolean) : [];
  if (!arr.length) return { counts: null, trend: null };
  const score = (r) => (num(r.strongBuy) || 0) * 2 + (num(r.buy) || 0) - (num(r.sell) || 0) - (num(r.strongSell) || 0) * 2;
  const latest = arr[0];
  const counts = {
    strongBuy: num(latest.strongBuy) || 0, buy: num(latest.buy) || 0,
    hold: num(latest.hold) || 0, sell: num(latest.sell) || 0, strongSell: num(latest.strongSell) || 0,
    period: String(latest.period || ''),
  };
  if (arr.length < 2) return { counts, trend: null };
  const d = score(latest) - score(arr[1]);
  return { counts, trend: d > 0 ? 'improving' : d < 0 ? 'deteriorating' : 'flat' };
}

/**
 * The transparent "worth it?" rule-check. Each flag reports which check fired and
 * why, against the user's OWN thresholds. Caution ≠ don't-buy; it's a heads-up.
 * A flag whose inputs are absent is omitted (graceful on missing data), never
 * shown as a false pass.
 *
 * @returns {{ flags: Array<{id,label,severity}>, cautionCount, passCount }}
 *          severity ∈ 'caution' | 'pass' | 'neutral'.
 */
export function evaluateCandidate({
  overlap = null, concBefore = null, concAfter = null, posPctAfter = null,
  near52wkPct = null, analystTrend = null, thresholds = {},
} = {}) {
  const t = { overlapPct: 60, concentrationPct: 25, near52wkPct: 5, sectorCapPct: 80, ...(thresholds || {}) };
  const flags = [];
  const r1 = (x) => Math.round(x * 10) / 10;

  if (overlap != null) {
    const caution = overlap > t.overlapPct;
    flags.push({
      id: 'overlap',
      severity: caution ? 'caution' : 'pass',
      label: caution
        ? `High overlap — ${r1(overlap)}% already owned, over your ${t.overlapPct}% line`
        : `Overlap ${r1(overlap)}% — within your ${t.overlapPct}% line`,
    });
  }
  if (posPctAfter != null) {
    const caution = posPctAfter > t.concentrationPct;
    flags.push({
      id: 'position',
      severity: caution ? 'caution' : 'pass',
      label: caution
        ? `This position would be ${r1(posPctAfter)}%, over your ${t.concentrationPct}% single-name cap`
        : `This position ${r1(posPctAfter)}% — under your ${t.concentrationPct}% single-name cap`,
    });
  }
  if (concBefore?.effectiveN != null && concAfter?.effectiveN != null) {
    const worse = concAfter.effectiveN < concBefore.effectiveN;
    flags.push({
      id: 'concentration',
      severity: worse ? 'caution' : 'pass',
      label: worse
        ? `Diversification narrows — effective holdings ${r1(concBefore.effectiveN)} → ${r1(concAfter.effectiveN)}`
        : `Diversification holds — effective holdings ${r1(concBefore.effectiveN)} → ${r1(concAfter.effectiveN)}`,
    });
  }
  if (near52wkPct != null) {
    const caution = near52wkPct <= t.near52wkPct;
    flags.push({
      id: 'near52wk',
      severity: caution ? 'caution' : 'pass',
      label: caution
        ? `Near its 52-week high — within ${r1(near52wkPct)}% of the top`
        : `${r1(near52wkPct)}% below its 52-week high`,
    });
  }
  if (analystTrend) {
    const severity = analystTrend === 'improving' ? 'pass' : analystTrend === 'deteriorating' ? 'caution' : 'neutral';
    flags.push({
      id: 'analyst',
      severity,
      label: analystTrend === 'improving' ? 'Analyst sentiment improving'
        : analystTrend === 'deteriorating' ? 'Analyst sentiment deteriorating'
          : 'Analyst sentiment flat',
    });
  }
  // TODO sector-cap (thresholds.sectorCapPct): a true sector number needs every
  // holding classified by sector — profile2 gives finnhubIndustry per stock but
  // nothing cheap for N-PORT underlyings. Deferred; the concentration-delta flag
  // above is the robust, always-available diversification signal. A misleading
  // sector % would be worse than none.

  const cautionCount = flags.filter((f) => f.severity === 'caution').length;
  const passCount = flags.filter((f) => f.severity === 'pass').length;
  return { flags, cautionCount, passCount };
}

/**
 * Assemble the full Candidate Check briefing from already-fetched data. Pure, so
 * it is unit-tested directly and the dialog stays a thin renderer. Tolerates
 * missing market fields (any of market.quote/metric/recommendation may be absent).
 *
 * @param {object} args
 * @param {string} args.candidateTicker
 * @param {Array}  args.candidateHoldings   the candidate's holdings ({name,cusip,ticker,weight});
 *                                           a stock is [{ ticker, name, weight: 100 }]
 * @param {boolean} args.isEtfCandidate
 * @param {Array}  args.aggPortfolio         user's look-through set (aggregatePortfolio output)
 * @param {Array}  args.positions            valuePortfolio positions (for single-name %)
 * @param {number} args.portfolioTotal
 * @param {number} args.amount               hypothetical $ to add (0 = overlap + current conc only)
 * @param {Map}    args.cusipTicker          CUSIP→ticker reconciliation map
 * @param {object} args.market               { quote, metric, recommendation } (any may be null)
 * @param {object} args.thresholds           settings.preBuyThresholds
 */
export function buildCandidateReport({
  candidateTicker, candidateHoldings = [], isEtfCandidate = false,
  aggPortfolio = [], positions = [], portfolioTotal = 0,
  amount = 0, cusipTicker = null, market = {}, thresholds = {},
} = {}) {
  const cand = canonicalizeHoldings(candidateHoldings, cusipTicker);
  const overlap = computeOverlap(cand, aggPortfolio);
  const concBefore = concentration(aggPortfolio);

  const amt = num(amount) > 0 ? Number(amount) : 0;
  let concAfter = null, posPctAfter = null;
  if (amt > 0 && portfolioTotal > 0) {
    const fAgg = portfolioTotal / (portfolioTotal + amt);
    const fCand = amt / (portfolioTotal + amt);
    const combined = [...scaleHoldings(aggPortfolio, fAgg), ...scaleHoldings(cand, fCand)];
    concAfter = concentration(combined);
    posPctAfter = concentrationAfterBuy(positions, portfolioTotal, candidateTicker, amt).after;
  }

  const price = num(market?.quote?.price ?? market?.quote?.c);
  const pos52 = fiftyTwoWeekPosition(market?.metric, price);
  const valuation = valuationFactors(market?.metric);
  const analyst = analystSnapshot(market?.recommendation);

  const evaluation = evaluateCandidate({
    overlap: overlap.overlapPct,
    concBefore, concAfter, posPctAfter,
    near52wkPct: pos52?.nearHighPct ?? null,
    analystTrend: analyst.trend,
    thresholds,
  });

  return {
    ticker: String(candidateTicker || '').toUpperCase(),
    isEtf: !!isEtfCandidate,
    amount: amt,
    overlap,
    concBefore,
    concAfter,
    posPctAfter,
    factors: { price, pos52, valuation, analyst },
    evaluation,
  };
}
