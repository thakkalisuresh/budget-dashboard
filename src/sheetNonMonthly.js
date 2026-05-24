import { apiFetch } from './sheetApi.js';
import { safeText, getAllCategoryNames, fuzzyNamesMatch } from './sheetHelpers.js';
import { fetchDetailRows } from './sheetDetail.js';

const NON_MONTHLY_SHEET = 'Non-Monthly Expenses';
const _nonMonthlyReady = new Set();

async function ensureNonMonthlySheet(sheetId, accessToken) {
  if (_nonMonthlyReady.has(sheetId)) return;
  const meta = await apiFetch(sheetId, '?fields=sheets.properties.title', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const exists = (meta.sheets || []).some(s => s.properties?.title === NON_MONTHLY_SHEET);
  if (!exists) {
    await apiFetch(sheetId, ':batchUpdate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: NON_MONTHLY_SHEET } } }] }),
    });
    const headerRange = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A1:C1`);
    await apiFetch(sheetId, `/values/${headerRange}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Vendor', 'Amount', 'Date']] }),
    });
  }
  _nonMonthlyReady.add(sheetId);
}

export async function fetchNonMonthlyItems(sheetId, accessToken) {
  try {
    await ensureNonMonthlySheet(sheetId, accessToken);
    const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A1:C200`);
    const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = json.values || [];
    return rows.slice(1)
      .map((row, i) => ({ rowIndex: i + 2, vendor: row[0] || '', amount: Number(row[1]) || 0 }))
      .filter(r => r.vendor);
  } catch { return []; }
}

export async function markNonMonthly(sheetId, accessToken, vendor, amount) {
  try {
    await ensureNonMonthlySheet(sheetId, accessToken);
    const existing = await fetchNonMonthlyItems(sheetId, accessToken);
    const match = existing.find(r => r.vendor.toLowerCase() === vendor.toLowerCase());

    const date = new Date().toISOString().split('T')[0];
    if (match) {
      const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${match.rowIndex}:C${match.rowIndex}`);
      await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[safeText(vendor), amount, date]] }),
      });
    } else {
      const nextRow = existing.length + 2;
      const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${nextRow}:C${nextRow}`);
      await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[safeText(vendor), amount, date]] }),
      });
    }
  } catch (e) { console.warn('markNonMonthly failed:', e); }
}

export async function unmarkNonMonthly(sheetId, accessToken, vendor) {
  try {
    const existing = await fetchNonMonthlyItems(sheetId, accessToken);
    const match = existing.find(r => r.vendor.toLowerCase() === vendor.toLowerCase());
    if (!match) return;
    const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${match.rowIndex}:C${match.rowIndex}`);
    await apiFetch(sheetId, `/values/${range}:clear`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) { console.warn('unmarkNonMonthly failed:', e); }
}

export async function renameNonMonthly(sheetId, accessToken, oldVendor, newVendor) {
  try {
    const existing = await fetchNonMonthlyItems(sheetId, accessToken);
    const match = existing.find(r => r.vendor.toLowerCase() === oldVendor.toLowerCase());
    if (!match) return;
    const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${match.rowIndex}`);
    await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[newVendor]] }),
    });
  } catch (e) { console.warn('renameNonMonthly failed:', e); }
}

export async function migrateNonMonthlyFromI4(sheetId, accessToken) {
  const existing = await fetchNonMonthlyItems(sheetId, accessToken);
  if (existing.length > 0) return;

  const range = encodeURIComponent("'Totals'!A1:J30");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const totalsRows = json.values || [];
  const notesRow = totalsRows.find(r => r[5] && String(r[5]).toLowerCase().includes('left from salary'));
  const i4Value = String(notesRow?.[8] || '').trim();
  if (!i4Value) return;

  const vendorNames = i4Value.split(',').map(v => v.trim()).filter(Boolean);
  if (vendorNames.length === 0) return;

  const categories = getAllCategoryNames();
  const vendorAmounts = {};

  await Promise.allSettled(
    categories.map(async cat => {
      try {
        const rows = await fetchDetailRows(cat, accessToken, sheetId);
        for (const row of rows) {
          for (const vendorName of vendorNames) {
            if (fuzzyNamesMatch(row.description, vendorName)) {
              const total = row.amounts.reduce((a, b) => a + b, 0);
              if (total > 0 && !vendorAmounts[vendorName]) {
                vendorAmounts[vendorName] = total;
              }
            }
          }
        }
      } catch { /* skip failed categories */ }
    })
  );

  for (const vendorName of vendorNames) {
    await markNonMonthly(sheetId, accessToken, vendorName, vendorAmounts[vendorName] ?? 0);
  }
}
