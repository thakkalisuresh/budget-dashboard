/**
 * Google Sheets utilities for serverless functions.
 * Serverless equivalent of sheetExpenses.js + sheetApi.js.
 * Files in lib/ are shared modules, not standalone deployed functions.
 */
import { getAccessToken, copyFile, shareWithEmails } from './_drive.mjs';

const SHEETS_API    = 'https://sheets.googleapis.com/v4/spreadsheets';
const TEMPLATE_ID   = process.env.VITE_TEMPLATE_SHEET_ID;
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

const SHEET_MAP = {
  'Grocery':       { sheet: 'Grocery' },
  'Misc':          { sheet: 'Misc' },
  'Eating Out':    { sheet: 'Eating Out' },
  'Travel':        { sheet: 'Travel' },
  'Entertainment': { sheet: 'Entertainment' },
  'Thakkali':      { sheet: 'Thakkali' },
  'Investment':    { sheet: 'Investment' },
  'Car Payments':  { sheet: 'Car Payments' },
  'Utilities':     { sheet: 'Utilities' },
  'Rent':          { sheet: 'Rent' },
  'Health':        { sheet: 'Health' },
  'Furniture':     { sheet: 'Furniture' },
  'Holiday':       { sheet: 'Holiday' },
  'Wi-Fi':         { sheet: 'Wi-Fi' },
};

function generateUUID(amount) {
  const cents  = Math.round(Math.abs(amount) * 100);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `tx_${cents}_${random}`;
}

function safeString(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const c = trimmed.charCodeAt(0);
  if (c === 0x3d || c === 0x2b || c === 0x2d || c === 0x40 ||
      c === 0x0d || c === 0x0a || c === 0x09) {
    return "'" + value;
  }
  return value;
}

async function sheetsRequest(sheetId, path, options = {}) {
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
    throw new Error(`Sheets API (${res.status}): ${err.error?.message || 'unknown'}`);
  }
  return res.json();
}

export async function getCurrentMonthSheetId(monthName) {
  if (!TEMPLATE_ID) throw new Error('VITE_TEMPLATE_SHEET_ID not configured');

  const range = encodeURIComponent("'Months'!A2:B50");
  const data = await sheetsRequest(TEMPLATE_ID, `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const rows = data.values || [];

  const target = monthName || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  for (const row of rows) {
    if (row[0] && row[1] && row[0].trim().toLowerCase() === target.trim().toLowerCase()) {
      return row[1];
    }
  }

  throw new Error(`No sheet found for month: ${target}`);
}

export async function appendExpense({ category, vendor, amount, txDate, sheetId, monthName, paymentMethod = '', channel = 'whatsapp', bookingMethod = '' }) {
  const config = SHEET_MAP[category];
  if (!config) throw new Error(`Unknown category: ${category}`);
  const channelLabel = channel === 'telegram' ? 'Telegram' : 'WhatsApp';

  const now = new Date();
  const month = monthName
    ? monthName.split(' ')[0]
    : now.toLocaleString('en-US', { month: 'short' });
  const year = monthName
    ? parseInt(monthName.split(' ')[1]) || now.getFullYear()
    : now.getFullYear();

  const dateVal = txDate || now.toISOString().slice(0, 10);
  const uuid    = generateUUID(amount);

  // V2 schema: Travel/Holiday get 8 cols (col G = bookingMethod, col H = uuid);
  // all other categories get 7 cols (col G = uuid). UUID is always last.
  const isTravelCat = category === 'Travel' || category === 'Holiday';
  const row = isTravelCat
    ? [month, year, dateVal, safeString(vendor), amount, safeString(paymentMethod || ''), safeString(bookingMethod || ''), uuid]
    : [month, year, dateVal, safeString(vendor), amount, safeString(paymentMethod || ''), uuid];

  // Find the last row that has actual data (vendor or amount) rather than using
  // values.length, which counts formula-only rows returned by the FORMULA render
  // mode even when they appear visually empty (e.g. =SUM(...) in a totals row).
  const dataRange = encodeURIComponent(`'${config.sheet}'!A:H`);
  const rowsData  = await sheetsRequest(sheetId, `/values/${dataRange}?valueRenderOption=FORMULA`);
  const rows      = rowsData.values || [];
  let lastDataIdx = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    const r = rows[i];
    if (r && (r[3] || r[4])) { lastDataIdx = i; break; }
  }
  const nextRow = lastDataIdx + 2;
  const endCol    = isTravelCat ? 'H' : 'G';
  const rowRange  = encodeURIComponent(`'${config.sheet}'!A${nextRow}:${endCol}${nextRow}`);
  // RAW preserves the date string as text so Sheets doesn't convert it to a serial number.
  await sheetsRequest(sheetId, `/values/${rowRange}?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [row] }),
  });

  await appendHistory(sheetId, {
    action: `${channelLabel} Receipt`,
    category,
    vendor,
    amount,
    uuid,
    txDate: dateVal,
    paymentMethod,
    channel,
    bookingMethod,
  });

  return { uuid, row };
}

