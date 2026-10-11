import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  cleanSeries, cagrPct, volPct, maxDrawdownPct, qualityFlags, windowMetrics, subYears, indexOnOrBefore, daysBetween,
  lastCompletedMonthEnd, monthEndsBack, monthEndNavs, alignMonthEnds, encodeNavs, decodeNavs, median, rollingBeat,
} from '../../functions/lib/mf-peers/_metrics.mjs';
import { parseMfapiBody } from '../../functions/lib/mf-peers/_series.mjs';

const fx = (n) => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/mf-peers', n), 'utf8');
const load = (code) => parseMfapiBody(fx(`mfapi-${code}.json`)).series;
const S = (pairs) => pairs.map(([date, nav]) => ({ date, nav }));

describe('cleanSeries', () => {
  it('drops bad dates and non-positive/NaN NAVs, keeps the last duplicate, sorts ascending, never forward-fills', () => {
    const s = cleanSeries([
      { date: '2026-01-05', nav: '10' }, { date: '2026-01-02', nav: 9 }, { date: '2026-01-05', nav: 11 },
      { date: '2026-01-06', nav: 0 }, { date: '2026-01-07', nav: 'x' }, { date: '05-01-2026', nav: 5 }, { date: '2026-02-30', nav: 5 }, null,
    ]);
    expect(s).toEqual(S([['2026-01-02', 9], ['2026-01-05', 11]]));
  });
});

describe('dates', () => {
  it('subYears keeps the calendar day (29 Feb → 28 Feb)', () => {
    expect(subYears('2026-10-09', 3)).toBe('2023-10-09');
    expect(subYears('2024-02-29', 1)).toBe('2023-02-28');
  });
  it('indexOnOrBefore is the last point at or before the date', () => {
    const s = S([['2026-01-02', 1], ['2026-01-05', 2], ['2026-01-09', 3]]);
    expect(indexOnOrBefore(s, '2026-01-01')).toBe(-1);
    expect(indexOnOrBefore(s, '2026-01-05')).toBe(1);
    expect(indexOnOrBefore(s, '2026-01-08')).toBe(1);
    expect(indexOnOrBefore(s, '2027-01-01')).toBe(2);
  });
});

describe('cagrPct', () => {
  it('is exactly the point-to-point return over a 365-day year', () => {
    expect(cagrPct(S([['2025-10-09', 100], ['2026-10-09', 110]]), 1)).toBeCloseTo(10, 10);
  });
  it('annualises over the actual span: 2x in 1096 days (3y incl. a leap day) = 2^(365/1096) - 1', () => {
    const v = cagrPct(S([['2023-10-09', 100], ['2026-10-09', 200]]), 3);
    expect(daysBetween('2023-10-09', '2026-10-09')).toBe(1096);
    expect(v).toBeCloseTo(25.9655, 3);
  });
  it('uses the NAV on or before the same calendar day N years earlier (AMFI convention)', () => {
    // target start = Sun 2025-10-12 → the Fri 2025-10-10 NAV (100) is the start; end Mon 2026-10-12.
    const s = S([['2025-10-09', 50], ['2025-10-10', 100], ['2025-10-13', 70], ['2026-10-12', 120]]);
    expect(cagrPct(s, 1)).toBeCloseTo((Math.pow(1.2, 365 / 367) - 1) * 100, 8);
  });
  it('is null (not 0) when history is shorter than N years, or the start NAV is > 7 days before the target', () => {
    expect(cagrPct(S([['2025-10-20', 100], ['2026-10-09', 110]]), 1)).toBeNull();
    expect(cagrPct(S([['2025-09-20', 100], ['2026-10-09', 110]]), 1)).toBeNull();
    expect(cagrPct([], 1)).toBeNull();
    expect(cagrPct(S([['2026-10-09', 100]]), 1)).toBeNull();
  });
});

