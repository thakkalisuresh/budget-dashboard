// sheetId is passed dynamically to every function — no module-level constant

import { getCustomCategories, removeCustomCategory, upsertCustomCategory } from './customCategories.js';
import { BUILT_IN_SHEET_MAP } from './fetchDetail.js';

// Merge static SHEET_MAP with any user-created categories stored in localStorage
function getEffectiveSheetMap() {
  return { ...SHEET_MAP, ...getCustomCategories() };
}

// Cache which spreadsheets already have a History sheet this session
const _historyReady = new Set();

export const SHEET_MAP = {
  'Grocery':       { sheet: 'Grocery',                   descCol: 2, amtCol: 3 },
  'Misc':          { sheet: 'Misc',                      descCol: 2, amtCol: 3 },
  'Eating Out':    { sheet: 'Eating Out',                 descCol: 2, amtCol: 3 },
  'Travel':        { sheet: 'Travel',                    descCol: 2, amtCol: 3 },
  'Entertainment': { sheet: 'Entertainment',             descCol: 2, amtCol: 3 },
  'Thakkali':      { sheet: 'Thakkali',                  descCol: 2, amtCol: 3 },
  'Investment':    { sheet: 'Investment',                descCol: 2, amtCol: 3 },
  'Car Payments':  { sheet: 'Car Payments',              descCol: 2, amtCol: 3 },
  'Utilities':     { sheet: 'Utilities',                 descCol: 2, amtCol: 3 },
  'Utilties':      { sheet: 'Utilities',                 descCol: 2, amtCol: 3 },
  'Rent':          { sheet: 'Rent',                      descCol: 2, amtCol: 3 },
  'Health':        { sheet: 'Health',                    descCol: 2, amtCol: 3 },
  'Moving Exp':    { sheet: 'Moving Expenses+Furniture', descCol: 2, amtCol: 3 },
  'Furniture':     { sheet: 'Moving Expenses+Furniture', descCol: 10, amtCol: 11 },
  'Holiday':       { sheet: 'Holiday',                   descCol: 2, amtCol: 3 },
  'Wi-Fi':         { sheet: 'Wi-Fi',                     descCol: 2, amtCol: 3 },
};

export const CATEGORIES = [
  'Grocery', 'Eating Out', 'Misc', 'Travel', 'Thakkali', 'Entertainment',
  'Investment', 'Car Payments', 'Utilities', 'Rent', 'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];

const colLetter = (i) => String.fromCharCode(65 + i);

// ─── Formula helpers ─────────────────────────────────────────────────────────

export function parseAmounts(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return [];
  const str = String(rawValue).replace(/[$,]/g, '').trim();
  if (str.startsWith('=')) {
    return str.slice(1).split('+').map(v => parseFloat(v.trim())).filter(v => !isNaN(v) && v > 0);
  }
  const num = parseFloat(str);
  return isNaN(num) || num <= 0 ? [] : [num];
}

export function buildFormula(amounts) {
  if (amounts.length === 0) return '';
  if (amounts.length === 1) return String(amounts[0]);
  return '=' + amounts.join('+');
}

// ─── Low-level API ────────────────────────────────────────────────────────────

async function apiFetch(sheetId, path, options = {}) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}${path}`, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchRaw(sheetId, sheetName, accessToken) {
  // Use an explicit large range instead of just the sheet name.
  // This bypasses Google Sheets Table "managed range" — cleared rows inside
  // a table are returned as [] instead of being silently omitted.
  const range = encodeURIComponent(`'${sheetName}'!A1:Z200`);
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=FORMULA`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return json.values || [];
}

async function writeCell(sheetId, sheetName, row, col, value, accessToken) {
  const cell = `${colLetter(col)}${row}`;
  const range = encodeURIComponent(`'${sheetName}'!${cell}`);
  await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[value]] }),
  });
}

/** Truly clear a full row (A→endCol) using batchClear so cells are empty, not empty-string */
async function clearRowRange(sheetId, sheetName, rowIndex, endColIndex, accessToken) {
  const range = `'${sheetName}'!A${rowIndex}:${colLetter(endColIndex)}${rowIndex}`;
  await apiFetch(sheetId, '/values:batchClear', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ranges: [range] }),
  });
}