async function appendHistory(sheetId, { action, category, vendor, amount, uuid, txDate, details, paymentMethod, channel = 'whatsapp', bookingMethod = '' }) {
  const now = new Date().toISOString();
  const channelLabel = channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  // Bot 8-col layout preserved (uuid@6, user@7 — getRecentExpenses detects this),
  // padded so paymentMethod lands at col K (index 10) for the Cards tab/summary.
  const row = [
    now,
    safeString(action),
    safeString(category),
    safeString(vendor || ''),
    amount,
    details || `Receipt via ${channelLabel}`,
    uuid || '',
    `${channel}-bot`,
    '',
    txDate || '',
    safeString(paymentMethod || ''),
    safeString(bookingMethod || ''),
  ];

  const range = encodeURIComponent("'History'!A1");
  try {
    await sheetsRequest(sheetId, `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: JSON.stringify({ values: [row] }),
    });
  } catch (e) {
    console.warn('History append failed (non-fatal):', e.message);
  }
}

export async function getTotals(sheetId) {
  const range = encodeURIComponent("'Totals'!A2:G21");
  const data = await sheetsRequest(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  const rows = data.values || [];

  const categories = [];
  let salary = null;
  let leftFromSalary = null;

  for (const row of rows) {
    const name      = row[0];
    const spent     = typeof row[1] === 'number' ? row[1] : 0;
    const remaining = typeof row[2] === 'number' ? row[2] : 0;
    const label     = (row[5] || '').toString().toLowerCase();
    const labelVal  = typeof row[6] === 'number' ? row[6] : null;

    if (label.includes('salary received') && labelVal != null) {
      salary = labelVal;
    }
    if (label.includes('left from salary') && labelVal != null) {
      leftFromSalary = labelVal;
    }

    if (name && typeof name === 'string' && name.trim().length > 0) {
      categories.push({
        name: name.trim(),
        spent: Math.round(spent * 100) / 100,
        remaining: Math.round(remaining * 100) / 100,
        budget: Math.round((spent + remaining) * 100) / 100,
      });
    }
  }

  return { categories, salary, leftFromSalary };
}

export async function getRecentExpenses(sheetId, limit = 10) {
  const range = encodeURIComponent("'History'!A:J");
  const data = await sheetsRequest(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  const rows = data.values || [];
  if (rows.length <= 1) return [];

  // The History tab holds two incompatible row layouts in the same sheet:
  //   • web app (10 cols): … Details, Reserved, User, UUID(8), TxDate(9)
  //   • bot      (8 cols): … Details, UUID(6), 'whatsapp-bot'  (no TxDate)
  // Detect per row: a web row has the uuid at index 8; a bot row only reaches
  // index 6 (so row[8] is undefined and we fall back to index 6).
  const mapped = rows.slice(1)
    .map(row => {
      const isWebLayout = row[8] != null && row[8] !== '';
      return {
        timestamp: row[0] || '',
        action:    row[1] || '',
        category:  row[2] || '',
        vendor:    row[3] || '',
        amount:    typeof row[4] === 'number' ? row[4] : null,
        uuid:      (isWebLayout ? row[8] : row[6]) || '',
        txDate:    isWebLayout ? (row[9] || '') : '',
      };
    })
    // A real expense entry always carries a uuid + amount; admin actions
    // (budget/category changes, renames, deletes) never write a uuid.
    .filter(e => e.amount && e.uuid)
    .reverse();

  // The History log is append-only, so an edited expense appears as a later
  // row with the same uuid. Keep the newest occurrence per uuid.
  const seen = new Set();
  const deduped = [];
  for (const e of mapped) {
    if (seen.has(e.uuid)) continue;
    seen.add(e.uuid);
    deduped.push(e);
  }
  return deduped.slice(0, limit);
}

export async function deleteExpenseByUUID({ category, uuid, sheetId }) {
  const config = SHEET_MAP[category];
  if (!config) throw new Error(`Unknown category: ${category}`);

  const range = encodeURIComponent(`'${config.sheet}'!F:F`);
  const data = await sheetsRequest(sheetId, `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const rows = data.values || [];

  let rowIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === uuid) {
      rowIndex = i;
      break;
    }
  }

  if (rowIndex === -1) throw new Error(`Row with UUID ${uuid} not found`);

  const meta = await sheetsRequest(sheetId, '?fields=sheets.properties');
  const sheet = meta.sheets.find(s => s.properties.title === config.sheet);
  if (!sheet) throw new Error(`Sheet tab not found: ${config.sheet}`);

  await sheetsRequest(sheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    }),
  });
}

