export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function downloadCSV(filename, headers, rows) {
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
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
