import { getCustomCategories } from './customCategories.js';
import { BUILT_IN_SHEET_MAP } from './fetchDetail.js';

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

const _V2_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function isV2EligibleMonth(monthName) {
  if (!monthName) return true;
  const parts = String(monthName).trim().split(/\s+/);
  const mIdx = _V2_MONTHS.findIndex(m => m.toLowerCase() === (parts[0] || '').toLowerCase());
  const yr = parseInt(parts[1], 10);
  if (mIdx < 0 || isNaN(yr)) return true;
  return yr > 2026 || (yr === 2026 && mIdx >= 5);
}

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
