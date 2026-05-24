import { colLetter } from './sheetHelpers.js';

export async function apiFetch(sheetId, path, options = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, options);
  if (!res.ok) {
    const status = res.status;
    if (status === 401 || status === 403) throw new Error('Access denied. Please sign in again.');
    if (status === 404) throw new Error('Spreadsheet not found. Please check your setup.');
    if (status === 429) throw new Error('Too many requests. Please wait a moment.');
    throw new Error('Failed to save. Please try again.');
  }
  return res.json();
}

export async function fetchRaw(sheetId, sheetName, accessToken) {
  const range = encodeURIComponent(`'${sheetName}'!A1:Z10000`);
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=FORMULA`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return json.values || [];
}

export async function writeCell(sheetId, sheetName, row, col, value, accessToken) {
  const cell = `${colLetter(col)}${row}`;
  const range = encodeURIComponent(`'${sheetName}'!${cell}`);
  await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[value]] }),
  });
}

export async function clearRowRange(sheetId, sheetName, rowIndex, endColIndex, accessToken) {
  const range = `'${sheetName}'!A${rowIndex}:${colLetter(endColIndex)}${rowIndex}`;
  await apiFetch(sheetId, '/values:batchClear', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ranges: [range] }),
  });
}

export async function appendRow(sheetId, sheetName, rowValues, accessToken) {
  const range = encodeURIComponent(`'${sheetName}'!A1`);
  await apiFetch(sheetId, `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [rowValues] }),
  });
}
