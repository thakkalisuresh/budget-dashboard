import { describe, it, expect } from 'vitest';
import {
  safeText,
  escapeSheetRef,
  escapeFormulaString,
  parseAmounts,
  buildFormula,
  normalizeStatementDate,
  fuzzyNamesMatch,
} from '../sheetsApi.js';

// ── safeText ─────────────────────────────────────────────────────────────────

describe('safeText', () => {
  it('passes through non-strings unchanged', () => {
    expect(safeText(42)).toBe(42);
    expect(safeText(null)).toBe(null);
    expect(safeText(undefined)).toBe(undefined);
    expect(safeText(true)).toBe(true);
  });

  it('passes through empty string', () => {
    expect(safeText('')).toBe('');
  });

  it('passes through safe strings', () => {
    expect(safeText('hello')).toBe('hello');
    expect(safeText('Groceries')).toBe('Groceries');
    expect(safeText('123.45')).toBe('123.45');
  });

  it('prefixes = with quote', () => {
    expect(safeText('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
  });

  it('prefixes + with quote', () => {
    expect(safeText('+cmd')).toBe("'+cmd");
  });

  it('prefixes - with quote', () => {
    expect(safeText('-cmd')).toBe("'-cmd");
  });

  it('prefixes @ with quote', () => {
    expect(safeText('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('prefixes CR with quote', () => {
    expect(safeText('\r=cmd')).toBe("'\r=cmd");
  });

  it('prefixes LF with quote', () => {
    expect(safeText('\n=cmd')).toBe("'\n=cmd");
  });

  it('prefixes TAB with quote', () => {
    expect(safeText('\t=cmd')).toBe("'\t=cmd");
  });

  // SEC-09: leading whitespace bypass
  it('catches formula after leading spaces', () => {
    expect(safeText(' =CMD()')).toBe("' =CMD()");
    expect(safeText('  +cmd')).toBe("'  +cmd");
    expect(safeText('   -cmd')).toBe("'   -cmd");
    expect(safeText(' @SUM(A1)')).toBe("' @SUM(A1)");
  });

  it('passes through whitespace-only strings', () => {
    expect(safeText('   ')).toBe('   ');
  });
});

// ── escapeSheetRef ───────────────────────────────────────────────────────────

describe('escapeSheetRef', () => {
  it('returns plain names unchanged', () => {
    expect(escapeSheetRef('Groceries')).toBe('Groceries');
  });

  it('doubles single quotes', () => {
    expect(escapeSheetRef("Bob's Sheet")).toBe("Bob''s Sheet");
  });

  it('doubles multiple quotes', () => {
    expect(escapeSheetRef("a'b'c")).toBe("a''b''c");
  });

  it('coerces non-strings', () => {
    expect(escapeSheetRef(123)).toBe('123');
  });
});

// ── escapeFormulaString ──────────────────────────────────────────────────────

describe('escapeFormulaString', () => {
  it('returns plain names unchanged', () => {
    expect(escapeFormulaString('Groceries')).toBe('Groceries');
  });

  it('doubles double quotes', () => {
    expect(escapeFormulaString('say "hello"')).toBe('say ""hello""');
  });

  it('coerces non-strings', () => {
    expect(escapeFormulaString(123)).toBe('123');
  });
});

// ── parseAmounts ─────────────────────────────────────────────────────────────

describe('parseAmounts', () => {
  it('returns empty for null/undefined/empty', () => {
    expect(parseAmounts(null)).toEqual([]);
    expect(parseAmounts(undefined)).toEqual([]);
    expect(parseAmounts('')).toEqual([]);
  });

  it('parses a single number', () => {
    expect(parseAmounts('25.50')).toEqual([25.5]);
  });

  it('parses a dollar-formatted value', () => {
    expect(parseAmounts('$1,234.56')).toEqual([1234.56]);
  });

  it('parses a formula with multiple amounts', () => {
    expect(parseAmounts('=10+20+30')).toEqual([10, 20, 30]);
  });

  it('parses a formula with decimals', () => {
    expect(parseAmounts('=12.50+7.99')).toEqual([12.5, 7.99]);
  });

  it('returns empty for zero or negative', () => {
    expect(parseAmounts('0')).toEqual([]);
    expect(parseAmounts('-5')).toEqual([]);
  });

  it('returns empty for non-numeric strings', () => {
    expect(parseAmounts('abc')).toEqual([]);
  });

  it('filters NaN values from formulas', () => {
    expect(parseAmounts('=10+abc+20')).toEqual([10, 20]);
  });
});

// ── buildFormula ─────────────────────────────────────────────────────────────

describe('buildFormula', () => {
  it('returns empty string for empty array', () => {
    expect(buildFormula([])).toBe('');
  });

  it('returns plain number for single amount', () => {
    expect(buildFormula([25.5])).toBe('25.5');
  });

  it('returns = formula for multiple amounts', () => {
    expect(buildFormula([10, 20, 30])).toBe('=10+20+30');
  });

  it('round-trips through parseAmounts', () => {
    const amounts = [12.5, 7.99, 3.01];
    expect(parseAmounts(buildFormula(amounts))).toEqual(amounts);
  });
});

// ── normalizeStatementDate ───────────────────────────────────────────────────

describe('normalizeStatementDate', () => {
  it('returns null for falsy input', () => {
    expect(normalizeStatementDate(null)).toBe(null);
    expect(normalizeStatementDate('')).toBe(null);
    expect(normalizeStatementDate(undefined)).toBe(null);
  });

  it('converts MM/DD/YYYY to YYYY-MM-DD', () => {
    expect(normalizeStatementDate('05/23/2026')).toBe('2026-05-23');
  });

  it('pads single-digit month and day', () => {
    expect(normalizeStatementDate('1/5/2026')).toBe('2026-01-05');
  });

  it('passes through YYYY-MM-DD unchanged', () => {
    expect(normalizeStatementDate('2026-05-23')).toBe('2026-05-23');
  });

  it('returns null for unrecognized formats', () => {
    expect(normalizeStatementDate('May 23, 2026')).toBe(null);
    expect(normalizeStatementDate('garbage')).toBe(null);
  });
});

// ── fuzzyNamesMatch ──────────────────────────────────────────────────────────

describe('fuzzyNamesMatch', () => {
  it('returns false for null/empty', () => {
    expect(fuzzyNamesMatch(null, 'test')).toBe(false);
    expect(fuzzyNamesMatch('test', '')).toBe(false);
  });

  it('matches identical names', () => {
    expect(fuzzyNamesMatch('Amazon', 'Amazon')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(fuzzyNamesMatch('amazon', 'AMAZON')).toBe(true);
  });

  it('matches substring (bank truncation)', () => {
    expect(fuzzyNamesMatch('Amazon', 'Amazon Marketplace')).toBe(true);
  });

  it('matches by significant word overlap', () => {
    expect(fuzzyNamesMatch('Mayuri Foods', 'Mayuri Foods International')).toBe(true);
  });

  // MAINT-08: known false-positive from substring collision
  it('false-positive: Amazon Marketplace vs Amazon Web Services', () => {
    expect(fuzzyNamesMatch('Amazon Marketplace', 'Amazon Web Services')).toBe(true);
  });

  it('does not match unrelated names', () => {
    expect(fuzzyNamesMatch('Walmart', 'Target')).toBe(false);
  });

  it('ignores punctuation', () => {
    expect(fuzzyNamesMatch("McDonald's", 'McDonalds')).toBe(true);
  });
});
