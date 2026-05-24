import { apiFetch, writeCell } from './sheetApi.js';
import { getEffectiveSheetMap, colLetter, safeText, escapeSheetRef, escapeFormulaString } from './sheetHelpers.js';
import { appendHistoryEntry } from './sheetHistory.js';
import { BUILT_IN_SHEET_MAP } from './fetchDetail.js';
import { removeCustomCategory, upsertCustomCategory } from './customCategories.js';

export async function deleteCategory(sheetId, accessToken, { categoryName }) {
  const isCustom = !BUILT_IN_SHEET_MAP[categoryName];
  const effectiveMap = getEffectiveSheetMap();

  // 1. Find and clear the Totals row
  const range = encodeURIComponent("'Totals'!A2:C21");
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = json.values || [];
  const rowIdx = rows.findIndex(r => (r[0] || '').toLowerCase() === categoryName.toLowerCase());
  if (rowIdx !== -1) {
    const rowNum = rowIdx + 2;
    const clearRange = encodeURIComponent(`'Totals'!A${rowNum}:C${rowNum}`);
    await apiFetch(sheetId, `/values/${clearRange}:clear`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  // 2. Handle detail sheet
  const config = effectiveMap[categoryName];
  if (isCustom && config) {
    try {
      const meta = await apiFetch(sheetId, '?fields=sheets.properties', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const sheet = meta.sheets?.find(s => s.properties.title === config.sheet);
      if (sheet) {
        await apiFetch(sheetId, ':batchUpdate', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }],
          }),
        });
      }
    } catch { /* non-fatal */ }
    removeCustomCategory(categoryName);
  } else if (!isCustom && config) {
    try {
      const clearDetail = encodeURIComponent(`'${config.sheet}'!A2:Z500`);
      await apiFetch(sheetId, `/values/${clearDetail}:clear`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch { /* non-fatal */ }
  }

  // 3. Remove from 50/30/20 sheet
  try {
    const S = '50/30/20';
    const s5 = await apiFetch(sheetId, `/values/${encodeURIComponent(`'${S}'!A1:H10`)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const s5rows = s5.values || [];
    const SCOLS = [{ d: 0, a: 1 }, { d: 3, a: 4 }, { d: 6, a: 7 }];
    for (const { d, a } of SCOLS) {
      for (let i = 1; i < s5rows.length; i++) {
        if ((s5rows[i]?.[d] || '').toLowerCase() === categoryName.toLowerCase()) {
          const r = i + 1;
          await apiFetch(sheetId, `/values/${encodeURIComponent(`'${S}'!${colLetter(d)}${r}:${colLetter(a)}${r}`)}:clear`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          break;
        }
      }
    }
  } catch { /* non-fatal */ }

  // 4. Log to history
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Category Deleted',
    category: categoryName,
    details: isCustom ? 'Custom category and sheet deleted' : 'Category data cleared',
  });
}

export async function renameCategory(sheetId, accessToken, { oldName, newName }) {
  const isCustom  = !BUILT_IN_SHEET_MAP[oldName];
  const oldConfig = getEffectiveSheetMap()[oldName];

  // 1. Find the Totals row and update the name cell (A)
  const range = encodeURIComponent("'Totals'!A2:A21");
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = json.values || [];
  const rowIdx = rows.findIndex(r => (r[0] || '').toLowerCase() === oldName.toLowerCase());
  if (rowIdx === -1) throw new Error(`Category "${oldName}" not found in Totals sheet.`);

  const rowNum = rowIdx + 2;
  await apiFetch(sheetId, `/values/${encodeURIComponent(`'Totals'!A${rowNum}`)}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[newName]] }),
  });

  // 2. For custom categories: rename the detail sheet tab + fix Totals B formula
  if (isCustom && oldConfig) {
    try {
      const meta = await apiFetch(sheetId, '?fields=sheets.properties', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const tabSheet = meta.sheets?.find(s => s.properties.title === oldConfig.sheet);
      if (tabSheet) {
        await apiFetch(sheetId, ':batchUpdate', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requests: [{ updateSheetProperties: {
              properties: { sheetId: tabSheet.properties.sheetId, title: newName },
              fields: 'title',
            }}],
          }),
        });
        await apiFetch(sheetId, `/values/${encodeURIComponent(`'Totals'!B${rowNum}`)}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[`='${escapeSheetRef(newName)}'!F1`]] }),
        });
      }
    } catch { /* non-fatal — tab rename best-effort */ }
  }

  // 3. Update localStorage so the new name maps to the right sheet config
  if (oldConfig) {
    const newSheet = isCustom ? newName : oldConfig.sheet;
    upsertCustomCategory(newName, { sheet: newSheet, descCol: oldConfig.descCol, amtCol: oldConfig.amtCol });
    removeCustomCategory(oldName);
  }

  // 4. Update 50/30/20 sheet — find old name and swap in new name + formula
  try {
    const S = '50/30/20';
    const s5 = await apiFetch(sheetId, `/values/${encodeURIComponent(`'${S}'!A1:H10`)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const s5rows = s5.values || [];
    const SCOLS = [{ d: 0, a: 1 }, { d: 3, a: 4 }, { d: 6, a: 7 }];
    for (const { d, a } of SCOLS) {
      for (let i = 1; i < s5rows.length; i++) {
        if ((s5rows[i]?.[d] || '').toLowerCase() === oldName.toLowerCase()) {
          const r = i + 1;
          await apiFetch(sheetId, `/values/${encodeURIComponent(`'${S}'!${colLetter(d)}${r}`)}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[safeText(newName)]] }),
          });
          await apiFetch(sheetId, `/values/${encodeURIComponent(`'${S}'!${colLetter(a)}${r}`)}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[`=SUMIF(Totals!A:A,"${escapeFormulaString(newName)}",Totals!B:B)`]] }),
          });
          break;
        }
      }
    }
  } catch { /* non-fatal */ }

  // 5. Log to history
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Category Renamed',
    category: newName,
    details: `${oldName} → ${newName}`,
  });
}

