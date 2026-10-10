/**
 * Rebuilds the trimmed AMC portfolio-disclosure fixtures used by
 * src/__tests__/mf-holdings*.test.js from the real downloaded files.
 *
 *   node scripts/build-mf-holdings-fixtures.mjs <absl.xls> <sbi.xlsx> <iti.xlsx>
 *
 * Each output keeps only the Index sheet and the sheets for the household's
 * funds, cut to the first 12 columns and the portfolio body (plus ITI's trailing
 * DERIVATIVES block), then re-written in the SAME container format as the
 * source (ABSL = legacy BIFF8 .xls, SBI/ITI = .xlsx). The downloaded files are
 * untrusted data: they are only read, never executed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import XLSX from 'xlsx';

const OUT = resolve(import.meta.dirname, '../src/__tests__/fixtures/mf-holdings');
const [absl, sbi, iti] = process.argv.slice(2);
if (!absl || !sbi || !iti) { console.error('usage: build-mf-holdings-fixtures.mjs <absl.xls> <sbi.xlsx> <iti.xlsx>'); process.exit(1); }

const COLS = 12;
const grid = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null })
  .map(r => r.slice(0, COLS));

/** Keep rows up to the footer (first row whose text starts with "^" or "Notes") plus optional extra tail rows. */
function body(rows, { tail = 0 } = {}) {
  const grand = rows.findIndex(r => r.some(c => typeof c === 'string' && /^grand total/i.test(c.trim())));
  let end = rows.findIndex((r, i) => i > grand && r.some(c => typeof c === 'string' && /^(\^|Notes\s*&\s*Symbols\s*:|\$\s+Less|#\s+->)/.test(c.trim())));
  if (end < 0) end = rows.length;
  const cut = tail && grand >= 0 ? Math.min(grand + 1 + tail, rows.length) : Math.min(end, rows.length);
  return rows.slice(0, cut);
}

function build(srcPath, sheets, bookType, outName, opts = {}) {
  const src = XLSX.read(readFileSync(srcPath), { type: 'buffer' });
  const out = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(grid(src, 'Index')), 'Index');
  for (const s of sheets) XLSX.utils.book_append_sheet(out, XLSX.utils.aoa_to_sheet(body(grid(src, s), opts)), s);
  writeFileSync(resolve(OUT, outName), XLSX.write(out, { bookType, type: 'buffer' }));
  console.log('wrote', outName);
}

build(absl, ['BSLEQTY', 'ABSLCONF'], 'biff8', 'absl.xls');
build(sbi, ['SRBF-AHP', 'SRBF-AP', 'SRBF-CHP', 'SRBF-CP'], 'xlsx', 'sbi.xlsx');
build(iti, ['ITISCF'], 'xlsx', 'iti.xlsx', { tail: 0 });
