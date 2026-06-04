import { apiFetch } from './sheetApi.js';
import { safeText, parseSheetDate } from './sheetHelpers.js';

const _historyReady = new Set();

async function ensureHistorySheet(sheetId, accessToken) {
  if (_historyReady.has(sheetId)) return;
  const meta = await apiFetch(sheetId, '?fields=sheets.properties.title', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const exists = (meta.sheets || []).some(s => s.properties?.title === 'History');
  if (!exists) {
    await apiFetch(sheetId, ':batchUpdate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: 'History' } } }] }),
    });
    const range = encodeURIComponent("'History'!A1:L1");
    await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'Reserved', 'User', 'UUID', 'TxDate', 'Payment Method', 'Booking Method']] }),
    });
  }
  _historyReady.add(sheetId);
}

export async function appendHistoryEntry(sheetId, accessToken, {
  action, category = '', vendor = '', amount = null, details = '', uuid = '', txDate = '', paymentMethod = '', bookingMethod = '',
}) {
  try {
    await ensureHistorySheet(sheetId, accessToken);
    const timestamp = new Date().toISOString();
    let userName = '';
    try {
      const raw = sessionStorage.getItem('budget_auth') || localStorage.getItem('budget_auth') || '{}';
      userName = JSON.parse(raw).name || '';
    } catch { /* ignore */ }
    const row = [
      timestamp,
      safeText(action || ''),
      safeText(category || ''),
      safeText(vendor || ''),
      amount ?? '',
      safeText(details || ''),
      '',
      safeText(userName),
      uuid || '',
      txDate || '',
      safeText(paymentMethod || ''),
      safeText(bookingMethod || ''),
    ];

    const colARange = encodeURIComponent("'History'!A:A");
    const colAData = await apiFetch(sheetId, `/values/${colARange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const nextRow = (colAData.values || []).length + 1;
    const writeRange = encodeURIComponent(`'History'!A${nextRow}:L${nextRow}`);
    await apiFetch(sheetId, `/values/${writeRange}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
  } catch (e) {
    console.warn('appendHistoryEntry failed (non-fatal):', e);
  }
}

/**
 * Update the Payment Method column (col K, index 10) of the History row
 * that matches the given UUID. Handles both web rows (uuid at index 8) and
 * bot rows (uuid at index 6). No-op if the UUID is not found.
 */
export async function updateHistoryPaymentMethod(sheetId, accessToken, uuid, newCard) {
  if (!uuid) return;
  try {
    const range = encodeURIComponent("'History'!A:L");
    const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = json.values || [];
    // i=0 is the header; start from i=1. Check web (col I = index 8) and bot (col G = index 6).
    const idx = rows.findIndex((row, i) =>
      i > 0 && ((row[8] || '') === uuid || (row[6] || '') === uuid)
    );
    if (idx < 0) return; // UUID not found — no-op
    const sheetRow = idx + 1; // 1-indexed
    const cell = encodeURIComponent(`'History'!K${sheetRow}`);
    await apiFetch(sheetId, `/values/${cell}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[safeText(newCard || '')]] }),
    });
  } catch (e) {
    console.warn('updateHistoryPaymentMethod failed (non-fatal):', e);
  }
}

export async function fetchHistory(sheetId, accessToken) {
  try {
    const range = encodeURIComponent("'History'!A:L");
    const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = json.values || [];
    if (rows.length <= 1) return [];
    return rows.slice(1).map((row, i) => ({
      id:            i,
      timestamp:     row[0] || '',
      action:        row[1] || '',
      category:      row[2] || '',
      vendor:        row[3] || '',
      amount:        row[4] !== undefined && row[4] !== '' ? Number(row[4]) : null,
      details:       row[5] || '',
      user:          row[7] || '',
      uuid:          row[8] || '',
      txDate:        parseSheetDate(row[9]),
      paymentMethod: row[10] || '',
      bookingMethod: row[11] || '',
    }))
    .filter(e => e.action)
    .reverse();
  } catch {
    return [];
  }
}
