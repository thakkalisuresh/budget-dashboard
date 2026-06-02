import { apiFetch } from './sheetApi.js';

const CARDS_SHEET = 'Cards Summary';
const _cardsReady = new Set();

export async function ensureCardsSummarySheet(sheetId, accessToken) {
  if (_cardsReady.has(sheetId)) return;

  const meta = await apiFetch(sheetId, '?fields=sheets.properties.title', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const exists = (meta.sheets || []).some(s => s.properties?.title === CARDS_SHEET);

  if (!exists) {
    await apiFetch(sheetId, ':batchUpdate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CARDS_SHEET } } }] }),
    });

    // Title and subtitle rows
    const headerRange = encodeURIComponent(`'${CARDS_SHEET}'!A1:A2`);
    await apiFetch(sheetId, `/values/${headerRange}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [
          ['Cards Summary'],
          ['Auto-updating from History · June 2026 onwards · Excludes edits, deletions, and undos'],
        ],
      }),
    });

    // QUERY formula — groups History by payment method (col K), summing amounts (col E)
    // Excludes: Deleted, Renamed, Edited, Undo actions; blank payment method rows (pre-June data)
    const queryRange = encodeURIComponent(`'${CARDS_SHEET}'!A4`);
    const formula = `=IFERROR(QUERY(History!A:K,"SELECT K, SUM(E), COUNT(E), MAX(J), MAX(D) WHERE K IS NOT NULL AND K <> '' AND NOT B MATCHES '(?i).*(delet|renam|undo|edited).*' GROUP BY K ORDER BY SUM(E) DESC LABEL K 'Card', SUM(E) 'Total Spend', COUNT(E) 'Transactions', MAX(J) 'Last Date', MAX(D) 'Last Vendor'"),{"No card data yet","","","",""})`;
    await apiFetch(sheetId, `/values/${queryRange}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[formula]] }),
    });
  }

  _cardsReady.add(sheetId);
}
