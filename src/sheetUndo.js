import { apiFetch, fetchRaw, writeCell, clearRowRange, appendRow } from './sheetApi.js';
import {
  SHEET_MAP, colLetter, safeText, parseAmounts, buildFormula,
  generateTransactionUUID, uuidStart,
} from './sheetHelpers.js';
import { fetchDetailRows } from './sheetDetail.js';
import { appendHistoryEntry } from './sheetHistory.js';
import { renameCategory } from './sheetCategories.js';

export async function undoHistoryEntry(sheetId, accessToken, entry) {
  const { action, category, vendor, amount, details } = entry;

  if (action === 'Added' || action === 'Receipt Scan') {
    const rows = await fetchDetailRows(category, accessToken, sheetId);
    const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
    if (row) {
      const config = SHEET_MAP[category];
      if (config) {
        await clearRowRange(sheetId, config.sheet, row.rowIndex, config.amtCol, accessToken);
      }
    }

  } else if (action === 'Updated') {
    const rows = await fetchDetailRows(category, accessToken, sheetId);
    const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
    if (row && amount != null) {
      let idx = -1;
      if (entry.uuid) {
        idx = row.uuids.findIndex(u => u === entry.uuid);
      }
      if (idx < 0) return;
      const newAmounts = row.amounts.filter((_, i) => i !== idx);
      const config = SHEET_MAP[category];
      if (config) {
        if (newAmounts.length === 0) {
          await clearRowRange(sheetId, config.sheet, row.rowIndex, config.amtCol, accessToken);
        } else {
          await writeCell(sheetId, config.sheet, row.rowIndex, config.amtCol, buildFormula(newAmounts), accessToken);
        }
      }
    }

  } else if (action === 'Edited') {
    const match = details?.match(/was:\s*\$?([\d.]+)/);
    if (match) {
      const prevAmount = parseFloat(match[1]);
      const rows = await fetchDetailRows(category, accessToken, sheetId);
      const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
      if (row) {
        const config = SHEET_MAP[category];
        if (config) await writeCell(sheetId, config.sheet, row.rowIndex, config.amtCol, prevAmount, accessToken);
      }
    }

  } else if (action === 'Deleted') {
    if (amount != null) {
      const config = SHEET_MAP[category];
      if (config) {
        const values = await fetchRaw(sheetId, config.sheet, accessToken);
        const dataRows = values.slice(1);
        const found = dataRows.findIndex(r => {
          const desc = r[config.descCol];
          return desc && String(desc).trim().toLowerCase() === vendor.toLowerCase();
        });
        if (found >= 0) {
          const sheetRow = found + 2;
          const existing = parseAmounts(dataRows[found][config.amtCol] ?? '');
          const newUUID = generateTransactionUUID(amount);
          await writeCell(sheetId, config.sheet, sheetRow, config.amtCol, buildFormula([...existing, amount]), accessToken);
          await writeCell(sheetId, config.sheet, sheetRow, uuidStart(config) + existing.length, newUUID, accessToken);
        } else {
          const now = new Date();
          const newUUID = generateTransactionUUID(amount);
          const uuidCol = uuidStart(config);
          const newRow = Array(uuidCol + 1).fill('');
          newRow[0] = now.toLocaleString('en-US', { month: 'short' });
          newRow[1] = now.getFullYear();
          newRow[config.descCol] = safeText(vendor);
          newRow[config.amtCol]  = amount;
          newRow[uuidCol]        = newUUID;

          let targetRow = -1;
          for (let i = 0; i < dataRows.length; i++) {
            const desc = dataRows[i][config.descCol];
            const amt  = dataRows[i][config.amtCol];
            const hasDesc = desc && String(desc).trim() !== '';
            const hasAmt  = amt  && String(amt).trim()  !== '';
            if (!hasDesc && !hasAmt) { targetRow = i + 2; break; }
          }

          if (targetRow >= 0) {
            const range = encodeURIComponent(`'${config.sheet}'!A${targetRow}:${colLetter(uuidCol)}${targetRow}`);
            await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ values: [newRow] }),
            });
          } else {
            const appendRange = encodeURIComponent(`'${config.sheet}'!A:${colLetter(uuidCol)}`);
            await apiFetch(sheetId, `/values/${appendRange}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ values: [newRow] }),
            });
          }
        }
      }
    }

  } else if (action === 'Renamed') {
    const match = details?.match(/^(.+?)\s*→\s*(.+)$/);
    if (match) {
      const oldName = match[1].trim();
      const rows = await fetchDetailRows(category, accessToken, sheetId);
      const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
      if (row) {
        const config = SHEET_MAP[category];
        if (config) await writeCell(sheetId, config.sheet, row.rowIndex, config.descCol, safeText(oldName), accessToken);
      }
    }

  } else if (action === 'Category Renamed') {
    const match = details?.match(/^(.+?)\s*→\s*(.+)$/);
    if (match) {
      const originalName = match[1].trim();
      const currentName  = match[2].trim();
      await renameCategory(sheetId, accessToken, { oldName: currentName, newName: originalName });
    }
  }

  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Undo',
    category,
    vendor,
    amount,
    details: `Reverted: ${action}`,
  });
}
