// ════════════════════════════════════════════════════════════════════════════
// mfInsights.js — pure, deterministic "Portfolio health" engine for the Indian
// mutual-fund section: category mix, SIP-split sanity, holdings overlap and
// stock/sector concentration. No React, no network, no LLM. Same spirit as
// investInsights.js (overlap = Σ min weights, HHI / effective-N), re-implemented
// for ISIN-keyed MF holdings. Every flag carries its numbers and as-of dates;
// wording is factual ("For awareness" / "Worth keeping an eye on"), never advice.
// ════════════════════════════════════════════════════════════════════════════

export const DISCLAIMER = 'Ideas and observations from public data, not investment advice.';

/** One home for every tunable. Persisted as settings.mfInsightThresholds (no editing UI in slice 1). */
export const DEFAULT_MF_THRESHOLDS = Object.freeze({
  pairOverlapPct: 25,        // pair overlap at/above this → watch
  pairOverlapInfoPct: 15,    // …at/above this → info
  singleStockPct: 10,        // one stock above this % of the portfolio → watch
  sectorPct: 30,             // one sector above this % of the portfolio → watch
  categoryPct: 50,           // one SEBI category above this % of the portfolio → watch
  sipSharePct: 40,           // one fund above this % of monthly SIPs → watch
  sipValueDivergencePts: 15, // |SIP share − value share| at/above this → info
  lockInSharePct: 30,        // lock-in fund at/above this % of monthly SIPs → info
});

export const STALE_AFTER_DAYS = 45;

/** Finite numbers in (0, 100] survive; everything else falls back to the default. */
export function sanitizeMfThresholds(raw) {
  const out = { ...DEFAULT_MF_THRESHOLDS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULT_MF_THRESHOLDS)) {
      const v = Number(raw[k]);
      if (raw[k] != null && raw[k] !== '' && Number.isFinite(v) && v > 0 && v <= 100) out[k] = v;
    }
  }
  if (out.pairOverlapInfoPct > out.pairOverlapPct) out.pairOverlapInfoPct = out.pairOverlapPct;
  return out;
}

// ── Fund identity ────────────────────────────────────────────────────────────

/** The seven fundKeys of the holdings contract (Session H's FUND_KEYS must match). */
export const MF_FUND_KEYS = [
  'absl-flexi-cap', 'absl-conglomerate', 'iti-small-cap',
  'sbi-retirement-aggressive-hybrid', 'sbi-retirement-aggressive',
  'sbi-retirement-conservative-hybrid', 'sbi-retirement-conservative',
];

/** AMFI scheme codes verified in the research (Direct Growth). Names do the rest. */
const KNOWN_CODES = {
  120564: 'absl-flexi-cap',
  153124: 'absl-conglomerate',
  147919: 'iti-small-cap',
  148685: 'sbi-retirement-aggressive-hybrid',
};

/** Unmapped plans fall back on the seeded plan id. sbi-retirement is deliberately absent. */
const PLAN_ID_FALLBACK = {
  'birla-flexi': 'absl-flexi-cap',
  'birla-conglomerate': 'absl-conglomerate',
  'iti-small-cap': 'iti-small-cap',
};

const FUND_LABELS = {
  'absl-flexi-cap': 'ABSL Flexi Cap',
  'absl-conglomerate': 'ABSL Conglomerate',
  'iti-small-cap': 'ITI Small Cap',
  'sbi-retirement-aggressive-hybrid': 'SBI Retirement (Aggressive Hybrid)',
  'sbi-retirement-aggressive': 'SBI Retirement (Aggressive)',
  'sbi-retirement-conservative-hybrid': 'SBI Retirement (Conservative Hybrid)',
  'sbi-retirement-conservative': 'SBI Retirement (Conservative)',
};

export const fundLabel = (fundKey) => FUND_LABELS[fundKey] || fundKey;

