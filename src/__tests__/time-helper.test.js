import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  currentMonthName,
  currentMonthYear,
  localToday,
  monthYearFromDateStr,
  monthNameFromDateStr,
  previousMonthName,
  resolveMonth,
  dateFromChaseSms,
} from '../../functions/lib/_time.mjs';

const PT = 'America/Los_Angeles';

afterEach(() => vi.useRealTimers());

describe('_time helpers — parse date strings without UTC drift', () => {
  it('monthYearFromDateStr parses a plain YYYY-MM-DD', () => {
    expect(monthYearFromDateStr('2026-08-31')).toEqual({ month: 'August', year: 2026 });
  });

  it('monthNameFromDateStr formats the month name', () => {
    expect(monthNameFromDateStr('2026-01-05')).toBe('January 2026');
    expect(monthNameFromDateStr('2026-12-25')).toBe('December 2026');
  });

  it('returns null for junk input', () => {
    expect(monthYearFromDateStr('')).toBeNull();
    expect(monthYearFromDateStr('not-a-date')).toBeNull();
    expect(monthNameFromDateStr(undefined)).toBeNull();
  });

  it('resolveMonth prefers the transaction date, falls back to now', () => {
    expect(resolveMonth('2026-08-31').monthName).toBe('August 2026');
    const noDate = resolveMonth(null);
    expect(noDate.monthName).toBe(currentMonthName());
  });
});

describe('_time helpers — the Aug-31 month-boundary bug', () => {
  // 2026-09-01T04:00:00Z is still Aug 31, 9:00pm in Pacific (PDT, UTC-7).
  // The old UTC-based code resolved this to "September" and failed to find a
  // sheet ("no new month"). Anchored to APP_TZ it must stay in August.
  it('currentMonthName stays in the local month past UTC midnight', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T04:00:00Z'));
    expect(currentMonthName(PT)).toBe('August 2026');
    expect(currentMonthYear(PT)).toEqual({ month: 'August', year: 2026 });
    expect(localToday(PT)).toBe('2026-08-31');
  });

  it('rolls to the new month once local midnight passes', () => {
    vi.useFakeTimers();
    // 2026-09-01T08:00:00Z = Sep 1, 1:00am Pacific.
    vi.setSystemTime(new Date('2026-09-01T08:00:00Z'));
    expect(currentMonthName(PT)).toBe('September 2026');
    expect(localToday(PT)).toBe('2026-09-01');
  });

  it('handles a year boundary too', () => {
    vi.useFakeTimers();
    // 2027-01-01T05:00:00Z = Dec 31 2026, 9:00pm Pacific.
    vi.setSystemTime(new Date('2027-01-01T05:00:00Z'));
    expect(currentMonthName(PT)).toBe('December 2026');
    expect(currentMonthYear(PT)).toEqual({ month: 'December', year: 2026 });
  });
});

describe('previousMonthName', () => {
  it('steps back one month and across a year boundary', () => {
    expect(previousMonthName('September 2026')).toBe('August 2026');
    expect(previousMonthName('January 2027')).toBe('December 2026');
  });

  it('returns null for anything that is not "Month YYYY"', () => {
    expect(previousMonthName('')).toBeNull();
    expect(previousMonthName(undefined)).toBeNull();
    expect(previousMonthName('Smarch 2026')).toBeNull();
  });
});


describe('dateFromChaseSms — Eastern wall-clock in the text → app-local date', () => {
  const sms = (when) =>
    `Chase Example Card Visa: You made a $12.34 transaction with EXAMPLE STORE #0001 on ${when} ET.`;

  it('converts an evening charge (same day Pacific)', () => {
    expect(dateFromChaseSms(sms('Sep 18, 2026 at 9:46 PM'), PT)).toBe('2026-09-18');
  });

  it('rolls back a day when the ET time is early morning', () => {
    expect(dateFromChaseSms(sms('Sep 20, 2026 at 12:05 AM'), PT)).toBe('2026-09-19');
  });

  it('files a late-evening Pacific charge on the last day of a month under that month', () => {
    // 11:30 PM PDT Sep 30 shows as 2:30 AM ET Oct 1 in the text.
    expect(dateFromChaseSms(sms('Oct 1, 2026 at 2:30 AM'), PT)).toBe('2026-09-30');
  });

  it('handles EST (winter) text — 3 h offset still holds', () => {
    // 11:30 PM PST Nov 30 = 2:30 AM EST Dec 1.
    expect(dateFromChaseSms(sms('Dec 1, 2026 at 2:30 AM'), PT)).toBe('2026-11-30');
  });

  it('handles the spring-forward gap (ET switched, PT not yet)', () => {
    // 2026-03-08 07:30 UTC = 3:30 AM EDT = 11:30 PM PST Mar 7.
    expect(dateFromChaseSms(sms('Mar 8, 2026 at 3:30 AM'), PT)).toBe('2026-03-07');
  });

  it('handles the fall-back hour (ET switched, PT not yet)', () => {
    // 1:30 AM ET Nov 1 is 10:30 PM or 11:30 PM Pacific on Oct 31 either way.
    expect(dateFromChaseSms(sms('Nov 1, 2026 at 1:30 AM'), PT)).toBe('2026-10-31');
  });

  it('treats 12:xx PM as noon, not midnight', () => {
    expect(dateFromChaseSms(sms('Sep 18, 2026 at 12:15 PM'), PT)).toBe('2026-09-18');
  });

  it('is the identity when the app zone is Eastern, and UTC-aware', () => {
    expect(dateFromChaseSms(sms('Sep 20, 2026 at 12:05 AM'), 'America/New_York')).toBe('2026-09-20');
    expect(dateFromChaseSms(sms('Sep 20, 2026 at 9:05 PM'), 'UTC')).toBe('2026-09-21');
  });

  it('ignores the machine clock and timezone (a delayed SMS keeps its true date)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00Z'));
    expect(dateFromChaseSms(sms('Sep 18, 2026 at 9:46 PM'), PT)).toBe('2026-09-18');
  });

  it('returns null when the pattern is absent or the date is impossible', () => {
    expect(dateFromChaseSms('Little Oddfellows, Portland, OR $17.58', PT)).toBeNull();
    expect(dateFromChaseSms('Your purchase for $23.10 at EXAMPLE was approved.', PT)).toBeNull();
    expect(dateFromChaseSms(sms('Feb 30, 2026 at 9:46 PM'), PT)).toBeNull();
    expect(dateFromChaseSms(sms('Foo 18, 2026 at 9:46 PM'), PT)).toBeNull();
    expect(dateFromChaseSms(sms('Sep 18, 2026 at 13:46 PM'), PT)).toBeNull();
    expect(dateFromChaseSms('on Sep 18, 2026 at 9:46 PM PT', PT)).toBeNull();
    expect(dateFromChaseSms(undefined, PT)).toBeNull();
  });
});
