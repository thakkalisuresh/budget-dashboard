import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import XLSX from 'xlsx';
import { parseHoldingsSheet, excelSerialToIso, parseWeightCell } from '../../functions/lib/mf-holdings/_sheet.mjs';
import { parseAbslWorkbook } from '../../functions/lib/mf-holdings/absl.mjs';
import { parseSbiWorkbook } from '../../functions/lib/mf-holdings/sbi.mjs';
import { parseItiWorkbook } from '../../functions/lib/mf-holdings/iti.mjs';

const fx = (n) => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/mf-holdings', n));
const sum = (rows, pred = () => true) => rows.filter(pred).reduce((s, r) => s + r.weightPct, 0);
const byIsin = (rows, isin) => rows.filter(r => r.isin === isin);

describe('cell helpers', () => {
  it('converts Excel serials to ISO dates', () => {
    expect(excelSerialToIso(46295)).toBe('2026-09-30');
    expect(excelSerialToIso(45291)).toBe('2023-12-31');
  });

  it('parses weight cells: numbers, "$0.00%", NIL, blanks', () => {
    expect(parseWeightCell(0.0559)).toBe(0.0559);
    expect(parseWeightCell('$0.00%')).toBe(0);
    expect(parseWeightCell('12.5%')).toBe(12.5);
    expect(parseWeightCell('NIL')).toBeNull();
    expect(parseWeightCell('NA')).toBeNull();
    expect(parseWeightCell('')).toBeNull();
    expect(parseWeightCell(null)).toBeNull();
    expect(parseWeightCell(' - ')).toBeNull();
  });
});

describe('ABSL (legacy .xls, fractions)', () => {
  const out = parseAbslWorkbook(fx('absl.xls'));

  it('finds both held schemes by sheet code + title text', () => {
    expect(Object.keys(out).sort()).toEqual(['absl-conglomerate', 'absl-flexi-cap']);
    expect(out['absl-flexi-cap'].error).toBeUndefined();
    expect(out['absl-conglomerate'].error).toBeUndefined();
  });

  it('reads the portfolio date from the sheet and tags provenance', () => {
    const f = out['absl-flexi-cap'];
    expect(f.asOf).toBe('2026-09-30');
    expect(f.sheet).toBe('BSLEQTY');
  });

  it('normalises fractions to percent (5.59673% for ICICI Bank)', () => {
    const icici = byIsin(out['absl-flexi-cap'].rows, 'INE090A01021');
    expect(icici).toHaveLength(1);
    expect(icici[0].weightPct).toBeCloseTo(5.5967, 3);
    expect(icici[0].marketValueInrLakh).toBeCloseTo(156610.49, 2);
    expect(icici[0].industry).toBe('Banks');
    expect(icici[0].assetClass).toBe('equity');
  });

  it('classifies cash lines and keeps the negative Net Receivable', () => {
    const rows = out['absl-flexi-cap'].rows;
    const treps = rows.find(r => /treps/i.test(r.name));
    expect(treps.assetClass).toBe('cash');
    const net = rows.find(r => /net receivable/i.test(r.name));
    expect(net.assetClass).toBe('cash');
    expect(net.weightPct).toBeLessThan(0);
  });

  it('drops totals, headings and the zero-weight unlisted lines', () => {
    const rows = out['absl-flexi-cap'].rows;
    expect(rows.some(r => /^(sub\s*)?total$/i.test(r.name))).toBe(false);
    expect(rows.some(r => /maestros|mms infra|magnasound/i.test(r.name))).toBe(false);
    expect(rows.every(r => r.weightPct !== 0)).toBe(true);
  });

  it('weights add up to ~100 (grand total row is 1.0 -> fraction unit detected)', () => {
    expect(sum(out['absl-flexi-cap'].rows)).toBeGreaterThan(99.5);
    expect(sum(out['absl-flexi-cap'].rows)).toBeLessThan(100.5);
    expect(out['absl-flexi-cap'].unit).toBe('fraction');
    expect(sum(out['absl-conglomerate'].rows)).toBeGreaterThan(99.5);
  });

  it('puts Conglomerate debt in the debt class', () => {
    const debt = out['absl-conglomerate'].rows.filter(r => r.assetClass === 'debt');
    expect(debt.length).toBeGreaterThan(0);
  });

  it('reports a clear error when a held scheme sheet is missing', () => {
    const wb = XLSX.read(fx('absl.xls'), { type: 'buffer' });
    delete wb.Sheets.ABSLCONF;
    wb.SheetNames = wb.SheetNames.filter(n => n !== 'ABSLCONF');
    const buf = XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
    const r = parseAbslWorkbook(buf);
    expect(r['absl-flexi-cap'].error).toBeUndefined();
    expect(r['absl-conglomerate'].error).toMatch(/sheet ABSLCONF not found/i);
  });

  it('refuses a sheet whose title text does not match the scheme (wrong sheet name)', () => {
    const wb = XLSX.read(fx('absl.xls'), { type: 'buffer' });
    // Point the Flexi sheet code at the Conglomerate sheet's content.
    wb.Sheets.BSLEQTY = wb.Sheets.ABSLCONF;
    const r = parseAbslWorkbook(XLSX.write(wb, { bookType: 'biff8', type: 'buffer' }));
    expect(r['absl-flexi-cap'].error).toMatch(/title/i);
    expect(r['absl-flexi-cap'].rows).toBeUndefined();
  });
});

