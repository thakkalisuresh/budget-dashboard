/**
 * Server-side access to the dedicated "Fundient Investments" spreadsheet, for
 * the scheduled rate-watch function. The client CRUD lives in src/sheetInvest.js
 * (OAuth access token from the browser); this is the serverless mirror of the
 * two operations the rate-watch job needs — read the Accounts tab and append a
 * row to the RateWatch scan log — using the functions runtime's Drive token.
 *
 * The invest spreadsheet id is NOT the monthly template: it is provisioned by
 * the client on first Invest-tab open and stored in UserSettings.investSheetId,
 * which getUserSettings() reads server-side.
 */
import { getAccessToken } from './_drive.mjs';
import { getUserSettings } from './_sheets.mjs';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function investRequest(sheetId, path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}/${sheetId}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Invest Sheets API (${res.status}): ${err.error?.message || 'unknown'}`);
  }
  return res.json();
}

/** The investments spreadsheet id, or null if the Invest tab was never opened. */
export async function getInvestSheetId() {
  const settings = await getUserSettings().catch(() => ({}));
  return settings?.investSheetId || null;
}

/** Read the Accounts tab (same column order as src/sheetInvest.js). */
export async function fetchInvestAccounts(sheetId) {
  const range = encodeURIComponent("'Accounts'!A2:H50");
  const json = await investRequest(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  return (json.values || [])
    .map(r => ({
      id: String(r[0] || ''),
      name: String(r[1] || ''),
      type: String(r[2] || ''),
      institution: String(r[3] || ''),
      apy: Number(r[4]) || 0,
      balance: Number(r[5]) || 0,
      balanceAsOf: String(r[6] || ''),
      goal: Number(r[7]) || 0,
    }))
    .filter(a => a.id);
}

/**
 * Append one scan row to the RateWatch tab. detailsJson carries both the
 * alternative-rate list and any held-bank advertised-change proposals, in the
 * { alternatives, proposals } shape src/sheetInvest.js#fetchRateWatch reads.
 */
export async function appendRateWatchRow(sheetId, { scanDate, bestBank, bestApy, yourBestApy, delta, alternatives = [], proposals = [] }) {
  const detailsJson = JSON.stringify({ alternatives, proposals });
  const range = encodeURIComponent("'RateWatch'!A1");
  await investRequest(sheetId, `/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({
      values: [[
        String(scanDate || ''),
        String(bestBank || ''),
        Number(bestApy) || 0,
        Number(yourBestApy) || 0,
        Number(delta) || 0,
        detailsJson,
      ]],
    }),
  });
}
