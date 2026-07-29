/**
 * Duplicate matching for the serverless side.
 *
 * MIRROR of src/duplicateMatch.js — keep the two in step; a parity test diffs
 * them across a shared input set. Duplicated rather than imported because the
 * frontend bundle can't reach into functions/ and vice versa (same convention
 * as _card-resolver.mjs ↔ receiptHelpers.js and _categorize.mjs ↔ smartRules.js).
 *
 * fuzzyNamesMatch is inlined here from src/sheetHelpers.js for the same reason.
 */

export const AMOUNT_EPSILON = 0.05;

/**
 * How far apart two charges can be and still be the same purchase. Wide enough
 * for "wallet logged it instantly, receipt filed two days later"; far short of
 * a week, so a steady recurring expense is never flagged.
 */
export const DEFAULT_WINDOW_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** MIRROR of fuzzyNamesMatch in src/sheetHelpers.js. */
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

/** Parse a sheet date to epoch ms, or null if it isn't a date we understand. */
export function parseRowDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const ms = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(ms) ? null : ms;
  }
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Amount as a number, or NaN.
 *
 * Not just Number(): Number(null) and Number('') are both 0, which is finite —
 * so a plain isFinite check treats a row with NO amount as a $0 transaction,
 * and two such rows then match each other as duplicates. Zero is rejected too;
 * a $0 row is a placeholder, never a purchase worth deduping.
 */
function amountOf(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return n === 0 ? NaN : n;
}

/**
 * Are two transactions the same purchase? Amount and vendor must both match;
 * the date is a filter applied only when both sides actually carry one, since
 * legacy bot rows and some imports genuinely have none.
 */
export function isSameTransaction(a, b, windowDays = DEFAULT_WINDOW_DAYS) {
  const amountA = amountOf(a?.amount);
  const amountB = amountOf(b?.amount);
  if (!Number.isFinite(amountA) || !Number.isFinite(amountB)) return false;
  if (Math.abs(amountA - amountB) >= AMOUNT_EPSILON) return false;
  if (!fuzzyNamesMatch(a?.vendor, b?.vendor)) return false;

  const dateA = parseRowDate(a?.date);
  const dateB = parseRowDate(b?.date);
  if (dateA === null || dateB === null) return true;
  return Math.abs(dateA - dateB) <= windowDays * MS_PER_DAY;
}

/** Every row that looks like the same purchase as `candidate`. */
export function findDuplicates(rows, candidate, windowDays = DEFAULT_WINDOW_DAYS) {
  if (!candidate || !Array.isArray(rows)) return [];
  return rows.filter(row => isSameTransaction(row, candidate, windowDays));
}