describe('SBI Retirement (xlsx, percent units, 4 sub-plans)', () => {
  const out = parseSbiWorkbook(fx('sbi.xlsx'));
  const KEYS = ['sbi-retirement-aggressive-hybrid', 'sbi-retirement-aggressive', 'sbi-retirement-conservative-hybrid', 'sbi-retirement-conservative'];

  it('parses all four sub-plans, each independently', () => {
    expect(Object.keys(out).sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) { expect(out[k].error, k).toBeUndefined(); expect(out[k].rows.length, k).toBeGreaterThan(20); }
  });

  it('reads the serial date and does not mix up the sub-plans', () => {
    for (const k of KEYS) expect(out[k].asOf).toBe('2026-09-30');
    expect(out['sbi-retirement-aggressive'].sheet).toBe('SRBF-AP');
    // Aggressive = ~95% equity; Conservative Hybrid = ~38%.
    const eq = (k) => sum(out[k].rows, r => r.assetClass === 'equity');
    expect(eq('sbi-retirement-aggressive')).toBeGreaterThan(90);
    expect(eq('sbi-retirement-conservative-hybrid')).toBeGreaterThan(30);
    expect(eq('sbi-retirement-conservative-hybrid')).toBeLessThan(45);
  });

  it('keeps percent units as-is (HDFC Bank 5.00% in AHP)', () => {
    const hdfc = byIsin(out['sbi-retirement-aggressive-hybrid'].rows, 'INE040A01034');
    expect(hdfc[0].weightPct).toBeCloseTo(5, 5);
    expect(out['sbi-retirement-aggressive-hybrid'].unit).toBe('percent');
  });

  it('tags debt with the rating in the industry column and G-secs as debt', () => {
    const ncd = byIsin(out['sbi-retirement-aggressive-hybrid'].rows, 'INE031A08681')[0];
    expect(ncd.assetClass).toBe('debt');
    expect(ncd.industry).toBe('[ICRA]AAA');
    const gsec = byIsin(out['sbi-retirement-conservative-hybrid'].rows, 'IN0020180041')[0];
    expect(gsec.assetClass).toBe('debt');
  });

  it('classifies TREPS / net receivables as cash (negative allowed)', () => {
    const rows = out['sbi-retirement-aggressive-hybrid'].rows;
    expect(rows.find(r => /treps/i.test(r.name)).assetClass).toBe('cash');
    const net = rows.find(r => /net receivable/i.test(r.name));
    expect(net.assetClass).toBe('cash');
    expect(net.weightPct).toBeCloseTo(-0.28, 2);
  });

  it('sums to ~100 per plan and excludes Total/Grand Total rows', () => {
    for (const k of KEYS) {
      const s = sum(out[k].rows, r => r.assetClass !== 'derivative');
      expect(s, k).toBeGreaterThan(99.5);
      expect(s, k).toBeLessThan(100.5);
      expect(out[k].rows.some(r => /total/i.test(r.name)), k).toBe(false);
    }
  });

  it('fails only the sub-plan whose sheet is renamed, never picks another sheet', () => {
    const wb = XLSX.read(fx('sbi.xlsx'), { type: 'buffer' });
    wb.Sheets['SRBF-XX'] = wb.Sheets['SRBF-CP'];
    delete wb.Sheets['SRBF-CP'];
    wb.SheetNames = wb.SheetNames.map(n => (n === 'SRBF-CP' ? 'SRBF-XX' : n));
    const r = parseSbiWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    expect(r['sbi-retirement-conservative'].error).toMatch(/sheet SRBF-CP not found/i);
    expect(r['sbi-retirement-aggressive'].error).toBeUndefined();
  });

  it('rejects a sheet whose scheme-name text belongs to another sub-plan', () => {
    const wb = XLSX.read(fx('sbi.xlsx'), { type: 'buffer' });
    wb.Sheets['SRBF-AP'] = wb.Sheets['SRBF-CP'];
    const r = parseSbiWorkbook(XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }));
    expect(r['sbi-retirement-aggressive'].error).toMatch(/title/i);
  });
});

