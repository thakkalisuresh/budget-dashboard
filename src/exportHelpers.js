// ════════════════════════════════════════════════════════════════════════════
// exportHelpers.js — turn the user's data into downloadable files (CSV / JSON).
// The interesting part is a SECURITY step: "neutralizing" CSV formula injection,
// so a sneaky vendor name can't run as a spreadsheet formula when the exported
// file is opened in Excel or Google Sheets.
// ════════════════════════════════════════════════════════════════════════════

// Trigger a browser download from an in-memory Blob (a chunk of file data).
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);   // make a temporary URL pointing at the blob
  const a   = document.createElement('a'); // create a hidden <a> download link...
  a.href = url; a.download = filename; a.click(); // ...point it at the file and "click" it
  URL.revokeObjectURL(url);                // release the temporary URL to free memory
}

// Neutralize CSV formula injection: a cell whose first non-whitespace char is
// = + - @ (or a leading tab/CR that some parsers strip) can be executed as a
// formula by Excel/Sheets. Prefix a single quote so it's treated as text.
export function neutralizeFormula(value) {
  const s = String(value ?? '');
  if (s.length === 0) return s;
  const t = s.trimStart();
  // Preserve plain numbers (incl. negatives like "-12.50") — they're not formulas.
  if (/^-?\d+(\.\d+)?$/.test(t)) return s;
  const c = t.charCodeAt(0);   // numeric code of the first visible character
  // 0x3d='='  0x2b='+'  0x2d='-'  0x40='@'  0x09=tab  0x0d=carriage-return
  if (c === 0x3d || c === 0x2b || c === 0x2d || c === 0x40 ||
      c === 0x09 || c === 0x0d) {
    return "'" + s;            // prefix a quote → spreadsheet treats it as text, not a formula
  }
  return s;
}

// Build a CSV string from a header array + an array of row arrays, then download it.
export function downloadCSV(filename, headers, rows) {
  // For each value: run the formula guard, double up any embedded quotes, then
  // wrap the whole thing in quotes so commas inside a value don't split columns.
  const escape = (v) => `"${neutralizeFormula(v).replace(/"/g, '""')}"`;
  const csv = [
    headers.map(escape).join(','),               // the header line
    ...rows.map(r => r.map(escape).join(',')),   // then one line per data row
  ].join('\n');
  // Prepend a UTF-8 BOM (the invisible character on the next line) so Excel opens
  // the file as UTF-8 and renders symbols like the rupee/euro sign correctly.
  downloadBlob(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }), filename);
}

export function transactionsToJson(transactions) {
  return JSON.stringify(
    transactions.map(t => ({
      month:     t.month    || undefined,
      date:      t.txDate   || null,
      addedAt:   t.date     || null,
      vendor:    t.vendor,
      category:  t.category,
      amount:    t.amount,
      method:    t.method   || null,
      user:      t.user     || null,
    })),
    null, 2
  );
}
