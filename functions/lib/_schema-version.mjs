/**
 * Which SHEET layout a month uses.
 *
 * Two layouts coexist in the same spreadsheet family:
 *
 *   V1  (Oct 2025 – May 2026)  one row per *vendor*; several charges packed
 *                              into `=12.5+9.99` with uuids spread across
 *                              columns E onward. Row ≠ transaction, and there
 *                              is no Date column at all — month precision only.
 *   V2  (June 2026 onward)     one row per transaction, Date in col C, uuid in
 *                              col G (H for Travel/Holiday).
 *
 * "V1/V2" always means the sheet layout. The two warehouse launches are called
 * Release 1 and Release 2 — do not mix the two vocabularies up.
 *
 * This lived in `src/sheetHelpers.js` (browser-only). The warehouse backfill and
 * reconciler run in Cloud Functions and need the same answer, and two copies of
 * a cutover date is how the backfill and the app quietly disagree about what a
 * month is. It now lives here and `sheetHelpers.js` re-exports it, with a parity
 * test pinning the two together.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** The V2 cutover: June 2026. */
export const V2_FIRST_YEAR  = 2026;
export const V2_FIRST_MONTH = 5; // 0-based → June

/**
 * True when `monthName` ('June 2026') is at or after the V2 cutover.
 *
 * Unparseable input returns true — the caller then falls back to sniffing the
 * actual header row, which is the safer default for a brand-new month.
 */
export function isV2EligibleMonth(monthName) {
  if (!monthName) return true;
  const parts = String(monthName).trim().split(/\s+/);
  const mIdx = MONTHS.findIndex(m => m.toLowerCase() === (parts[0] || '').toLowerCase());
  const yr = parseInt(parts[1], 10);
  if (mIdx < 0 || isNaN(yr)) return true;
  return yr > V2_FIRST_YEAR || (yr === V2_FIRST_YEAR && mIdx >= V2_FIRST_MONTH);
}

/** `'v1' | 'v2'` — what goes in `month_dim.schema_version`. */
export function sheetSchemaVersion(monthName) {
  return isV2EligibleMonth(monthName) ? 'v2' : 'v1';
}

/**
 * First day of a registry month, as 'YYYY-MM-01'. This is the warehouse
 * partition key, so an unparseable month must be loud rather than silently
 * bucketed somewhere plausible.
 */
export function monthStart(monthName) {
  const parts = String(monthName || '').trim().split(/\s+/);
  const mIdx = MONTHS.findIndex(m => m.toLowerCase() === (parts[0] || '').toLowerCase());
  const yr = parseInt(parts[1], 10);
  if (mIdx < 0 || isNaN(yr)) return null;
  return `${yr}-${String(mIdx + 1).padStart(2, '0')}-01`;
}

/** 'June 2026' from a 'YYYY-MM-DD' date. */
export function monthNameFromDate(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const idx = Number(m[2]) - 1;
  if (idx < 0 || idx > 11) return null;
  return `${MONTHS[idx]} ${m[1]}`;
}

export { MONTHS as MONTH_NAMES };
