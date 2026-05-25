/**
 * Google Sheets utilities for serverless functions.
 * Serverless equivalent of sheetExpenses.js + sheetApi.js.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */
import { getAccessToken } from './_drive.mjs';

const SHEETS_API    = 'https://sheets.googleapis.com/v4/spreadsheets';
const TEMPLATE_ID   = process.env.VITE_TEMPLATE_SHEET_ID;

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

async function appendHistory(sheetId, { action, category, vendor, amount, uuid, txDate }) {
  const now = new Date().toISOString();
  const row = [
    now,
    safeString(action),
    safeString(category),
    safeString(vendor),
    amount,
    `Receipt via WhatsApp`,
    uuid,
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
