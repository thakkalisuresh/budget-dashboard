import { getCustomCategories } from './customCategories.js';
import { BUILT_IN_SHEET_MAP } from './fetchDetail.js';
import { isV2EligibleMonth } from '../functions/lib/_schema-version.mjs';

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
  'Utilties':      { sheet: 'Utilities',     descCol: 2, amtCol: 3,  uuidStartCol: 4  }, // intentional misspelling — some sheets use this legacy name
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

export const colLetter = (i) => String.fromCharCode(65 + i);

export function getEffectiveSheetMap() {
  return { ...SHEET_MAP, ...getCustomCategories() };
}

export function getAllCategoryNames() {
  return Object.keys(getEffectiveSheetMap());
}

export function safeText(value) {
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

export function escapeSheetRef(name) {
  return String(name).replace(/'/g, "''");
}

export function escapeFormulaString(name) {
  return String(name).replace(/"/g, '""');
}

// ─── Date utilities ───────────────────────────────────────────────────────────

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Google Sheets stores dates as serial numbers when written with USER_ENTERED
 * value input option. The epoch is December 30, 1899 (accounting for the
 * spreadsheet bug where 1900 is treated as a leap year).
 * Converts a Sheets serial number → 'YYYY-MM-DD' ISO string.
 */
export function sheetsSerialToISO(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + serial * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Parse a raw cell value from Google Sheets into a 'YYYY-MM-DD' string.
 * Handles three cases:
 *   - Already ISO string '2026-06-01' → returned as-is
 *   - Serial number 46174 (number or numeric string) → converted to ISO
 *   - Empty / null → ''
 */
export function parseSheetDate(raw) {
  if (!raw && raw !== 0) return '';
  if (typeof raw === 'number') return sheetsSerialToISO(raw);
  const s = String(raw).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;          // already ISO
  if (/^\d+$/.test(s)) return sheetsSerialToISO(Number(s)); // numeric string serial
  return s;
}

// Defensive: only a non-empty string is a valid transaction date; anything else
// (null, boolean, number) falls back to today. Guards the date cell against
// callers passing the wrong positional arg.
export function coerceTxDate(txDate) {
  return (typeof txDate === 'string' && txDate.trim()) ? txDate : todayIso();
}

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

export function normalizeStatementDate(dateStr) {
  if (!dateStr) return null;
  const mdy = String(dateStr).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) return String(dateStr);
  return null;
}

// ─── Schema detection (v1 vs v2) ─────────────────────────────────────────────

// The cutover date now lives in functions/lib/_schema-version.mjs so the
// warehouse backfill and reconciler share one definition with the app — two
// copies is how they quietly disagree about what a month is. Re-exported here
// so every existing importer keeps working unchanged.
export { isV2EligibleMonth };

export function detectV2(values, monthName = '') {
  return isV2EligibleMonth(monthName) &&
    Array.isArray(values) && Array.isArray(values[0]) &&
    String(values[0][2] || '').trim() === 'Date';
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

// ─── Transaction UUID ────────────────────────────────────────────────────────

export function generateTransactionUUID(amount) {
  const cents  = Math.round(Math.abs(amount) * 100);
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  return `tx_${cents}_${random}`;
}

export function uuidStart(config) {
  return config.uuidStartCol ?? (config.amtCol + 1);
}

// ─── Fuzzy matching ──────────────────────────────────────────────────────────

export function fuzzyNamesMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
  const ca = clean(a);
  const cb = clean(b);
  if (ca === cb) return true;
  if (cb.includes(ca) || ca.includes(cb)) return true;
  const words = s => s.split(/\s+/).filter(w => w.length >= 4);
  const wa = words(ca);
  const wb = words(cb);
  return wa.some(w => wb.some(x => x.includes(w) || w.includes(x)));
}