describe('volPct / maxDrawdownPct', () => {
  it('volatility = sample stdev of daily log returns x sqrt(252), hand-computed', () => {
    // returns ln1.1, ln0.9, ln1.1 → mean .02842, sumsq .02684596, var .01342298, sd .115857 → x15.8745 = 183.92 %
    const s = S([['2026-01-01', 100], ['2026-01-02', 110], ['2026-01-05', 99], ['2026-01-06', 108.9]]);
    expect(volPct(s, 3, 0)).toBeCloseTo(183.92, 1);
  });
  it('a constant daily growth rate has zero volatility; too short a window is blank', () => {
    const pts = []; let nav = 100; const t0 = Date.parse('2025-01-01T00:00:00Z');
    for (let i = 0; i <= 400; i++) { pts.push({ date: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), nav }); nav *= 1.001; }
    expect(volPct(pts, 3)).toBeCloseTo(0, 6);
    expect(volPct(pts.slice(-100), 3)).toBeNull();
  });
  it('max drawdown is peak-to-trough on NAV, <= 0', () => {
    const s = S([['2026-01-01', 100], ['2026-02-01', 120], ['2026-03-01', 60], ['2026-04-01', 90], ['2026-07-01', 130]]);
    expect(maxDrawdownPct(s, 5, 0)).toBeCloseTo(-50, 10);
    expect(maxDrawdownPct(S([['2026-01-01', 100], ['2026-03-01', 110]]), 5, 0)).toBe(0);
    expect(maxDrawdownPct(S([['2026-01-01', 100], ['2026-01-20', 90]]), 5)).toBeNull(); // < 180 days
  });
});

describe('window clipping (a spike outside the window must not touch the metrics)', () => {
  const quant = load('120828');
  it('Quant Small Cap 2015 one-day spike is in the data but outside every 1/3/5y window', () => {
    expect(qualityFlags(quant, 20).jumps.length).toBeGreaterThanOrEqual(2); // +38.8% / -27.9% on 2015-05-27/28
    expect(qualityFlags(quant, 5).jumps).toEqual([]);
    expect(maxDrawdownPct(quant, 5)).toBeGreaterThan(-35);
    expect(volPct(quant, 3)).toBeLessThan(40);
  });
});

describe('qualityFlags', () => {
  it('flags a > 7-day gap and a > 15% one-day move inside the window, never drops them', () => {
    const s = S([['2026-01-01', 100], ['2026-01-02', 101], ['2026-01-12', 102], ['2026-01-13', 125]]);
    const f = qualityFlags(s, 5);
    expect(f.gaps).toEqual([{ from: '2026-01-02', to: '2026-01-12', days: 10 }]);
    expect(f.jumps).toHaveLength(1);
    expect(f.jumps[0].date).toBe('2026-01-13');
    expect(f.jumps[0].pct).toBeCloseTo(22.549, 2);
  });
});

describe('real series (ITI Small Cap Direct, mfapi sample as of 2026-10-09)', () => {
  const iti = load('147919');
  it('matches the research numbers', () => {
    expect(iti[iti.length - 1].date).toBe('2026-10-09');
    expect(cagrPct(iti, 1)).toBeCloseTo(17.78, 1);
    expect(volPct(iti, 3)).toBeCloseTo(19.39, 1);
    expect(maxDrawdownPct(iti, 3)).toBeCloseTo(-24.17, 1);
    expect(cagrPct(iti, 5)).toBeCloseTo(17.49, 1);
  });
  it('ABSL Conglomerate Direct (young): 1y exists, 3y/5y are blank', () => {
    const c = load('153124');
    expect(cagrPct(c, 1)).toBeCloseTo(-4.84, 1);
    expect(cagrPct(c, 3)).toBeNull();
    expect(cagrPct(c, 5)).toBeNull();
  });
});

describe('windowMetrics (common window)', () => {
  it('cumulative while the window is < 365 days; basis says so', () => {
    const s = S([['2025-10-27', 100], ['2026-03-02', 90], ['2026-10-09', 110]]);
    const w = windowMetrics(s, '2025-10-27', { minPoints: 3 });
    expect(w).toMatchObject({ ok: true, windowStartDate: '2025-10-27', windowReturnBasis: 'cumulative' });
    expect(w.retWindowPct).toBeCloseTo(10, 10);
    expect(w.maxDrawdownWindowPct).toBeCloseTo(-10, 10);
    expect(w.volWindowPct).not.toBeNull();
  });
  it('annualised once the window reaches 365 days', () => {
    const s = S([['2025-10-27', 100], ['2026-10-27', 121]]);
    const w = windowMetrics(s, '2025-10-27');
    expect(w.windowReturnBasis).toBe('annualised');
    expect(w.retWindowPct).toBeCloseTo(21, 8); // 365 days → annualised == cumulative
    expect(windowMetrics(S([['2025-10-27', 100], ['2027-10-27', 144]]), '2025-10-27').retWindowPct).toBeCloseTo((Math.pow(1.44, 365 / 730) - 1) * 100, 8);
  });
  it('is blank with a reason (never a shorter window) when the series starts after the window start', () => {
    const w = windowMetrics(S([['2025-10-28', 100], ['2026-10-09', 110]]), '2025-10-27');
    expect(w.ok).toBe(false);
    expect(w.reason).toMatch(/starts 2025-10-28, after the window start 2025-10-27/);
    expect(w.retWindowPct).toBeNull();
    expect(w.windowReturnBasis).toBe('');
  });
  it('ICICI Conglomerate (first NAV exactly on the window start) qualifies', () => {
    const w = windowMetrics(load('153867'), '2025-10-27');
    expect(w.ok).toBe(true);
    expect(w.windowReturnBasis).toBe('cumulative');
  });
});

