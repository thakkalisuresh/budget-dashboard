import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  currentMonthName,
  currentMonthYear,
  localToday,
  monthYearFromDateStr,
  monthNameFromDateStr,
  resolveMonth,
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