export async function createCategoryDetailSheet(sheetId, accessToken, { categoryName }) {
  await apiFetch(sheetId, ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: categoryName } } }],
    }),
  });

  const headerRange = encodeURIComponent(`'${categoryName}'!A1:E1`);
  await apiFetch(sheetId, `/values/${headerRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['Month', 'Year', 'Date', 'Description', 'Amount']] }),
  });

  const totalRange = encodeURIComponent(`'${categoryName}'!F1`);
  await apiFetch(sheetId, `/values/${totalRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['=SUM(E2:E1000)']] }),
  });
}

export async function linkCategoryToDetailSheet(sheetId, accessToken, { categoryName }) {
  const range = encodeURIComponent("'Totals'!A2:A21");
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = json.values || [];
  const rowIdx = rows.findIndex(r => (r[0] || '').toLowerCase() === categoryName.toLowerCase());
  if (rowIdx === -1) throw new Error(`Category "${categoryName}" not found in Totals sheet.`);

  const rowNum = rowIdx + 2;
  const bRange = encodeURIComponent(`'Totals'!B${rowNum}`);
  await apiFetch(sheetId, `/values/${bRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[`='${escapeSheetRef(categoryName)}'!F1`]] }),
  });
}

export async function addCategoryTo503020(sheetId, accessToken, { categoryName, type }) {
  const TYPE_COLS = {
    need:   { descCol: 0, amtCol: 1 },
    want:   { descCol: 3, amtCol: 4 },
    saving: { descCol: 6, amtCol: 7 },
  };
  const cols = TYPE_COLS[type];
  if (!cols) return;

  const SHEET = '50/30/20';
  const descColLetter = colLetter(cols.descCol);
  const range = encodeURIComponent(`'${SHEET}'!${descColLetter}2:${descColLetter}10`);
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const filled = json.values || [];
  if (filled.length >= 9) return;

  const rowNum = filled.length + 2;

  const descCell = encodeURIComponent(`'${SHEET}'!${colLetter(cols.descCol)}${rowNum}`);
  await apiFetch(sheetId, `/values/${descCell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[safeText(categoryName)]] }),
  });

  const amtCell = encodeURIComponent(`'${SHEET}'!${colLetter(cols.amtCol)}${rowNum}`);
  await apiFetch(sheetId, `/values/${amtCell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[`=SUMIF(Totals!A:A,"${escapeFormulaString(categoryName)}",Totals!B:B)`]] }),
  });
}

export async function addCategoryToTotals(sheetId, accessToken, { name, budget }) {
  const range = encodeURIComponent("'Totals'!A2:A21");
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const filledRows = json.values || [];

  if (filledRows.length >= 20) {
    throw new Error('No empty rows available in the Totals sheet (rows 2–21 are full).');
  }

  const rowNum = filledRows.length + 2;

  const existing = filledRows.map(r => (r[0] || '').toLowerCase());
  if (existing.includes(name.toLowerCase())) {
    throw new Error(`A category named "${name}" already exists.`);
  }

  const writeRange = encodeURIComponent(`'Totals'!A${rowNum}:C${rowNum}`);
  await apiFetch(sheetId, `/values/${writeRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[safeText(name), 0, `=${Number(budget) || 0}-B${rowNum}`]] }),
  });

  return rowNum;
}