function fundKeyFromName(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  if (/sbi/.test(n) && /retirement/.test(n)) {
    if (/aggressive hybrid/.test(n)) return 'sbi-retirement-aggressive-hybrid';
    if (/conservative hybrid/.test(n)) return 'sbi-retirement-conservative-hybrid';
    if (/aggressive/.test(n)) return 'sbi-retirement-aggressive';
    if (/conservative/.test(n)) return 'sbi-retirement-conservative';
    return null; // SBI Retirement without a sub-plan: unknown
  }
  if (/iti/.test(n) && /small\s*cap/.test(n)) return 'iti-small-cap';
  if (/birla|absl/.test(n)) {
    if (/conglomerate/.test(n)) return 'absl-conglomerate';
    if (/flexi\s*cap/.test(n)) return 'absl-flexi-cap';
  }
  return null;
}

/**
 * Map a SipPlan (+ the scheme it is mapped to) onto a holdings fundKey, or null
 * when the fund is unknown (e.g. SBI Retirement before the sub-plan is picked).
 * Mapped plans are judged by their scheme code / scheme name only: a user who
 * mapped the plan to some other fund must not inherit the seeded plan id's key.
 */
export function fundKeyFor({ schemeCode, name, planId } = {}) {
  const code = String(schemeCode ?? '').trim();
  const mapped = /^\d+$/.test(code);
  if (mapped) return KNOWN_CODES[code] || fundKeyFromName(name);
  return PLAN_ID_FALLBACK[String(planId || '').toLowerCase()] || fundKeyFromName(name);
}

// ── Categories ───────────────────────────────────────────────────────────────

/** Used only when a fund has no live AMFI category (unmapped plan); shown as "assumed". */
export const ASSUMED_CATEGORY = {
  'absl-flexi-cap': 'Equity: Flexi Cap Fund',
  'absl-conglomerate': 'Equity: Thematic Fund',
  'iti-small-cap': 'Equity: Small Cap Fund',
  'sbi-retirement-aggressive-hybrid': 'Solution Oriented: Retirement Fund',
  'sbi-retirement-aggressive': 'Solution Oriented: Retirement Fund',
  'sbi-retirement-conservative-hybrid': 'Solution Oriented: Retirement Fund',
  'sbi-retirement-conservative': 'Solution Oriented: Retirement Fund',
};

/** equity | hybrid | solution | debt | other, from a categoryKey ("Equity: Flexi Cap Fund"). */
export function categoryGroup(categoryKey) {
  const k = String(categoryKey || '').toLowerCase();
  if (!k) return 'other';
  if (/retirement|children|solution/.test(k)) return 'solution';
  const head = k.split(':')[0].trim();
  if (head === 'equity') return 'equity';
  if (head === 'hybrid') return 'hybrid';
  if (head === 'debt') return 'debt';
  return 'other';
}

export const GROUP_LABELS = { equity: 'Equity', hybrid: 'Hybrid', solution: 'Solution-oriented', debt: 'Debt', other: 'Other' };

// ── Small helpers ────────────────────────────────────────────────────────────

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, d = 1) => { const f = 10 ** d; return Math.round(num(n) * f) / f; };
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const DAY_MS = 86_400_000;
export const daysBetween = (fromIso, toIso) =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);

const flag = (id, severity, message, numbers = {}, asOf = []) => ({ id, severity, message, numbers, asOf: [...new Set(asOf.filter(Boolean))].sort() });

// ── Holdings ─────────────────────────────────────────────────────────────────

/**
 * Group raw sheet rows by fundKey, keeping only each fund's latest asOf. Within a
 * fund, equity rows with the same ISIN are merged (weights add); rows without
 * a positive finite weight are dropped. `weightSum` is over ALL kept rows.
 */
