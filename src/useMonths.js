import { useState, useEffect, useCallback } from 'react';
import { SHEET_MAP } from './sheetsApi.js';

const TEMPLATE_ID = import.meta.env.VITE_TEMPLATE_SHEET_ID;

/** Read the Months registry from the template sheet */
async function fetchMonths(accessToken) {
  const range = encodeURIComponent("'Months'!A2:B50");
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error('Failed to load months');
  const { values = [] } = await res.json();
  const months = values
    .filter(r => r[0] && r[1])
    .map(r => ({ name: String(r[0]), sheetId: String(r[1]) }));

  // Sort newest first — parse "April 2026" into a comparable date
  months.sort((a, b) => {
    const toDate = name => {
      try { return new Date(`${name} 1`).getTime(); } catch { return 0; }
    };
    return toDate(b.name) - toDate(a.name);
  });

  return months;
}

/** Copy the template sheet via Drive API, returns new sheet ID */
async function copyTemplate(newName, accessToken) {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${TEMPLATE_ID}/copy`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || 'Failed to copy template');
  }
  return (await res.json()).id;
}


/**
 * Share a Google Sheet file with a list of email addresses (writer role).
 * Used so all household members can access every month sheet.
 * Failures are non-fatal — the month is still usable by the creator.
 */
export async function shareSheetWithUsers(fileId, emails, accessToken) {
  const valid = emails.map(e => e.trim().toLowerCase()).filter(e => e.includes('@'));
  await Promise.allSettled(
    valid.map(email =>
      fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }),
      })
    )
  );
}

/** Delete the "Months" tab from the newly-created sheet */
async function deleteMonthsTab(newSheetId, accessToken) {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${newSheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!metaRes.ok) return;
  const meta = await metaRes.json();
  const monthsSheet = (meta.sheets || []).find(s => s.properties?.title === 'Months');
  if (!monthsSheet) return;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${newSheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: monthsSheet.properties.sheetId } }] }),
    }
  );
}

/**
 * Update column A (month) and column B (year) in all category tabs of the
 * newly-created sheet so they reflect the correct month name and year.
 */
async function updateMonthColumns(newSheetId, monthName, accessToken) {
  const parts = monthName.split(' ');
  const month = parts[0];       // e.g. "May"
  const year  = parts[1] || ''; // e.g. "2026"

  // Unique sheet tab names from SHEET_MAP
  const uniqueSheets = [...new Set(Object.values(SHEET_MAP).map(c => c.sheet))];

  for (const sheetName of uniqueSheets) {
    try {
      // Read existing rows
      const range = encodeURIComponent(`'${sheetName}'`);
      const res = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${newSheetId}/values/${range}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!res.ok) continue;
      const { values = [] } = await res.json();

      // Find data rows (skip header row 0) that have content beyond columns A/B
      const dataRows = values.slice(1);
      const updates = [];
      dataRows.forEach((row, i) => {
        const hasContent = row.some((cell, ci) => ci >= 2 && cell !== '' && cell != null);
        if (!hasContent) return;
        const rowNumber = i + 2; // 1-indexed, +1 for header
        updates.push({
          range: `'${sheetName}'!A${rowNumber}:B${rowNumber}`,
          values: [[month, year]],
        });
      });

      if (updates.length === 0) continue;

      // Batch update all month/year cells in this tab
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${newSheetId}/values:batchUpdate`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
        }
      );
    } catch (e) {
      console.warn(`updateMonthColumns: skipped ${sheetName}`, e);
    }
  }
}

/** Clear the non-monthly notes cell (Totals!I4) so stale template data doesn't carry over */
async function clearNotesCell(sheetId, accessToken) {
  try {
    const range = encodeURIComponent("'Totals'!I4");
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}:clear`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      }
    );
  } catch { /* non-critical — don't block month creation */ }
}

/** Append a new month entry to the Months registry */
async function appendMonthEntry(name, sheetId, accessToken) {
  const range = encodeURIComponent("'Months'!A:B");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[name, sheetId]] }),
    }
  );
  if (!res.ok) throw new Error('Failed to register new month');
}

/**
 * Remove a month entry from the Months registry.
 * Finds the row by name and clears it (does NOT delete the Google Sheet itself).
 */
async function removeMonthEntry(monthName, accessToken) {
  const range = encodeURIComponent("'Months'!A2:B50");
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}/values/${range}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) throw new Error('Failed to read months registry');
  const { values = [] } = await res.json();

  const rowIndex = values.findIndex(r => r[0]?.toLowerCase() === monthName.toLowerCase());
  if (rowIndex === -1) return; // not found — nothing to do

  const sheetRow = rowIndex + 2; // +1 for header, +1 for 1-indexing
  const clearRange = encodeURIComponent(`'Months'!A${sheetRow}:B${sheetRow}`);
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${TEMPLATE_ID}/values/${clearRange}:clear`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    }
  );
}

export function useMonths(accessToken) {
  const [months, setMonths]   = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const list = await fetchMonths(accessToken);
      setMonths(list);
    } catch (e) {
      console.error('useMonths:', e);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  // All emails that should have access — read from env so they match the allowlist
  const allowedEmails = (import.meta.env.VITE_ALLOWED_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

  /** Create a new month: copy template → delete Months tab → update month columns → clear stale notes → share → register */
  const createMonth = async (name) => {
    const newSheetId = await copyTemplate(name, accessToken);
    await deleteMonthsTab(newSheetId, accessToken);
    await updateMonthColumns(newSheetId, name, accessToken);
    await clearNotesCell(newSheetId, accessToken);
    // Share with all household members so everyone can access the new month
    await shareSheetWithUsers(newSheetId, allowedEmails, accessToken);
    await appendMonthEntry(name, newSheetId, accessToken);
    const newMonth = { name, sheetId: newSheetId };
    setMonths(prev => [...prev, newMonth]);
    return newMonth;
  };

  /** Re-share every registered month with all allowed users (fixes permission gaps for existing months) */
  const shareAllMonths = async () => {
    await Promise.allSettled(
      months.map(m => shareSheetWithUsers(m.sheetId, allowedEmails, accessToken))
    );
    // Also share the template itself
    await shareSheetWithUsers(TEMPLATE_ID, allowedEmails, accessToken);
  };

  /** Remove a month from the registry (does not delete the Google Sheet) */
  const deleteMonth = async (monthName) => {
    await removeMonthEntry(monthName, accessToken);
    setMonths(prev => prev.filter(m => m.name !== monthName));
  };

  return { months, loading, createMonth, deleteMonth, shareAllMonths, reload: load };
}
