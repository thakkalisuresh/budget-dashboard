/**
 * Pull the household's scheme sheets out of an AMC workbook buffer (legacy BIFF
 * .xls or .xlsx — SheetJS sniffs the container). Shared by the three AMC
 * modules, which differ only in registry slice, default weight unit and
 * provenance labelling.
 */
import XLSX from 'xlsx';
import { parseHoldingsSheet, headerText } from './_sheet.mjs';
import { fundsOfHouse } from './_registry.mjs';

/** Rows per sheet to read: scheme sheets are ~100-250 rows; the legacy ABSL .xls declares 65,531. */
const MAX_SHEET_ROWS = 1500;

export function readWorkbook(buf) {
  return XLSX.read(buf, { type: 'buffer', dense: true, sheetRows: MAX_SHEET_ROWS, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false });
}

function sheetGrid(wb, code) {
  const want = String(code).trim().toLowerCase();
  const name = wb.SheetNames.find(n => n.trim().toLowerCase() === want);
  if (!name) return null;
  return { name, grid: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null }) };
}

/**
 * @returns {Record<string, {fundKey, asOf, rows, sheet, unit, unitSource, grandPct,
 *   sawGrandTotal, unclassifiedPct, sourceFile} | {fundKey, error}>}
 */
export function parseHouseWorkbook(buf, house, { defaultUnit, fileName = '', fundKeys } = {}) {
  const out = {};
  let wb;
  try {
    wb = readWorkbook(buf);
  } catch (e) {
    const error = `unreadable workbook: ${e?.message || e}`;
    for (const f of fundsOfHouse(house)) if (!fundKeys || fundKeys.includes(f.fundKey)) out[f.fundKey] = { fundKey: f.fundKey, error };
    return out;
  }
  for (const f of fundsOfHouse(house)) {
    if (fundKeys && !fundKeys.includes(f.fundKey)) continue;
    const found = sheetGrid(wb, f.sheet);
    if (!found) { out[f.fundKey] = { fundKey: f.fundKey, error: `sheet ${f.sheet} not found` }; continue; }
    if (!f.titleRe.test(headerText(found.grid))) {
      out[f.fundKey] = { fundKey: f.fundKey, error: `sheet ${f.sheet} title does not match ${f.label}` };
      continue;
    }
    const parsed = parseHoldingsSheet(found.grid, { defaultUnit });
    out[f.fundKey] = {
      fundKey: f.fundKey,
      sheet: found.name,
      sourceFile: `${house}:${fileName || 'upload'}#${found.name}`,
      ...parsed,
    };
  }
  return out;
}