// ─── Totals helpers ───────────────────────────────────────────────────────────

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
  // C column stores the remaining formula: ={budget}-B{rowNum}
  await writeCell(sheetId, 'Totals', rowNum, 2, `=${budget}-B${rowNum}`, accessToken);
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
  await writeCell(sheetId, 'Totals', notesRow.rowNum, 8, newText, accessToken);
}

export async function removeRandomExpenseNote(sheetId, vendorName, accessToken) {
  const rows = await fetchTotalsForEdit(sheetId, accessToken);
  const notesRow = rows.find(r => r.row[5] && String(r.row[5]).toLowerCase().includes('left from salary'));
  if (!notesRow) return;
  const existing = String(notesRow.row[8] || '').trim();
  if (!existing) return;
  const filtered = existing.split(',').map(e => e.trim()).filter(e => e.toLowerCase() !== vendorName.trim().toLowerCase());
  await writeCell(sheetId, 'Totals', notesRow.rowNum, 8, filtered.join(', '), accessToken);
}

// ─── History ──────────────────────────────────────────────────────────────────

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
    const range = encodeURIComponent("'History'!A1:H1");
    await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'Non-monthly', 'User']] }),
    });
  }
  _historyReady.add(sheetId);
}

export async function appendHistoryEntry(sheetId, accessToken, {
  action, category = '', vendor = '', amount = null, details = '', nonMonthly = false,
}) {
  try {
    await ensureHistorySheet(sheetId, accessToken);
    const timestamp = new Date().toISOString();
    let userName = '';
    try { userName = JSON.parse(localStorage.getItem('budget_auth') || '{}').name || ''; } catch {}
    const row = [timestamp, action, category, vendor, amount ?? '', details, nonMonthly ? 'Yes' : '', userName];
    const range = encodeURIComponent("'History'!A:H");
    await apiFetch(sheetId, `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
  } catch { /* never block the main operation */ }
}

export async function fetchHistory(sheetId, accessToken) {
  try {
    const range = encodeURIComponent("'History'!A:H");
    const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = json.values || [];
    if (rows.length <= 1) return [];
    return rows.slice(1).map((row, i) => ({
      id: i,
      timestamp:  row[0] || '',
      action:     row[1] || '',
      category:   row[2] || '',
      vendor:     row[3] || '',
      amount:     row[4] !== undefined && row[4] !== '' ? Number(row[4]) : null,
      details:    row[5] || '',
      nonMonthly: row[6] === 'Yes',
      user:       row[7] || '',
    })).reverse();
  } catch {
    return [];
  }
}

// ─── Undo (writes directly — no secondary history entries) ───────────────────

export async function undoHistoryEntry(sheetId, accessToken, entry) {
  const { action, category, vendor, amount, details } = entry;

  if (action === 'Added' || action === 'Receipt Scan') {
    // Delete the vendor row entirely — batchClear so the row is reusable
    const rows = await fetchDetailRows(category, accessToken, sheetId);
    const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
    if (row) {
      const config = SHEET_MAP[category];
      if (config) {
        await clearRowRange(sheetId, config.sheet, row.rowIndex, config.amtCol, accessToken);
      }
      await removeRandomExpenseNote(sheetId, vendor, accessToken);
    }

  } else if (action === 'Updated') {
    // Remove the specific amount that was added
    const rows = await fetchDetailRows(category, accessToken, sheetId);
    const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
    if (row && amount != null) {
      const idx = row.amounts.findIndex(a => Math.abs(a - amount) < 0.005);
      const newAmounts = idx >= 0 ? row.amounts.filter((_, i) => i !== idx) : row.amounts;
      const config = SHEET_MAP[category];
      if (config) {
        if (newAmounts.length === 0) {
          await clearRowRange(sheetId, config.sheet, row.rowIndex, config.amtCol, accessToken);
          await removeRandomExpenseNote(sheetId, vendor, accessToken);
        } else {
          await writeCell(sheetId, config.sheet, row.rowIndex, config.amtCol, buildFormula(newAmounts), accessToken);
        }
      }
    }

  } else if (action === 'Edited') {
    // Restore the previous amount stored in details as "was: $X.XX"
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
    // Re-add the expense at the correct row
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
          // Vendor still exists (partial delete) — append amount
          const sheetRow = found + 2;
          const existing = parseAmounts(dataRows[found][config.amtCol] ?? '');
          await writeCell(sheetId, config.sheet, sheetRow, config.amtCol, buildFormula([...existing, amount]), accessToken);
        } else {
          // Re-create the row
          const now = new Date();
          const newRow = Array(config.amtCol + 1).fill('');
          newRow[0] = now.toLocaleString('en-US', { month: 'short' });
          newRow[1] = now.getFullYear();
          newRow[config.descCol] = vendor;
          newRow[config.amtCol] = amount;
          const targetRow = dataRows.length + 2;
          const range = encodeURIComponent(`'${config.sheet}'!A${targetRow}:${colLetter(config.amtCol)}${targetRow}`);
          await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [newRow] }),
          });
        }
      }
    }

  } else if (action === 'Renamed') {
    // Parse "OldName → NewName" and rename back
    const match = details?.match(/^(.+?)\s*→\s*(.+)$/);
    if (match) {
      const oldName = match[1].trim();
      const rows = await fetchDetailRows(category, accessToken, sheetId);
      const row = rows.find(r => r.description.toLowerCase() === vendor.toLowerCase());
      if (row) {
        const config = SHEET_MAP[category];
        if (config) await writeCell(sheetId, config.sheet, row.rowIndex, config.descCol, oldName, accessToken);
      }
    }

  } else if (action === 'Category Renamed') {
    // details = "OldName → NewName", category = newName — rename back
    const match = details?.match(/^(.+?)\s*→\s*(.+)$/);
    if (match) {
      const originalName = match[1].trim();
      const currentName  = match[2].trim();
      await renameCategory(sheetId, accessToken, { oldName: currentName, newName: originalName });
    }
  }

  // Log a single Undo entry
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Undo',
    category,
    vendor,
    amount,
    details: `Reverted: ${action}`,
  });
}

// ─── Read ─────────────────────────────────────────────────────────────────────

export async function fetchDetailRows(categoryName, accessToken, sheetId) {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) return [];
  const values = await fetchRaw(sheetId, config.sheet, accessToken);
  const result = [];
  values.slice(1).forEach((row, j) => {
    const desc = row[config.descCol];
    const rawAmt = row[config.amtCol];
    if (!desc || String(desc).trim() === '') return;
    const amounts = parseAmounts(rawAmt);
    if (amounts.length === 0) return;
    result.push({ rowIndex: j + 2, description: String(desc), amounts });
  });
  return result;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function addOrUpdateExpense(
  categoryName, vendorName, amount, accessToken, sheetId, monthName,
  source = 'manual', isRandom = false,
) {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);

  const values = await fetchRaw(sheetId, config.sheet, accessToken);
  const dataRows = values.slice(1);

  let foundIndex = -1;
  for (let i = 0; i < dataRows.length; i++) {
    const desc = dataRows[i][config.descCol];
    if (desc && String(desc).trim().toLowerCase() === vendorName.trim().toLowerCase()) {
      foundIndex = i;
      break;
    }
  }

  if (foundIndex >= 0) {
    const sheetRow = foundIndex + 2;
    const currentValue = dataRows[foundIndex][config.amtCol] ?? '';
    const existing = parseAmounts(currentValue);
    await writeCell(sheetId, config.sheet, sheetRow, config.amtCol, buildFormula([...existing, amount]), accessToken);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Updated', category: categoryName, vendor: vendorName, amount, nonMonthly: isRandom,
    });
  } else {
    let month, year;
    if (monthName) {
      const parts = monthName.split(' ');
      month = parts[0];
      year = parseInt(parts[1]) || new Date().getFullYear();
    } else {
      const now = new Date();
      month = now.toLocaleString('en-US', { month: 'short' });
      year = now.getFullYear();
    }
    const newRow = Array(config.amtCol + 1).fill('');
    newRow[0] = month;
    newRow[1] = year;
    newRow[config.descCol] = vendorName;
    newRow[config.amtCol] = amount;

    // Scan for the first row where both desc and amount are empty (previously deleted row).
    // Falls back to the row right after the last row with data.
    let targetRow = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const desc = dataRows[i][config.descCol];
      const amt  = dataRows[i][config.amtCol];
      const hasDesc = desc && String(desc).trim() !== '';
      const hasAmt  = amt  && String(amt).trim()  !== '';
      if (!hasDesc && !hasAmt) { targetRow = i + 2; break; }
    }
    if (targetRow === -1) targetRow = dataRows.length + 2;
    const range = encodeURIComponent(`'${config.sheet}'!A${targetRow}:${colLetter(config.amtCol)}${targetRow}`);
    await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [newRow] }),
    });
    await appendHistoryEntry(sheetId, accessToken, {
      action: source === 'scan' ? 'Receipt Scan' : 'Added',
      category: categoryName, vendor: vendorName, amount, nonMonthly: isRandom,
    });
  }
}

export async function updateVendorName(categoryName, rowIndex, newName, accessToken, sheetId, oldName = '') {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  await writeCell(sheetId, config.sheet, rowIndex, config.descCol, newName, accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Renamed', category: categoryName, vendor: newName,
    details: oldName ? `${oldName} → ${newName}` : '',
  });
}

export async function updateVendorAmounts(
  categoryName, rowIndex, amounts, accessToken, sheetId, vendorName = '', previousTotal = null,
) {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  if (amounts.length === 0) {
    // batchClear makes cells truly empty (not empty-string) so fetchRaw sees them as [] and the row is reusable
    await clearRowRange(sheetId, config.sheet, rowIndex, config.amtCol, accessToken);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Deleted', category: categoryName, vendor: vendorName,
      amount: previousTotal, // show what was deleted
    });
  } else {
    await writeCell(sheetId, config.sheet, rowIndex, config.amtCol, buildFormula(amounts), accessToken);
    const newTotal = amounts.reduce((a, b) => a + b, 0);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Edited', category: categoryName, vendor: vendorName, amount: newTotal,
      details: previousTotal != null ? `was: $${previousTotal.toFixed(2)}` : '',
    });
  }
}

// ─── Delete a budget category ────────────────────────────────────────────────

export async function deleteCategory(sheetId, accessToken, { categoryName }) {
  // A category is custom if it is NOT in the static built-in map — reliable regardless of localStorage state
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
    // Custom: delete the entire sheet tab
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
    // Built-in: clear data rows but keep the sheet tab
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

// ─── Rename a budget category ─────────────────────────────────────────────────

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
        // Rename the tab itself
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
        // Re-point Totals B to the renamed tab
        await apiFetch(sheetId, `/values/${encodeURIComponent(`'Totals'!B${rowNum}`)}?valueInputOption=USER_ENTERED`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [[`='${newName}'!F1`]] }),
        });
      }
    } catch { /* non-fatal — tab rename best-effort */ }
  }

  // 3. Update localStorage so the new name maps to the right sheet config
  if (oldConfig) {
    const newSheet = isCustom ? newName : oldConfig.sheet; // custom tab was renamed; built-in tab stays same
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
            body: JSON.stringify({ values: [[newName]] }),
          });
          await apiFetch(sheetId, `/values/${encodeURIComponent(`'${S}'!${colLetter(a)}${r}`)}?valueInputOption=USER_ENTERED`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ values: [[`=SUMIF(Totals!A:A,"${newName}",Totals!B:B)`]] }),
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

// ─── Create detail sheet tab for a new category ──────────────────────────────

export async function createCategoryDetailSheet(sheetId, accessToken, { categoryName }) {
  // Create the new sheet tab
  await apiFetch(sheetId, ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: categoryName } } }],
    }),
  });

  // Write headers: A=Month, B=Year, C=Description, D=Amount
  const headerRange = encodeURIComponent(`'${categoryName}'!A1:D1`);
  await apiFetch(sheetId, `/values/${headerRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['Month', 'Year', 'Description', 'Amount']] }),
  });

  // Put the SUM total at F1 — Totals sheet will reference this cell
  const totalRange = encodeURIComponent(`'${categoryName}'!F1`);
  await apiFetch(sheetId, `/values/${totalRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['=SUM(D2:D1000)']] }),
  });
}

// ─── Link Totals B column to the new detail sheet ────────────────────────────

export async function linkCategoryToDetailSheet(sheetId, accessToken, { categoryName }) {
  // Find the row in Totals for this category
  const range = encodeURIComponent("'Totals'!A2:A21");
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const rows = json.values || [];
  const rowIdx = rows.findIndex(r => (r[0] || '').toLowerCase() === categoryName.toLowerCase());
  if (rowIdx === -1) throw new Error(`Category "${categoryName}" not found in Totals sheet.`);

  const rowNum = rowIdx + 2;

  // Update B{rowNum} to pull from the detail sheet total cell F1
  const bRange = encodeURIComponent(`'Totals'!B${rowNum}`);
  await apiFetch(sheetId, `/values/${bRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[`='${categoryName}'!F1`]] }),
  });
}