export async function writeSalaryAmount(sheetId, amount) {
  const range = encodeURIComponent("'Totals'!A1:J30");
  const data = await sheetsRequest(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  const rows = data.values || [];

  let salaryRowNum = -1;
  for (let i = 0; i < rows.length; i++) {
    const label = (rows[i][5] || '').toString().toLowerCase();
    if (label.includes('salary received')) {
      salaryRowNum = i + 1;
      break;
    }
  }
  if (salaryRowNum < 0) throw new Error('Salary row not found in Totals');

  const cell = encodeURIComponent(`'Totals'!G${salaryRowNum}`);
  await sheetsRequest(sheetId, `/values/${cell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[amount]] }),
  });

  await appendHistory(sheetId, {
    action: 'Budget Updated',
    category: 'Salary',
    amount,
    details: `Salary set to $${Number(amount).toFixed(2)} via WhatsApp`,
  });
}

export async function writeBudgetAmount(sheetId, categoryName, amount) {
  const range = encodeURIComponent("'Totals'!A2:C21");
  const data = await sheetsRequest(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  const rows = data.values || [];

  let catRowNum = -1;
  for (let i = 0; i < rows.length; i++) {
    const name = (rows[i][0] || '').toString().trim();
    if (name.toLowerCase() === categoryName.trim().toLowerCase()) {
      catRowNum = i + 2;
      break;
    }
  }
  if (catRowNum < 0) throw new Error(`Category "${categoryName}" not found in Totals`);

  const cell = encodeURIComponent(`'Totals'!C${catRowNum}`);
  await sheetsRequest(sheetId, `/values/${cell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[`=${Number(amount) || 0}-B${catRowNum}`]] }),
  });

  await appendHistory(sheetId, {
    action: 'Budget Updated',
    category: categoryName,
    amount,
    details: `Budget set to $${Number(amount).toFixed(2)} via WhatsApp`,
  });
}

function escapeSheetRef(name) {
  return String(name).replace(/'/g, "''");
}

function escapeFormulaString(name) {
  return String(name).replace(/"/g, '""');
}

export async function addCategory(sheetId, { name, budget, type }) {
  // Step 1: Create detail sheet tab with headers + SUM formula
  await sheetsRequest(sheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: name } } }],
    }),
  });

  const headerRange = encodeURIComponent(`'${escapeSheetRef(name)}'!A1:E1`);
  await sheetsRequest(sheetId, `/values/${headerRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [['Month', 'Year', 'Date', 'Description', 'Amount']] }),
  });

  const sumRange = encodeURIComponent(`'${escapeSheetRef(name)}'!F1`);
  await sheetsRequest(sheetId, `/values/${sumRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [['=SUM(E2:E1000)']] }),
  });

  // Step 2: Add row to Totals (name, 0 spent, =budget-B{row} remaining)
  const totalsRange = encodeURIComponent("'Totals'!A2:A21");
  const totalsData = await sheetsRequest(sheetId, `/values/${totalsRange}?valueRenderOption=FORMATTED_VALUE`);
  const filledRows = totalsData.values || [];

  if (filledRows.length >= 20) throw new Error('Totals sheet is full (max 20 categories).');

  const existing = filledRows.map(r => (r[0] || '').toLowerCase());
  if (existing.includes(name.toLowerCase())) throw new Error(`Category "${name}" already exists.`);

  const rowNum = filledRows.length + 2;
  const writeRange = encodeURIComponent(`'Totals'!A${rowNum}:C${rowNum}`);
  await sheetsRequest(sheetId, `/values/${writeRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[safeString(name), 0, `=${Number(budget) || 0}-B${rowNum}`]] }),
  });

  // Step 3: Link detail sheet to Totals col B (spent = detail sheet total)
  const linkRange = encodeURIComponent(`'Totals'!B${rowNum}`);
  await sheetsRequest(sheetId, `/values/${linkRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    body: JSON.stringify({ values: [[`='${escapeSheetRef(name)}'!F1`]] }),
  });

  // Step 4: Add to 50/30/20 sheet
  const TYPE_COLS = {
    need:   { desc: 'A', amt: 'B' },
    want:   { desc: 'D', amt: 'E' },
    saving: { desc: 'G', amt: 'H' },
  };
  const cols = TYPE_COLS[type || 'want'];
  if (cols) {
    const colRange = encodeURIComponent(`'50/30/20'!${cols.desc}2:${cols.desc}10`);
    const colData = await sheetsRequest(sheetId, `/values/${colRange}?valueRenderOption=FORMATTED_VALUE`).catch(() => ({ values: [] }));
    const filled = colData.values || [];
    if (filled.length < 9) {
      const r = filled.length + 2;
      const descCell = encodeURIComponent(`'50/30/20'!${cols.desc}${r}`);
      await sheetsRequest(sheetId, `/values/${descCell}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({ values: [[safeString(name)]] }),
      });
      const amtCell = encodeURIComponent(`'50/30/20'!${cols.amt}${r}`);
      await sheetsRequest(sheetId, `/values/${amtCell}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        body: JSON.stringify({ values: [[`=SUMIF(Totals!A:A,"${escapeFormulaString(name)}",Totals!B:B)`]] }),
      });
    }
  }

  // Step 5: Update UserSettings in template to persist custom category
  await addCategoryToUserSettings(name);

  await appendHistory(sheetId, {
    action: 'Category Added',
    category: name,
    amount: budget,
    details: `Custom category "${name}" added via WhatsApp (${type || 'want'}, budget $${Number(budget).toFixed(2)})`,
  });
}