describe('month-end grid', () => {
  it('lastCompletedMonthEnd / monthEndsBack', () => {
    expect(lastCompletedMonthEnd('2026-10-09')).toBe('2026-09-30');
    expect(lastCompletedMonthEnd('2026-10-31')).toBe('2026-10-31');
    expect(lastCompletedMonthEnd('2026-01-15')).toBe('2025-12-31');
    expect(monthEndsBack('2026-09-30', 3)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30']);
    expect(monthEndsBack('2024-03-31', 2)).toEqual(['2024-02-29', '2024-03-31']);
  });
  it('monthEndNavs takes the NAV on or before each month-end; null before the first NAV', () => {
    const s = S([['2026-07-30', 10], ['2026-08-31', 11], ['2026-09-29', 12]]);
    expect(monthEndNavs(s, '2026-09-30', 4)).toEqual([null, 10, 11, 12]);
  });
  it('alignMonthEnds re-grids a stored array to a later month-end (older-only data → null at the end)', () => {
    expect(alignMonthEnds([1, 2, 3], '2026-08-31', '2026-09-30')).toEqual([2, 3, null]);
    expect(alignMonthEnds([1, 2, 3], '2026-09-30', '2026-09-30')).toEqual([1, 2, 3]);
  });
  it('encode/decode round-trips with blanks', () => {
    expect(decodeNavs(encodeNavs([null, 10.5, null, 12.123456789]))).toEqual([null, 10.5, null, 12.123457]);
    expect(encodeNavs([null, 1.5])).toBe(',1.5');
  });
});

describe('rollingBeat', () => {
  const grow = (rate, start = 0, n = 61) => Array.from({ length: n }, (_, i) => (i < start ? null : 100 * Math.pow(1 + rate, i)));
  const peers = [grow(0.005), grow(0.006), grow(0.004)];
  it('median helper', () => { expect(median([3, 1, 2])).toBe(2); expect(median([4, 1, 2, 3])).toBe(2.5); });
  it('held beats the peer median in every one of the 25 windows → 100%', () => {
    expect(rollingBeat(grow(0.01), peers)).toEqual({ pct: 100, windows: 25 });
  });
  it('held below the peer median → 0%', () => {
    expect(rollingBeat(grow(0.001), peers)).toEqual({ pct: 0, windows: 25 });
  });
  it('a held fund that beats in some windows only is the exact share', () => {
    const held = grow(0.005); // equals the median peer growth, so never strictly greater → 0
    expect(rollingBeat(held, peers).pct).toBe(0);
    // alternate: strong for the first 12 monthly steps of the window range, weak after
    const mixed = []; let v = 100;
    for (let i = 0; i < 61; i++) { mixed.push(v); v *= i < 48 ? 1.02 : 1.0; }
    const r = rollingBeat(mixed, peers);
    expect(r.windows).toBe(25);
    expect(r.pct).toBeCloseTo((21 / 25) * 100, 8); // a window beats the ~6.2% peer median with >= 4 growth steps: ends 36..56 (21 windows)
  });
  it('blank when fewer than 12 windows are usable, or fewer than 3 peers', () => {
    expect(rollingBeat(grow(0.01, 44), peers)).toEqual({ pct: null, windows: 5 });
    expect(rollingBeat(grow(0.01), peers.slice(0, 2))).toEqual({ pct: null, windows: 0 });
  });
  it('a peer with missing months is excluded from just those windows', () => {
    const r = rollingBeat(grow(0.01), [grow(0.005), grow(0.006), grow(0.004), grow(0.02, 50)]);
    expect(r).toEqual({ pct: 100, windows: 25 });
  });
});