describe('ITI Small Cap (xlsx, fractions, derivatives block)', () => {
  const out = parseItiWorkbook(fx('iti.xlsx'));
  const f = out['iti-small-cap'];

  it('parses the Small Cap sheet', () => {
    expect(f.error).toBeUndefined();
    expect(f.asOf).toBe('2026-09-30');
    expect(f.sheet).toBe('ITISCF');
  });

  it('normalises fractions (Acutaas 3.55%)', () => {
    const r = byIsin(f.rows, 'INE00FF01025')[0];
    expect(r.weightPct).toBeCloseTo(3.55, 4);
    expect(r.industry).toBe('Pharmaceuticals & Biotechnology');
    expect(r.assetClass).toBe('equity');
    expect(f.unit).toBe('fraction');
  });

  it('classifies mutual-fund units as other, TREPS and net receivables as cash', () => {
    const mf = f.rows.filter(r => r.isin.startsWith('INF'));
    expect(mf.length).toBeGreaterThan(0);
    expect(mf.every(r => r.assetClass === 'other')).toBe(true);
    expect(f.rows.find(r => /^treps/i.test(r.name)).assetClass).toBe('cash');
    expect(f.rows.find(r => /net receivable/i.test(r.name)).assetClass).toBe('cash');
  });

  it('reads the DERIVATIVES block after GRAND TOTAL as derivative rows, signed by Long/Short', () => {
    const d = f.rows.filter(r => r.assetClass === 'derivative');
    expect(d.length).toBeGreaterThan(0);
    expect(d.every(r => Number.isFinite(r.weightPct))).toBe(true);
    expect(d.find(r => /amber enterprises/i.test(r.name)).weightPct).toBeCloseTo(1.05, 3);
  });

  it('non-derivative weights sum to ~100', () => {
    const s = sum(f.rows, r => r.assetClass !== 'derivative');
    expect(s).toBeGreaterThan(99.5);
    expect(s).toBeLessThan(100.5);
  });
});

