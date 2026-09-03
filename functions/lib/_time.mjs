/**
 * Timezone-aware date helpers for the backend.
 *
 * Cloud Functions run with TZ=UTC, so a bare `new Date().toLocaleString(...)`
 * resolves the *server's* calendar day/month — which flips to the next month
 * hours before the user's local clock does. On the last evening of a month that
 * made the logger look for a month sheet that doesn't exist yet ("no new month",
 * SHT-002). Everything that needs "the current month" for a spreadsheet lookup
 * must go through here so it's computed in the app's local zone instead.
 *
 * APP_TZ is an IANA zone (e.g. "America/Los_Angeles"), overridable via env.
 * Kept in step with HOUSEHOLD_TZ in _extraction.mjs (todayISO) — both anchor
 * the backend to the household's local day/month. Defined as a standalone
 * literal (not imported) so tests that mock _extraction don't drag this in.
 */

export const APP_TZ = process.env.APP_TZ || 'America/Los_Angeles';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** "September 2026" for right now, in APP_TZ. */
export function currentMonthName(tz = APP_TZ) {
  return new Date().toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: tz });
}

/** { month: "September", year: 2026 } for right now, in APP_TZ. */
export function currentMonthYear(tz = APP_TZ) {
  const now = new Date();
  return {
    month: now.toLocaleString('en-US', { month: 'long', timeZone: tz }),
    year: Number(now.toLocaleString('en-US', { year: 'numeric', timeZone: tz })),
  };
}

/** Today's date as "YYYY-MM-DD" in APP_TZ (en-CA yields ISO order). */
export function localToday(tz = APP_TZ) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

/**
 * Parse a "YYYY-MM-DD" (or ISO) string straight into { month, year } WITHOUT
 * going through `new Date()` — a bare `new Date('2026-08-31')` is parsed as UTC
 * midnight and can drift a day (and thus a month) once read back in another
 * zone. Returns null if the string isn't a recognisable calendar date.
 */
export function monthYearFromDateStr(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return { month: MONTH_NAMES[monthIdx], year: Number(m[1]) };
}

/** "September 2026" from a date string, or null. */
export function monthNameFromDateStr(dateStr) {
  const my = monthYearFromDateStr(dateStr);
  return my ? `${my.month} ${my.year}` : null;
}

/**
 * The month to file a transaction under: the transaction's own date when we have
 * one (device-local date the client sent), otherwise "now" in APP_TZ. Returns
 * { monthName, month, year }.
 */
export function resolveMonth(dateStr) {
  const fromDate = monthYearFromDateStr(dateStr);
  const { month, year } = fromDate || currentMonthYear();
  return { monthName: `${month} ${year}`, month, year };
}