// ── Month creation helpers ─────────────────────────────────────────────────

async function deleteMonthsTabFromSheet(sheetId) {
  const meta = await sheetsRequest(sheetId, '?fields=sheets.properties');
  const monthsSheet = (meta.sheets || []).find(s => s.properties?.title === 'Months');
  if (!monthsSheet) return;
  await sheetsRequest(sheetId, ':batchUpdate', {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ deleteSheet: { sheetId: monthsSheet.properties.sheetId } }],
    }),
  });
}

async function updateMonthColumnsInSheet(newSheetId, monthName) {
  const parts = monthName.split(' ');
  const month = parts[0];
  const year = parts[1] || '';
  const uniqueSheets = [...new Set(Object.values(SHEET_MAP).map(c => c.sheet))];

  for (const sheetName of uniqueSheets) {
    try {
      const range = encodeURIComponent(`'${sheetName}'`);
      const data = await sheetsRequest(newSheetId, `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
      const rows = data.values || [];

      const updates = [];
      rows.slice(1).forEach((row, i) => {
        const hasContent = row.some((cell, ci) => ci >= 2 && cell !== '' && cell != null);
        if (!hasContent) return;
        updates.push({
          range: `'${sheetName}'!A${i + 2}:B${i + 2}`,
          values: [[month, year]],
        });
      });

      if (updates.length === 0) continue;

      await sheetsRequest(newSheetId, '/values:batchUpdate', {
        method: 'POST',
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }),
      });
    } catch (e) {
      console.warn(`updateMonthColumns: skipped ${sheetName}`, e.message);
    }
  }
}

async function clearNotesCellInSheet(sheetId) {
  try {
    const range = encodeURIComponent("'Totals'!I4");
    await sheetsRequest(sheetId, `/values/${range}:clear`, { method: 'POST' });
  } catch { /* non-critical */ }
}

const TRAVEL_SHEETS = new Set(['Travel', 'Holiday']);

async function writeV2HeadersToSheet(sheetId) {
  const uniqueSheets = [...new Set(Object.values(SHEET_MAP).map(c => c.sheet))];
  const data = uniqueSheets.map(sheetName => {
    const isTravel = TRAVEL_SHEETS.has(sheetName);
    return {
      range: isTravel ? `'${sheetName}'!A1:H1` : `'${sheetName}'!A1:G1`,
      values: [isTravel
        ? ['Month', 'Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'Booking Method', 'UUID']
        : ['Month', 'Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'UUID']],
    };
  });
  try {
    await sheetsRequest(sheetId, '/values:batchUpdate', {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    });
    // Clear stale template rows 2-20 so named table definitions don't push
    // new :append writes past the template rows.
    const clearRanges = uniqueSheets.map(s => `'${s}'!A2:H20`);
    await sheetsRequest(sheetId, '/values:batchClear', {
      method: 'POST',
      body: JSON.stringify({ ranges: clearRanges }),
    });
  } catch (e) {
    console.warn('writeV2HeadersToSheet: failed (non-fatal)', e.message);
  }
}

async function registerMonth(monthName, sheetId) {
  const range = encodeURIComponent("'Months'!A:B");
  await sheetsRequest(TEMPLATE_ID, `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [[monthName, sheetId]] }),
  });
}

