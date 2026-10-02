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

/** "August 2026" for "September 2026" (and "December 2026" for "January 2027"), or null. */
export function previousMonthName(monthName) {
  const [month, year] = String(monthName || '').trim().split(/\s+/);
  const idx = MONTH_NAMES.indexOf(month);
  if (idx < 0 || !/^\d{4}$/.test(year)) return null;
  return idx === 0 ? `${MONTH_NAMES[11]} ${Number(year) - 1}` : `${MONTH_NAMES[idx - 1]} ${year}`;
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

const SMS_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SMS_WHEN = /\bon\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])\s+E[SD]?T\b/;

/** Milliseconds `tz` is ahead of UTC at instant `ms`. */
function zoneOffsetMs(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms)).map(x => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The household-local "YYYY-MM-DD" for a Chase text alert, whose
 * "on Sep 18, 2026 at 9:46 PM ET" is Eastern wall-clock. Taking the text's
 * date as-is would file a late evening Pacific charge on the last day of a
 * month under the NEXT month (ET is 3 h ahead). Pure: no reliance on the
 * machine clock or zone. Returns null when the pattern is absent or invalid so
 * callers keep their existing date.
 */
export function dateFromChaseSms(text, tz = APP_TZ) {
  const m = SMS_WHEN.exec(String(text || ''));
  if (!m) return null;
  const mon = SMS_MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  const day = Number(m[2]), year = Number(m[3]);
  let hour = Number(m[4]);
  const minute = Number(m[5]);
  if (mon < 0 || hour < 1 || hour > 12 || minute > 59) return null;
  const probe = new Date(Date.UTC(year, mon, day));
  if (probe.getUTCMonth() !== mon || probe.getUTCDate() !== day) return null;
  hour = (hour % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0);

  const wall = Date.UTC(year, mon, day, hour, minute);
  // Wall-clock → instant: offset at the guess, then re-check at the result so
  // the hour around a DST switch resolves to a real instant.
  const ET = 'America/New_York';
  let instant = wall - zoneOffsetMs(wall, ET);
  instant = wall - zoneOffsetMs(instant, ET);
  return new Date(instant).toLocaleDateString('en-CA', { timeZone: tz });
}
