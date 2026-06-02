import { apiFetch, fetchRaw } from './sheetApi.js';
import { getEffectiveSheetMap, parseAmounts, uuidStart, detectV2, fuzzyNamesMatch } from './sheetHelpers.js';

const _detailCache = new Map();
const DETAIL_CACHE_TTL = 2 * 60 * 1000;

export function invalidateDetailCache(sheetId, categoryName) {
  if (categoryName) {
    _detailCache.delete(`${sheetId}:${categoryName}`);
  } else {
    for (const k of [..._detailCache.keys()]) {
      if (k.startsWith(sheetId + ':')) _detailCache.delete(k);
    }
  }
}

export async function fetchDetailRows(categoryName, accessToken, sheetId, monthName = '') {
  const cacheKey = `${sheetId}:${categoryName}`;
  const cached = _detailCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DETAIL_CACHE_TTL) return cached.data;

  const config = getEffectiveSheetMap()[categoryName];
  if (!config) return [];

  const LEGACY_FALLBACKS = {
    'Furniture': { sheet: 'Moving Expenses+Furniture', descCol: 10, amtCol: 11 },
  };

  let values = await fetchRaw(sheetId, config.sheet, accessToken);

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

  const isV2    = detectV2(values, monthName);
  const descCol = isV2 ? 3 : config.descCol;
  const amtCol  = isV2 ? 4 : config.amtCol;
  const pmCol   = isV2 ? 5 : -1;   // Payment Method col (F) — V2 only
  const bmCol   = isV2 ? 6 : -1;   // Booking Method col (G) — V2 only
  const uuidCol = isV2 ? 7 : uuidStart(config);  // UUID col (H for V2, always last)
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
    const uuids         = amounts.map((_, i) => String(row[uuidCol + i] || ''));
    const date          = isV2 ? String(row[dateCol] || '').trim() : '';
    const paymentMethod = pmCol >= 0 ? String(row[pmCol] || '').trim() : '';
    const bookingMethod = bmCol >= 0 ? String(row[bmCol] || '').trim() : '';
    result.push({ rowIndex: j + 2, description: String(desc), amounts, uuids, date, paymentMethod, bookingMethod, _v2: isV2 });
  });

  _detailCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

export async function checkExistingExpense(category, vendor, amount, accessToken, sheetId) {
  try {
    const rows = await fetchDetailRows(category, accessToken, sheetId);
    return rows.some(row => {
      const amountMatch = row.amounts?.some(a => Math.abs(a - amount) < 0.05);
      if (!amountMatch) return false;
      return fuzzyNamesMatch(row.description, vendor);
    });
  } catch {
    return false;
  }
}

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