export async function checkMonthExists(monthName) {
  try {
    await getCurrentMonthSheetId(monthName);
    return true;
  } catch {
    return false;
  }
}

export async function getLatestMonthData() {
  if (!TEMPLATE_ID) throw new Error('VITE_TEMPLATE_SHEET_ID not configured');
  const range = encodeURIComponent("'Months'!A2:B50");
  const data = await sheetsRequest(TEMPLATE_ID, `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const rows = (data.values || []).filter(r => r[0] && r[1]);

  if (rows.length === 0) return null;

  rows.sort((a, b) => {
    const toDate = name => { try { return new Date(`${name} 1`).getTime(); } catch { return 0; } };
    return toDate(b[0]) - toDate(a[0]);
  });

  const totals = await getTotals(rows[0][1]);

  return {
    monthName: rows[0][0],
    sheetId: rows[0][1],
    salary: totals.salary,
    budgets: totals.categories,
  };
}

export async function getUserSettings() {
  if (!TEMPLATE_ID || ALLOWED_EMAILS.length === 0) return {};
  const userId = ALLOWED_EMAILS[0];
  const range = encodeURIComponent("'UserSettings'!A:B");
  const data = await sheetsRequest(TEMPLATE_ID, `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
  const rows = data.values || [];
  const row = rows.find(r => r[0] === userId);
  if (!row) return {};
  try { return JSON.parse(row[1] || '{}'); } catch { return {}; }
}

export async function createMonth({ monthName, salary, budgetChanges }) {
  const { id: newSheetId } = await copyFile(TEMPLATE_ID, monthName);

  await deleteMonthsTabFromSheet(newSheetId);
  await updateMonthColumnsInSheet(newSheetId, monthName);
  await writeV2HeadersToSheet(newSheetId);
  await clearNotesCellInSheet(newSheetId);

  const settings = await getUserSettings();
  const customCats = settings.customCategories || [];
  for (const catName of customCats) {
    if (!SHEET_MAP[catName]) {
      try {
        const catBudget = budgetChanges?.[catName] || 0;
        await addCategory(newSheetId, { name: catName, budget: catBudget, type: 'want' });
      } catch (e) {
        console.warn(`createMonth: custom category "${catName}" failed:`, e.message);
      }
    }
  }

  if (salary && salary > 0) {
    await writeSalaryAmount(newSheetId, salary);
  }

  if (budgetChanges) {
    for (const [cat, amt] of Object.entries(budgetChanges)) {
      try {
        await writeBudgetAmount(newSheetId, cat, amt);
      } catch (e) {
        console.warn(`createMonth: budget for "${cat}" failed:`, e.message);
      }
    }
  }

  await shareWithEmails(newSheetId, ALLOWED_EMAILS);
  await registerMonth(monthName, newSheetId);

  return { sheetId: newSheetId };
}

async function addCategoryToUserSettings(categoryName) {
  if (!TEMPLATE_ID || ALLOWED_EMAILS.length === 0) return;
  const userId = ALLOWED_EMAILS[0];

  try {
    const range = encodeURIComponent("'UserSettings'!A:B");
    const data = await sheetsRequest(TEMPLATE_ID, `/values/${range}?valueRenderOption=FORMATTED_VALUE`);
    const rows = data.values || [];

    const rowIndex = rows.findIndex(r => r[0] === userId);
    if (rowIndex < 0) return;

    const settings = JSON.parse(rows[rowIndex][1] || '{}');
    const customs = settings.customCategories || [];
    if (customs.some(c => c.toLowerCase() === categoryName.toLowerCase())) return;

    customs.push(categoryName);
    settings.customCategories = customs;

    const writeRange = encodeURIComponent(`'UserSettings'!B${rowIndex + 1}`);
    await sheetsRequest(TEMPLATE_ID, `/values/${writeRange}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ values: [[JSON.stringify(settings)]] }),
    });
  } catch (e) {
    console.warn('addCategoryToUserSettings failed (non-fatal):', e.message);
  }
}
