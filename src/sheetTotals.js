import { apiFetch, writeCell } from './sheetApi.js';
import { safeText } from './sheetHelpers.js';
import { appendHistoryEntry } from './sheetHistory.js';

export async function fetchTotalsForEdit(sheetId, accessToken) {
  const range = encodeURIComponent('Totals!A1:J30');
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const values = json.values || [];
  return values.map((row, i) => ({
    rowNum: i + 1,
    row: Array(10).fill(null).map((_, j) => row[j] ?? null),
  }));
}

export async function writeSalary(sheetId, salary, accessToken) {
  const rows = await fetchTotalsForEdit(sheetId, accessToken);
  const salaryRow = rows.find(r => r.row[5] && String(r.row[5]).toLowerCase().includes('salary received'));
  if (!salaryRow) throw new Error('Salary row not found in Totals');
  await writeCell(sheetId, 'Totals', salaryRow.rowNum, 6, salary, accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Budget Updated',
    category: 'Salary',
    amount: salary,
    details: `Salary set to $${Number(salary).toFixed(2)}`,
  });
}

export async function updateCategoryBudget(sheetId, accessToken, { rowNum, budget, categoryName }) {
  await writeCell(sheetId, 'Totals', rowNum, 2, `=${Number(budget) || 0}-B${rowNum}`, accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Budget Updated',
    category: categoryName,
    amount: budget,
    details: `Budget set to $${Number(budget).toFixed(2)}`,
  });
}

export async function writeBudgetAmounts(sheetId, updates, accessToken) {
  for (const { rowNum, amount } of updates) {
    await writeCell(sheetId, 'Totals', rowNum, 2, amount, accessToken);
  }
}

export async function appendRandomExpenseNote(sheetId, vendorName, amount, accessToken) {
  const rows = await fetchTotalsForEdit(sheetId, accessToken);
  const notesRow = rows.find(r => r.row[5] && String(r.row[5]).toLowerCase().includes('left from salary'));
  if (!notesRow) return;
  const existing = String(notesRow.row[8] || '').trim();
  const entries = existing ? existing.split(',').map(e => e.trim()) : [];
  if (entries.some(e => e.toLowerCase() === vendorName.trim().toLowerCase())) return;
  const newText = existing ? `${existing}, ${vendorName}` : vendorName;
  await writeCell(sheetId, 'Totals', notesRow.rowNum, 8, safeText(newText), accessToken);
}

export async function removeRandomExpenseNote(sheetId, vendorName, accessToken) {
  const rows = await fetchTotalsForEdit(sheetId, accessToken);
  const notesRow = rows.find(r => r.row[5] && String(r.row[5]).toLowerCase().includes('left from salary'));
  if (!notesRow) return;
  const existing = String(notesRow.row[8] || '').trim();
  if (!existing) return;
  const filtered = existing.split(',').map(e => e.trim()).filter(e => e.toLowerCase() !== vendorName.trim().toLowerCase());
  await writeCell(sheetId, 'Totals', notesRow.rowNum, 8, safeText(filtered.join(', ')), accessToken);
}

export async function renameRandomExpenseNote(sheetId, oldName, newName, accessToken) {
  const range = encodeURIComponent("'Totals'!I4");
  const res = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const existing = String(res?.values?.[0]?.[0] || '').trim();
  if (!existing) return;

  const updated = existing.split(',').map(e => {
    const trimmed = e.trim();
    return trimmed.toLowerCase() === oldName.trim().toLowerCase() ? newName.trim() : trimmed;
  }).join(', ');

  if (updated === existing) return;

  await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[safeText(updated)]] }),
  });
}
