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

/* ── Generic tab helpers (MfHoldings pipeline) ───────────────────────────────
 * The scheduled job can run before the user ever opens the Invest tab on a
 * sheet that predates these tabs, so the server creates missing tabs itself
 * (same header rows as src/sheetInvest.js INVEST_TABS — a test pins them equal).
 * Every write is RAW: AMC-sourced text (names) is never interpreted as a
 * formula, and ISO dates / ISINs stay literal strings.
 */

/** Create any missing tab (with its header row). `tabs` = { title: headers[] }. */
export async function ensureInvestTabsServer(sheetId, tabs) {
  const meta = await investRequest(sheetId, '?fields=sheets.properties.title');
  const have = new Set((meta.sheets || []).map(s => s.properties?.title).filter(Boolean));
  const missing = Object.keys(tabs).filter(t => !have.has(t));
  if (!missing.length) return [];
  await investRequest(sheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({ requests: missing.map(title => ({ addSheet: { properties: { title } } })) }),
  });
  for (const title of missing) {
    const range = encodeURIComponent(`'${title}'!A1`);
    await investRequest(sheetId, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [tabs[title]] }),
    });
  }
  return missing;
}

/** Read the data rows (below the header) of several tabs in one call. `specs` = [{ title, width, maxRows }]. */
export async function readInvestTabs(sheetId, specs) {
  const qs = specs.map(s => `ranges=${encodeURIComponent(`'${s.title}'!A2:${colName(s.width)}${(s.maxRows || 5000) + 1}`)}`).join('&');
  const json = await investRequest(sheetId, `/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);
  return specs.map((_, i) => json.valueRanges?.[i]?.values || []);
}

/**
 * Replace a tab's data rows (everything below the header) with `values`.
 * Writes the new block first, then clears any leftover tail, so a failure
 * midway leaves old-or-new rows, never an empty tab.
 */
export async function replaceInvestRows(sheetId, title, width, values, maxRows = 5000) {
  if (values.length > maxRows) throw new Error(`${title}: ${values.length} rows exceeds the ${maxRows}-row cap`);
  if (values.length) {
    const range = encodeURIComponent(`'${title}'!A2:${colName(width)}${values.length + 1}`);
    await investRequest(sheetId, `/values/${range}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values }) });
  }
  const tail = encodeURIComponent(`'${title}'!A${values.length + 2}:${colName(width)}${maxRows + 1}`);
  await investRequest(sheetId, `/values/${tail}:clear`, { method: 'POST', body: '{}' });
}

/** 1 → A … 26 → Z (tabs here are < 26 columns wide). */
function colName(n) {
  return String.fromCharCode(64 + n);
}
