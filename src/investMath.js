// ════════════════════════════════════════════════════════════════════════════
// investMath.js — pure helpers for the Invest tab. No React, no fetch: every
// function takes plain data and returns plain data, so all of it is unit-tested.
// ════════════════════════════════════════════════════════════════════════════

/** FDIC insurance ceiling per depositor, per insured bank. The HYSA goal. */
export const FDIC_MAX = 250_000;

// ── HYSA / savings ────────────────────────────────────────────────────────────

/** Progress toward the $250k FDIC goal as a 0–100 number (clamped). */
export function goalPct(balance, goal = FDIC_MAX) {
  if (!(goal > 0)) return 0;
  return Math.min(100, Math.max(0, (balance / goal) * 100));
}

/** Balance-weighted blended APY across accounts ({ balance, apy } each, apy in %). */
export function blendedApy(accounts) {
  const total = accounts.reduce((s, a) => s + (a.balance || 0), 0);
  if (total <= 0) return 0;
  return accounts.reduce((s, a) => s + (a.balance || 0) * (a.apy || 0), 0) / total;
}

/** Estimated interest for one month at the given APY (%, simple monthly slice). */
export function monthlyInterest(balance, apyPct) {
  return (balance || 0) * ((apyPct || 0) / 100) / 12;
}

/**
 * Future value after `months` of monthly compounding at `apyPct` with a fixed
 * `monthlyContribution` added each month:
 *   FV = P·(1+r)^n + c·((1+r)^n − 1)/r   where r = apy/12
 */
export function futureValue(balance, apyPct, monthlyContribution, months) {
  const r = (apyPct || 0) / 100 / 12;
  const n = Math.max(0, months || 0);
  if (r === 0) return (balance || 0) + (monthlyContribution || 0) * n;
  const growth = Math.pow(1 + r, n);
  return (balance || 0) * growth + (monthlyContribution || 0) * (growth - 1) / r;
}

/**
 * Months until `balance` reaches `goal` at `apyPct` with `monthlyContribution`.
 * Returns Infinity when the goal is unreachable (no growth and no contribution).
 */
export function monthsToGoal(balance, apyPct, monthlyContribution, goal = FDIC_MAX) {
  if ((balance || 0) >= goal) return 0;
  const r = (apyPct || 0) / 100 / 12;
  const c = monthlyContribution || 0;
  if (r === 0) {
    if (c <= 0) return Infinity;
    return Math.ceil((goal - balance) / c);
  }
  if (c === 0 && balance <= 0) return Infinity;
  // Closed form: n = ln((goal·r + c) / (balance·r + c)) / ln(1+r)
  const num = goal * r + c;
  const den = (balance || 0) * r + c;
  if (den <= 0) return Infinity;
  const n = Math.log(num / den) / Math.log(1 + r);
  return n > 0 && isFinite(n) ? Math.ceil(n) : Infinity;
}

/** Human label for a months horizon: "8 mo", "≈3 yrs", "≈12 yrs", or "—". */
export function horizonLabel(months) {
  if (!isFinite(months)) return '—';
  if (months <= 0) return 'reached';
  if (months < 18) return `${months} mo`;
  return `≈${Math.round(months / 12)} yrs`;
}

// ── Holdings derived from the activity log ───────────────────────────────────

/**
 * Fold BUY/SELL/DIVIDEND activities into per-symbol holdings with FIFO lots.
 * activities: [{ date, accountId, type, symbol, qty, price, amount }]
 * Returns [{ symbol, qty, costBasis, avgCost, lots: [{date, qty, price}], dividends }]
 * sorted by symbol. SELLs consume lots FIFO; oversells clamp at zero.
 */
