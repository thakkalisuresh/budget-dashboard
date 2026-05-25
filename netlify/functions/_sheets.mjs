/**
 * Google Sheets utilities for serverless functions.
 * Serverless equivalent of sheetExpenses.js + sheetApi.js.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */
import { getAccessToken } from './_drive.mjs';

const SHEETS_API    = 'https://sheets.googleapis.com/v4/spreadsheets';
const TEMPLATE_ID   = process.env.VITE_TEMPLATE_SHEET_ID;
const ALLOWED_EMAILS = (process.env.VITE_ALLOWED_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);

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

export async function appendExpense({ category, vendor, amount, txDate, sheetId, monthName }) {
  const config = SHEET_MAP[category];
  if (!config) throw new Error(`Unknown category: ${category}`);

  const now = new Date();
  const month = monthName
    ? monthName.split(' ')[0]
    : now.toLocaleString('en-US', { month: 'short' });
  const year = monthName
    ? parseInt(monthName.split(' ')[1]) || now.getFullYear()
    : now.getFullYear();

  const dateVal = txDate || now.toISOString().slice(0, 10);
  const uuid    = generateUUID(amount);

  const row = [month, year, dateVal, safeString(vendor), amount, uuid];

  const range = encodeURIComponent(`'${config.sheet}'!A1`);
  await sheetsRequest(sheetId, `/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    body: JSON.stringify({ values: [row] }),
  });

  await appendHistory(sheetId, {
    action: 'WhatsApp Receipt',
    category,
    vendor,
    amount,
    uuid,
    txDate: dateVal,
  });

  return { uuid, row };
}

async function appendHistory(sheetId, { action, category, vendor, amount, uuid, txDate, details }) {
  const now = new Date().toISOString();
  const row = [
    now,
    safeString(action),
    safeString(category),
    safeString(vendor || ''),
    amount,
    details || 'Receipt via WhatsApp',
    uuid || '',
    'whatsapp-bot',
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

  return rows.slice(1)
    .map(row => ({
      timestamp: row[0] || '',
      action:    row[1] || '',
      category:  row[2] || '',
      vendor:    row[3] || '',
      amount:    typeof row[4] === 'number' ? row[4] : null,
      txDate:    row[9] || '',
    }))
    .filter(e => e.amount && /receipt|expense/i.test(e.action))
    .reverse()
    .slice(0, limit);
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