export function groupHoldings(rows) {
  const latest = new Map();
  for (const r of rows || []) {
    if (!r?.fundKey || !r.asOf) continue;
    if (!latest.has(r.fundKey) || String(r.asOf) > latest.get(r.fundKey)) latest.set(r.fundKey, String(r.asOf));
  }
  const out = new Map();
  for (const r of rows || []) {
    if (!r?.fundKey || String(r.asOf) !== latest.get(r.fundKey)) continue;
    const w = Number(r.weightPct);
    if (!Number.isFinite(w) || w <= 0) continue;
    let g = out.get(r.fundKey);
    if (!g) out.set(r.fundKey, g = { fundKey: r.fundKey, asOf: latest.get(r.fundKey), weightSum: 0, equityPct: 0, byKey: new Map() });
    g.weightSum += w;
    if (r.assetClass !== 'equity') continue;
    g.equityPct += w;
    const key = String(r.isin || '').trim().toUpperCase() || `NAME:${String(r.name || '').trim().toLowerCase()}`;
    const cur = g.byKey.get(key);
    if (cur) cur.weightPct += w;
    else g.byKey.set(key, { key, isin: String(r.isin || '').trim().toUpperCase(), name: String(r.name || '').trim() || key, industry: String(r.industry || '').trim(), weightPct: w });
  }
  return out;
}

/**
 * Overlap of two grouped funds: Σ min over shared ISINs, with each fund's equity
 * weights re-scaled to 100% of its own equity (`overlapPct`, the headline) and
 * also as raw % of NAV (`rawPct`, what the research proof of concept printed).
 */