export function deriveHoldings(activities) {
  const bySymbol = new Map();
  const get = (symbol) => {
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, { symbol, qty: 0, costBasis: 0, lots: [], dividends: 0 });
    }
    return bySymbol.get(symbol);
  };

  const sorted = [...activities]
    .filter(a => a.symbol && ['BUY', 'SELL', 'DIVIDEND'].includes(a.type))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  for (const a of sorted) {
    const h = get(String(a.symbol).toUpperCase());
    const qty = Number(a.qty) || 0;
    const price = Number(a.price) || 0;

    if (a.type === 'BUY' && qty > 0) {
      h.lots.push({ date: a.date, qty, price });
      h.qty += qty;
      h.costBasis += qty * price;
    } else if (a.type === 'SELL' && qty > 0) {
      let remaining = qty;
      while (remaining > 0 && h.lots.length > 0) {
        const lot = h.lots[0];
        const take = Math.min(lot.qty, remaining);
        lot.qty -= take;
        h.qty -= take;
        h.costBasis -= take * lot.price;
        remaining -= take;
        if (lot.qty <= 1e-9) h.lots.shift();
      }
      h.qty = Math.max(0, h.qty);
      h.costBasis = Math.max(0, h.costBasis);
    } else if (a.type === 'DIVIDEND') {
      h.dividends += Number(a.amount) || 0;
    }
  }

  return [...bySymbol.values()]
    .filter(h => h.qty > 1e-9 || h.dividends > 0)
    .map(h => ({ ...h, avgCost: h.qty > 0 ? h.costBasis / h.qty : 0 }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

// ── Portfolio analytics ──────────────────────────────────────────────────────

/** Common broad ETFs auto-detected; the user can extend via settings. */
export const DEFAULT_ETF_SYMBOLS = new Set([
  'VOO', 'VTI', 'VXUS', 'VT', 'VUG', 'VTV', 'VYM', 'VIG', 'BND', 'BNDX',
  'SPY', 'IVV', 'QQQ', 'QQQM', 'DIA', 'IWM', 'SCHD', 'SCHB', 'SCHX',
  'VEA', 'VWO', 'AGG', 'FXAIX', 'FSKAX', 'FZROX', 'FTIHX', 'FXNAX',
]);

export function isEtf(symbol, extra = []) {
  const s = String(symbol || '').toUpperCase();
  return DEFAULT_ETF_SYMBOLS.has(s) || extra.map(x => String(x).toUpperCase()).includes(s);
}

/**
 * Value holdings with live quotes and compute weights.
 * quotes: { [symbol]: { price, prevClose } } — missing quotes fall back to avgCost.
 * Returns { positions, total, dayChange, dayChangePct, etfPct, stockPct, maxWeight }
 */
export function valuePortfolio(holdings, quotes = {}, extraEtfs = []) {
  const positions = holdings
    .filter(h => h.qty > 0)
    .map(h => {
      const q = quotes[h.symbol] || {};
      const price = Number(q.price) > 0 ? Number(q.price) : h.avgCost;
      const prev  = Number(q.prevClose) > 0 ? Number(q.prevClose) : price;
      const value = h.qty * price;
      return {
        ...h, price, value,
        dayChange: h.qty * (price - prev),
        gain: value - h.costBasis,
        etf: isEtf(h.symbol, extraEtfs),
        stale: !(Number(q.price) > 0),
      };
    });

  const total = positions.reduce((s, p) => s + p.value, 0);
  const dayChange = positions.reduce((s, p) => s + p.dayChange, 0);
  const prevTotal = total - dayChange;
  const etfValue = positions.filter(p => p.etf).reduce((s, p) => s + p.value, 0);

  for (const p of positions) p.weight = total > 0 ? (p.value / total) * 100 : 0;

  return {
    positions: positions.sort((a, b) => b.value - a.value),
    total,
    dayChange,
    dayChangePct: prevTotal > 0 ? (dayChange / prevTotal) * 100 : 0,
    etfPct: total > 0 ? (etfValue / total) * 100 : 0,
    stockPct: total > 0 ? ((total - etfValue) / total) * 100 : 0,
    maxWeight: positions.reduce((m, p) => Math.max(m, p.weight), 0),
  };
}

/**
 * Pre-buy portfolio impact: weight of `symbol` after adding `amount` dollars.
 * Returns { before, after } as percentages of the post-buy total.
 */
export function concentrationAfterBuy(positions, total, symbol, amount) {
  const s = String(symbol || '').toUpperCase();
  const current = positions.find(p => p.symbol === s)?.value || 0;
  const newTotal = total + amount;
  return {
    before: total > 0 ? (current / total) * 100 : 0,
    after: newTotal > 0 ? ((current + amount) / newTotal) * 100 : 0,
  };
}

// ── Dated cash flows / currency ──────────────────────────────────────────────

const DAY_MS = 86_400_000;

/**
 * Annualised internal rate of return for dated cash flows (decimal, 0.1 = 10%).
 * flows: [{ date, amount }] — negative = money invested, positive = value
 * received (use today's market value as the final positive flow). Newton's
 * method, falling back to bisection when it diverges. Returns null when the
 * rate is undefined: <2 flows, no sign change, a bad date, or a zero time span.
 */
export function xirr(flows) {
  const pts = (flows || [])
    .map(f => ({ t: Date.parse(f?.date), a: Number(f?.amount) }))
    .filter(f => Number.isFinite(f.a) && f.a !== 0);
  if (pts.length < 2 || pts.some(p => !Number.isFinite(p.t))) return null;
  if (!pts.some(p => p.a < 0) || !pts.some(p => p.a > 0)) return null;
  const t0 = Math.min(...pts.map(p => p.t));
  const span = Math.max(...pts.map(p => p.t)) - t0;
  if (span <= 0) return null;
  const yrs = pts.map(p => (p.t - t0) / DAY_MS / 365);

  const npv = (r) => pts.reduce((s, p, i) => s + p.a / Math.pow(1 + r, yrs[i]), 0);
  const dnpv = (r) => pts.reduce((s, p, i) => s - yrs[i] * p.a / Math.pow(1 + r, yrs[i] + 1), 0);

  let r = 0.1;
  for (let i = 0; i < 50; i++) {
    const f = npv(r), d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (!(next > -1)) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }

  // Bisection on (-1, hi]; npv is monotone decreasing in r for one sign change.
  let lo = -0.999999, hi = 1e6;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-9 || (hi - lo) / 2 < 1e-12) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** Convert between USD and INR given usdPerInr (e.g. 0.0115). null on a bad rate. */
export function convert(amount, from, to, usdPerInr) {
  if (from === to) return amount;
  const rate = Number(usdPerInr);
  if (!(rate > 0)) return null;
  if (from === 'INR' && to === 'USD') return amount * rate;
  if (from === 'USD' && to === 'INR') return amount / rate;
  return null;
}

/**
 * USD value of one activity using its stored fxToUsd (USD per 1 unit of the
 * row's currency). Legacy/blank-currency rows are USD. INR rows without a
 * usable fx return null — never guess.
 */
export function activityUsd(a) {
  const amount = Number(a?.amount) || 0;
  if (!a?.currency || a.currency === 'USD') return amount;
  const fx = Number(a.fxToUsd);
  return fx > 0 ? amount * fx : null;
}

/**
 * This month's contribution flow: USD DEPOSITs dated in `ym` (YYYY-MM). Includes
 * mf_in USD deposits; excludes INR-denominated rows and INR_RECEIVED (a type
 * of its own), so INR never leaks into a USD sum.
 */
export function monthlyDeposits(activities, ym) {
  return (activities || [])
    .filter(a => a.type === 'DEPOSIT' && (!a.currency || a.currency === 'USD') && String(a.date).startsWith(ym))
    .reduce((s, a) => s + (Number(a.amount) || 0), 0);
}