describe('generic sheet parser edge cases', () => {
  const HEAD = [
    ['Scheme X'],
    ['Portfolio Statement as on September 30, 2026'],
    [null, 'Name of the Instrument', 'ISIN', 'Industry', 'Quantity', 'Market value', '% to AUM'],
  ];
  const parse = (rows, o = {}) => parseHoldingsSheet([...HEAD, ...rows], { defaultUnit: 'percent', ...o });

  it('aggregates duplicate ISINs (weights and market value summed, names joined)', () => {
    const r = parse([
      [null, 'Equity & Equity Related'],
      [null, 'Foo Ltd.', 'INE000A01010', 'Banks', 10, 100, 2],
      [null, 'Foo Limited', 'INE000A01010', 'Banks', 5, 50, 1.5],
      [null, 'Bar Ltd', 'INE000B01010', 'IT', 5, 50, 1],
      [null, 'GRAND TOTAL', null, null, null, null, 100],
    ]);
    const foo = r.rows.filter(x => x.isin === 'INE000A01010');
    expect(foo).toHaveLength(1);
    expect(foo[0].weightPct).toBeCloseTo(3.5, 6);
    expect(foo[0].marketValueInrLakh).toBeCloseTo(150, 6);
    expect(foo[0].name).toBe('Foo Ltd. / Foo Limited');
    expect(r.rows).toHaveLength(2);
  });

  it('skips NIL / blank / NA weights and unparsable rows without throwing', () => {
    const r = parse([
      [null, 'Equity & Equity Related'],
      [null, 'A', 'INE000A01010', 'Banks', 1, 10, 'NIL'],
      [null, 'B', 'INE000B01010', 'Banks', 1, 10, null],
      [null, 'C', 'INE000C01010', 'Banks', 1, 10, 'NA'],
      [null, 'D', 'INE000D01010', 'Banks', 1, 'abc', 4],
      [null, 'GRAND TOTAL', null, null, null, null, 100],
    ]);
    expect(r.rows.map(x => x.isin)).toEqual(['INE000D01010']);
    expect(r.rows[0].marketValueInrLakh).toBeNull();
  });

  it('detects a fraction/percent mix-up from the grand total, overriding the house default', () => {
    // House says percent but the sheet is in fractions (grand total 1.0).
    const r = parse([
      [null, 'Equity & Equity Related'],
      [null, 'A', 'INE000A01010', 'Banks', 1, 10, 0.6],
      [null, 'B', 'INE000B01010', 'Banks', 1, 10, 0.4],
      [null, 'GRAND TOTAL', null, null, null, null, 1],
    ], { defaultUnit: 'percent' });
    expect(r.unit).toBe('fraction');
    expect(r.rows[0].weightPct).toBeCloseTo(60, 6);
  });

  it('falls back to the house default unit when there is no grand total (truncated file)', () => {
    const r = parse([
      [null, 'Equity & Equity Related'],
      [null, 'A', 'INE000A01010', 'Banks', 1, 10, 0.6],
    ], { defaultUnit: 'fraction' });
    expect(r.unit).toBe('fraction');
    expect(r.sawGrandTotal).toBe(false);
    expect(r.rows[0].weightPct).toBeCloseTo(60, 6);
  });

  it('returns an empty row set (not a throw) for an empty sheet', () => {
    const r = parseHoldingsSheet([], { defaultUnit: 'percent' });
    expect(r.rows).toEqual([]);
    expect(r.asOf).toBeNull();
  });

  it('counts rows seen before any section heading as unclassified (-> other)', () => {
    const r = parse([[null, 'Mystery', 'INE000A01010', 'x', 1, 1, 5], [null, 'GRAND TOTAL', null, null, null, null, 100]]);
    expect(r.rows[0].assetClass).toBe('other');
    expect(r.unclassifiedPct).toBeCloseTo(5, 6);
  });

  it('takes the portfolio date from "as on <Month d, yyyy>" text', () => {
    expect(parse([]).asOf).toBe('2026-09-30');
    expect(parseHoldingsSheet([['Monthly Portfolio Statement as on September 30,2026']], {}).asOf).toBe('2026-09-30');
    expect(parseHoldingsSheet([['PORTFOLIO STATEMENT AS ON :', 46295]], {}).asOf).toBe('2026-09-30');
  });
});