// ─── Add new category to 50/30/20 sheet ──────────────────────────────────────

export async function addCategoryTo503020(sheetId, accessToken, { categoryName, type }) {
  // Map type → 0-based column indices in the 50/30/20 sheet (A1:K…)
  const TYPE_COLS = {
    need:   { descCol: 0, amtCol: 1 }, // A, B
    want:   { descCol: 3, amtCol: 4 }, // D, E
    saving: { descCol: 6, amtCol: 7 }, // G, H
  };
  const cols = TYPE_COLS[type];
  if (!cols) return; // unknown type — skip silently

  const SHEET = '50/30/20';

  // Find the first empty slot in rows 2–10 of the relevant desc column
  const descColLetter = colLetter(cols.descCol);
  const range = encodeURIComponent(`'${SHEET}'!${descColLetter}2:${descColLetter}10`);
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const filled = json.values || [];
  if (filled.length >= 9) return; // all 9 slots used — skip silently

  const rowNum = filled.length + 2; // e.g. 3 filled → insert at row 5

  // Write category name
  const descCell = encodeURIComponent(`'${SHEET}'!${colLetter(cols.descCol)}${rowNum}`);
  await apiFetch(sheetId, `/values/${descCell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[categoryName]] }),
  });

  // Write formula that pulls the actual spend from the Totals sheet
  const amtCell = encodeURIComponent(`'${SHEET}'!${colLetter(cols.amtCol)}${rowNum}`);
  await apiFetch(sheetId, `/values/${amtCell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[`=SUMIF(Totals!A:A,"${categoryName}",Totals!B:B)`]] }),
  });
}

// ─── Add new budget category to Totals sheet ─────────────────────────────────

export async function addCategoryToTotals(sheetId, accessToken, { name, budget }) {
  // Read A2:A21 — only filled rows are returned, so length = next available slot
  const range = encodeURIComponent("'Totals'!A2:A21");
  const json = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const filledRows = json.values || [];

  if (filledRows.length >= 20) {
    throw new Error('No empty rows available in the Totals sheet (rows 2–21 are full).');
  }

  const rowNum = filledRows.length + 2; // e.g. 14 filled rows → insert at row 16

  // Check for duplicate name
  const existing = filledRows.map(r => (r[0] || '').toLowerCase());
  if (existing.includes(name.toLowerCase())) {
    throw new Error(`A category named "${name}" already exists.`);
  }

  // Write: A=name, B=0 (no detail sheet yet), C=budget-B formula
  const writeRange = encodeURIComponent(`'Totals'!A${rowNum}:C${rowNum}`);
  await apiFetch(sheetId, `/values/${writeRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[name, 0, `=${budget}-B${rowNum}`]] }),
  });

  return rowNum;
}
