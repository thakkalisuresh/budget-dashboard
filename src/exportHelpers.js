export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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
  const c = t.charCodeAt(0);
  if (c === 0x3d || c === 0x2b || c === 0x2d || c === 0x40 ||
      c === 0x09 || c === 0x0d) {
    return "'" + s;
  }
  return s;
}

export function downloadCSV(filename, headers, rows) {
  const escape = (v) => `"${neutralizeFormula(v).replace(/"/g, '""')}"`;
  const csv = [
    headers.map(escape).join(','),
    ...rows.map(r => r.map(escape).join(',')),
  ].join('\n');
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
