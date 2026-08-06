// ════════════════════════════════════════════════════════════════════════════
// duplicateMatch.js — the single definition of "these two rows are the same
// transaction", shared by duplicate prevention (at log time) and duplicate
// review (after the fact).
//
// MIRROR: keep in sync with functions/lib/_duplicate-match.mjs. The frontend
// bundle can't import from functions/, so the logic is duplicated deliberately
// and a parity test diffs the two.
// ════════════════════════════════════════════════════════════════════════════
import { fuzzyNamesMatch } from './sheetHelpers.js';

/** Cent-level tolerance: the same charge can round differently across sources. */
export const AMOUNT_EPSILON = 0.05;

/**
 * How far apart two charges can be and still be the same purchase.
 *
 * Wide enough to catch the case this exists for — a wallet notification logged
 * instantly, then the receipt photo filed a day or two later — but far short of
 * a week, so a genuinely recurring expense at a steady amount (weekly groceries,
 * a standing subscription) is never flagged.
 *
 * Note the pre-existing `checkDuplicates` in receiptHelpers.js matched on
 * amount + vendor with NO date check at all, which flagged every repeat
 * purchase. This window is what makes the match stricter, not looser.
 */
export const DEFAULT_WINDOW_DAYS = 3;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a sheet date to epoch ms, or null if it isn't a date we understand. */
/** Sheets' epoch is 1899-12-30; 25569 is the serial for 1970-01-01. */
const SHEETS_EPOCH_OFFSET_DAYS = 25569;
const MIN_SHEET_SERIAL = 20000;   // ~1954
const MAX_SHEET_SERIAL = 80000;   // ~2119

export function parseRowDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) {
    const ms = Date.parse(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(ms) ? null : ms;
  }

  // Sheets returns dates as SERIAL NUMBERS when read with UNFORMATTED_VALUE,
  // which is exactly how getRecentExpenses reads them. Date.parse('46234')
  // does not fail — it yields the year 46234, a date 44,000 years out. That is
  // not null, so isSameTransaction does not skip the date filter; it applies it
  // and every comparison fails the ±3-day window. Duplicate detection therefore
  // matched nothing at all for any row carrying a txDate.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial >= MIN_SHEET_SERIAL && serial <= MAX_SHEET_SERIAL) {
      return Math.round((serial - SHEETS_EPOCH_OFFSET_DAYS) * 86400000);
    }
    return null;   // a bare number outside the plausible band is not a date
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
 * Are two transactions the same purchase?
 *
 * Amount and vendor must both match. The date is a *filter, not a requirement*:
 * when both sides carry a usable date they must fall inside the window, but a
 * row with no date still matches on amount + vendor. Rows genuinely lack dates
 * (legacy bot rows, some imports), and dropping them would silently stop
 * detecting exactly the duplicates this is for.
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

/**
 * Every row in `rows` that looks like the same purchase as `candidate`.
 * `rows` is expected to already span every category — a wallet charge lands in
 * Misc while the same receipt gets filed under Grocery, so a same-tab-only
 * search would miss the most common real duplicate.
 */
export function findDuplicates(rows, candidate, windowDays = DEFAULT_WINDOW_DAYS) {
  if (!candidate || !Array.isArray(rows)) return [];
  return rows.filter(row => isSameTransaction(row, candidate, windowDays));
}

/**
 * Group rows that are duplicates of each other into clusters of 2 or more.
 *
 * Single-pass and greedy: each row joins the first cluster it matches, so a
 * chain A~B~C becomes one cluster even if A and C wouldn't match directly.
 * That's intentional — three copies of one purchase should be reviewed
 * together, not split into overlapping pairs the user has to reconcile.
 */
export function clusterDuplicates(rows, windowDays = DEFAULT_WINDOW_DAYS) {
  const clusters = [];
  for (const row of rows || []) {
    if (!Number.isFinite(amountOf(row?.amount))) continue;
    const hit = clusters.find(c => c.some(member => isSameTransaction(member, row, windowDays)));
    if (hit) hit.push(row);
    else clusters.push([row]);
  }
  return clusters
    .filter(c => c.length > 1)
    // Most copies first, then largest amount — the worst distortions on top.
    .sort((a, b) => b.length - a.length || Number(b[0].amount) - Number(a[0].amount));
}