export function pairOverlap(a, b, topN = 5) {
  if (!a?.equityPct || !b?.equityPct) return { overlapPct: 0, rawPct: 0, commonCount: 0, topShared: [] };
  let norm = 0, raw = 0;
  const shared = [];
  for (const [key, ha] of a.byKey) {
    const hb = b.byKey.get(key);
    if (!hb) continue;
    const m = Math.min(ha.weightPct / a.equityPct, hb.weightPct / b.equityPct) * 100;
    norm += m;
    raw += Math.min(ha.weightPct, hb.weightPct);
    shared.push({ isin: ha.isin, name: ha.name || hb.name, wA: round(ha.weightPct, 2), wB: round(hb.weightPct, 2), _m: m });
  }
  shared.sort((x, y) => y._m - x._m || x.name.localeCompare(y.name));
  return {
    overlapPct: round(norm, 1), rawPct: round(raw, 1), commonCount: shared.length,
    topShared: shared.slice(0, topN).map(({ isin, name, wA, wB }) => ({ isin, name, wA, wB })),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * @param funds   view.funds from buildMfView: { planId, name, amc, schemeCode, amountInr, active, units, valueInr, investedInr, costBasis }
 * @param navs    useMfNav().navs  (schemeCode → { name, category, categoryKey, ... })
 * @param holdings  fetchMfHoldings result: { rows, statusByFund, asOfByFund, missing }
 * @param thresholds  settings.mfInsightThresholds (sanitised here as well)
 * @param today   'YYYY-MM-DD'
 */
export function buildMfInsights({ funds = [], navs = {}, holdings = null, thresholds = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const t = sanitizeMfThresholds(thresholds);
  const flags = [];
  const notes = [];

  // 1 ─ identify the active funds
  const active = funds.filter(f => f.active !== false);
  const items = active.map(f => {
    const code = String(f.schemeCode ?? '').trim();
    const nav = /^\d+$/.test(code) ? navs?.[code] : null;
    const fundKey = fundKeyFor({ schemeCode: code, name: nav?.name || f.name, planId: f.planId });
    const liveKey = nav?.categoryKey || null;
    const retirementLike = !fundKey && /retirement/i.test(`${f.name} ${f.planId}`); // sub-plan unknown, category is not
    const categoryKey = liveKey || (fundKey ? ASSUMED_CATEGORY[fundKey] : retirementLike ? ASSUMED_CATEGORY['sbi-retirement-aggressive'] : null) || null;
    return {
      planId: f.planId, name: f.name, fundKey, label: fundKey ? fundLabel(fundKey) : f.name,
      sipInr: num(f.amountInr), valueInr: f.valueInr != null && num(f.valueInr) > 0 ? num(f.valueInr) : null,
      categoryKey, categoryAssumed: !!categoryKey && !liveKey,
    };
  });

  // 2 ─ portfolio weights: market value when every active fund has one, else SIP amounts
  const allValued = items.length > 0 && items.every(i => i.valueInr != null);
  const basis = allValued ? 'value' : 'sip';
  const raw = items.map(i => (basis === 'value' ? i.valueInr : i.sipInr));
  const total = sum(raw);
  items.forEach((i, ix) => { i.weight = total > 0 ? raw[ix] / total : 0; });
  const basisNote = basis === 'value'
    ? 'Weights use the current market value of each fund.'
    : 'Weights use your monthly SIP amounts (current values are not available for every fund yet).';

  // 3 ─ category mix
  const byCat = new Map();
  for (const i of items) {
    const key = i.categoryKey || 'Unclassified';
    const c = byCat.get(key) || { categoryKey: key, group: i.categoryKey ? categoryGroup(i.categoryKey) : 'other', pct: 0, assumed: false, funds: [] };
    c.pct += i.weight * 100;
    c.assumed = c.assumed || i.categoryAssumed;
    c.funds.push(i.label);
    byCat.set(key, c);
  }
  const mix = [...byCat.values()].map(c => ({ ...c, pct: round(c.pct, 1) })).sort((a, b) => b.pct - a.pct || a.categoryKey.localeCompare(b.categoryKey));
  const groupMix = {};
  for (const c of mix) groupMix[c.group] = round((groupMix[c.group] || 0) + c.pct, 1);
  for (const c of mix) {
    if (c.pct > t.categoryPct && c.categoryKey !== 'Unclassified') {
      flags.push(flag(`category-${c.categoryKey}`, 'watch',
        `${c.categoryKey} is ${c.pct}% of the portfolio (${basis === 'value' ? 'by value' : 'by SIP amount'}), above the ${t.categoryPct}% marker.`,
        { pct: c.pct, capPct: t.categoryPct }));
    }
  }

  // 4 ─ SIP-split sanity (active plans only)
  const sipTotal = sum(items.map(i => i.sipInr));
  const valueTotal = allValued ? sum(items.map(i => i.valueInr)) : 0;
  const sipSplit = items.map(i => ({
    planId: i.planId, fundKey: i.fundKey, label: i.label,
    sipSharePct: sipTotal > 0 ? round((i.sipInr / sipTotal) * 100, 1) : null,
    valueSharePct: valueTotal > 0 ? round((i.valueInr / valueTotal) * 100, 1) : null,
    sipInr: i.sipInr,
  }));
  for (const s of sipSplit) {
    if (s.sipSharePct != null && s.sipSharePct > t.sipSharePct) {
      flags.push(flag(`sip-share-${s.planId}`, 'watch',
        `${s.label} takes ${s.sipSharePct}% of the monthly SIPs, above the ${t.sipSharePct}% marker.`,
        { sipSharePct: s.sipSharePct, capPct: t.sipSharePct }));
    }
    if (s.sipSharePct != null && s.valueSharePct != null && Math.abs(s.sipSharePct - s.valueSharePct) >= t.sipValueDivergencePts) {
      const diff = round(Math.abs(s.sipSharePct - s.valueSharePct), 1);
      flags.push(flag(`sip-value-${s.planId}`, 'info',
        `${s.label} is ${s.sipSharePct}% of monthly SIPs but ${s.valueSharePct}% of current value (${diff} points apart).`,
        { sipSharePct: s.sipSharePct, valueSharePct: s.valueSharePct, diffPts: diff, thresholdPts: t.sipValueDivergencePts }));
    }
    if (/^sbi-retirement/.test(s.fundKey || '') || /retirement/i.test(items.find(i => i.planId === s.planId)?.name || '')) {
      if (s.sipSharePct != null && s.sipSharePct >= t.lockInSharePct) {
        flags.push(flag(`lock-in-${s.planId}`, 'info',
          `${s.label} takes ${s.sipSharePct}% of the monthly SIPs. Its units are locked in for 5 years from each instalment, or until age 65 if earlier (per the scheme document; check the current one).`,
          { sipSharePct: s.sipSharePct, thresholdPct: t.lockInSharePct }));
      }
    }
  }

  // 5 ─ holdings: overlap + exposure
  const grouped = groupHoldings(holdings?.rows);
  const statusByFund = holdings?.statusByFund || {};
  const unknownFunds = items.filter(i => !i.fundKey);
  const funds5 = [];   // funds with usable equity holdings
  const fundHoldings = [];
  const asOfDates = [];
  for (const i of items) {
    if (!i.fundKey) continue;
    const g = grouped.get(i.fundKey);
    const st = statusByFund[i.fundKey];
    if (!g || !g.byKey.size) {
      fundHoldings.push({ fundKey: i.fundKey, label: i.label, available: false, status: st?.status || 'missing', reason: st?.reason || '' });
      continue;
    }
    const ageDays = daysBetween(g.asOf, today);
    const stale = ageDays > STALE_AFTER_DAYS || st?.status === 'stale';
    fundHoldings.push({
      fundKey: i.fundKey, label: i.label, available: true, asOf: g.asOf, ageDays, stale,
      status: st?.status || 'ok', reason: st?.reason || '', equityPct: round(g.equityPct, 1), holdingsCount: g.byKey.size,
    });
    asOfDates.push(g.asOf);
    funds5.push({ item: i, g });
    if (st?.status === 'failed' || st?.status === 'stale') {
      notes.push({ id: `status-${i.fundKey}`, kind: 'status', message: `${i.label}: latest refresh ${st.status}${st.reason ? ` (${st.reason})` : ''}; showing holdings as of ${g.asOf}.` });
    } else if (ageDays > STALE_AFTER_DAYS) {
      notes.push({ id: `stale-${i.fundKey}`, kind: 'stale', message: `${i.label}: holdings are from ${g.asOf} (${ageDays} days ago), so they may be out of date.` });
    }
    if (g.weightSum > 105 || g.weightSum < 50) {
      notes.push({ id: `weights-${i.fundKey}`, kind: 'data', message: `${i.label}: the holding weights add up to ${round(g.weightSum, 1)}%, which looks off; treat these numbers with care.` });
    }
  }
  for (const i of unknownFunds) {
    notes.push({ id: `unknown-${i.planId}`, kind: 'unknown', message: /sbi/i.test(`${i.name} ${i.planId}`) && /retirement/i.test(`${i.name} ${i.planId}`)
      ? `${i.name}: the sub-plan (Aggressive, Aggressive Hybrid, Conservative, Conservative Hybrid) is not confirmed yet, so holdings insights are skipped for it. It still counts in the category mix and SIP split.`
      : `${i.name}: not matched to a fund with holdings data, so holdings insights are skipped for it.` });
  }

  const overlap = { pairs: [], funds: funds5.map(x => x.item.fundKey) };
  for (let a = 0; a < funds5.length; a++) {
    for (let b = a + 1; b < funds5.length; b++) {
      const A = funds5[a], B = funds5[b];
      const o = pairOverlap(A.g, B.g);
      const pair = {
        a: A.item.fundKey, b: B.item.fundKey, aLabel: A.item.label, bLabel: B.item.label, ...o,
        equityCoverage: { a: round(A.g.equityPct, 1), b: round(B.g.equityPct, 1) },
        asOf: [A.g.asOf, B.g.asOf],
      };
      overlap.pairs.push(pair);
      const sev = o.overlapPct >= t.pairOverlapPct ? 'watch' : o.overlapPct >= t.pairOverlapInfoPct ? 'info' : null;
      if (sev) {
        flags.push(flag(`overlap-${pair.a}-${pair.b}`, sev,
          `${pair.aLabel} and ${pair.bLabel} hold ${o.commonCount} of the same stocks; ${o.overlapPct}% of each fund's equity overlaps.`,
          { overlapPct: o.overlapPct, rawPct: o.rawPct, commonCount: o.commonCount, thresholdPct: sev === 'watch' ? t.pairOverlapPct : t.pairOverlapInfoPct },
          pair.asOf));
      }
    }
  }

  // Portfolio-level exposure: Σ portfolio weight × holding weight, by ISIN / industry.
  const stocks = new Map();
  const sectors = new Map();
  for (const { item, g } of funds5) {
    for (const h of g.byKey.values()) {
      const contrib = item.weight * h.weightPct; // percent of the portfolio
      const s = stocks.get(h.key) || { isin: h.isin, name: h.name, pct: 0, funds: new Set() };
      s.pct += contrib; s.funds.add(item.label);
      stocks.set(h.key, s);
      const sk = (h.industry || 'Unclassified').toLowerCase();
      const sec = sectors.get(sk) || { sector: h.industry || 'Unclassified', pct: 0 };
      sec.pct += contrib;
      sectors.set(sk, sec);
    }
  }
  const coveragePct = round(sum(funds5.map(x => x.item.weight)) * 100, 1);
  const stockList = [...stocks.values()].sort((a, b) => b.pct - a.pct || a.name.localeCompare(b.name));
  const equityTotal = sum(stockList.map(s => s.pct));
  const hhi = equityTotal > 0 ? sum(stockList.map(s => (s.pct / equityTotal) ** 2)) : 0;
  const exposure = {
    coveragePct,
    coveredFunds: funds5.map(x => x.item.fundKey),
    stockCount: stockList.length,
    equityOfPortfolioPct: round(equityTotal, 1),
    top10: stockList.slice(0, 10).map(s => ({ isin: s.isin, name: s.name, pct: round(s.pct, 2), funds: [...s.funds].sort() })),
    top10Pct: round(sum(stockList.slice(0, 10).map(s => s.pct)), 1),
    top10SharePct: equityTotal > 0 ? round((sum(stockList.slice(0, 10).map(s => s.pct)) / equityTotal) * 100, 1) : 0,
    hhi: round(hhi, 4),
    effectiveN: hhi > 0 ? round(1 / hhi, 0) : 0,
    sectors: [...sectors.values()].sort((a, b) => b.pct - a.pct || a.sector.localeCompare(b.sector)).slice(0, 8).map(s => ({ sector: s.sector, pct: round(s.pct, 1) })),
    lowerBound: coveragePct < 99.5,
  };
  for (const s of stockList) {
    if (s.pct > t.singleStockPct) {
      flags.push(flag(`stock-${s.isin || s.name}`, 'watch',
        `${s.name} is about ${round(s.pct, 1)}% of the portfolio across ${[...s.funds].sort().join(' and ')}, above the ${t.singleStockPct}% marker.`,
        { pct: round(s.pct, 1), capPct: t.singleStockPct }, asOfDates));
    }
  }
  for (const s of exposure.sectors) {
    if (s.pct > t.sectorPct && s.sector !== 'Unclassified') {
      flags.push(flag(`sector-${s.sector.toLowerCase()}`, 'watch',
        `${s.sector} is about ${s.pct}% of the portfolio through the funds' holdings, above the ${t.sectorPct}% marker.`,
        { pct: s.pct, capPct: t.sectorPct }, asOfDates));
    }
  }
  if (funds5.length && coveragePct < 99.5) {
    notes.push({ id: 'coverage', kind: 'coverage', message: `Stock and sector figures cover ${coveragePct}% of the portfolio (funds with holdings data), so they are minimums, not totals.` });
  }

  const status = !funds5.length ? 'no-holdings' : funds5.length < items.length ? 'partial' : 'ok';
  if (status === 'no-holdings') {
    notes.push({ id: 'no-holdings', kind: 'no-holdings', message: 'Holdings data is not available yet, so overlap and concentration are not shown. The category mix and SIP split below do not need it.' });
  }

  const sevOrder = { watch: 0, info: 1 };
  flags.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.id.localeCompare(b.id));
  const watch = flags.filter(f => f.severity === 'watch').length;
  const info = flags.length - watch;
  const headline = !items.length ? 'No active funds to look at yet.'
    : flags.length === 0 ? 'Nothing stands out against the current markers.'
    : `${watch} worth keeping an eye on, ${info} for awareness.`;

  return {
    today, thresholds: t, basis, basisNote, headline,
    counts: { watch, info },
    funds: items.map(i => ({ planId: i.planId, fundKey: i.fundKey, label: i.label, weightPct: round(i.weight * 100, 1), categoryKey: i.categoryKey, categoryAssumed: i.categoryAssumed })),
    categoryMix: mix, groupMix, sipSplit,
    holdings: { status, funds: fundHoldings, asOf: [...new Set(asOfDates)].sort() },
    overlap, exposure, flags, notes, disclaimer: DISCLAIMER,
  };
}
