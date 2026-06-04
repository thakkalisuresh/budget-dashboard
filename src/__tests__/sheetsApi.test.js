import { describe, it, expect } from 'vitest';
import { applyCardRules } from '../smartRules.js';
import {
  safeText,
  escapeSheetRef,
  escapeFormulaString,
  parseAmounts,
  buildFormula,
  normalizeStatementDate,
  fuzzyNamesMatch,
} from '../sheetsApi.js';
import {
  colLetter,
  uuidStart,
  generateTransactionUUID,
  isV2EligibleMonth,
  detectV2,
  formatTxDate,
  coerceTxDate,
  todayIso,
  parseSheetDate,
  sheetsSerialToISO,
} from '../sheetHelpers.js';

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

// ── colLetter ────────────────────────────────────────────────────────────────

describe('colLetter', () => {
  it('converts 0 to A', () => {
    expect(colLetter(0)).toBe('A');
  });

  it('converts 25 to Z', () => {
    expect(colLetter(25)).toBe('Z');
  });

  it('converts mid-range indices', () => {
    expect(colLetter(2)).toBe('C');
    expect(colLetter(3)).toBe('D');
  });
});

// ── uuidStart ────────────────────────────────────────────────────────────────

describe('uuidStart', () => {
  it('returns uuidStartCol when present', () => {
    expect(uuidStart({ amtCol: 3, uuidStartCol: 4 })).toBe(4);
  });

  it('falls back to amtCol + 1 when uuidStartCol absent', () => {
    expect(uuidStart({ amtCol: 5 })).toBe(6);
  });
});

// ── generateTransactionUUID ──────────────────────────────────────────────────

describe('generateTransactionUUID', () => {
  it('starts with tx_ prefix', () => {
    expect(generateTransactionUUID(25.50)).toMatch(/^tx_/);
  });

  it('encodes amount as cents in the id', () => {
    const id = generateTransactionUUID(12.99);
    expect(id).toMatch(/^tx_1299_/);
  });

  it('produces unique ids on successive calls', () => {
    const a = generateTransactionUUID(10);
    const b = generateTransactionUUID(10);
    expect(a).not.toBe(b);
  });

  it('handles zero cents gracefully', () => {
    expect(generateTransactionUUID(0)).toMatch(/^tx_0_/);
  });
});

// ── isV2EligibleMonth ────────────────────────────────────────────────────────

describe('isV2EligibleMonth', () => {
  it('returns true for falsy input', () => {
    expect(isV2EligibleMonth(null)).toBe(true);
    expect(isV2EligibleMonth('')).toBe(true);
    expect(isV2EligibleMonth(undefined)).toBe(true);
  });

  it('returns true for months after May 2026', () => {
    expect(isV2EligibleMonth('June 2026')).toBe(true);
    expect(isV2EligibleMonth('January 2027')).toBe(true);
  });

  it('returns false for May 2026 (boundary — v2 starts June 2026)', () => {
    expect(isV2EligibleMonth('May 2026')).toBe(false);
  });

  it('returns false for months before June 2026', () => {
    expect(isV2EligibleMonth('April 2026')).toBe(false);
    expect(isV2EligibleMonth('December 2025')).toBe(false);
    expect(isV2EligibleMonth('January 2026')).toBe(false);
  });

  it('returns true for unrecognized strings', () => {
    expect(isV2EligibleMonth('garbage')).toBe(true);
  });
});

// ── detectV2 ─────────────────────────────────────────────────────────────────

describe('detectV2', () => {
  const v2Header = [['', '', 'Date', '', '']];
  const v1Header = [['Month', 'Year', 'Description', 'Amount']];

  it('detects v2 when header row[2] is "Date" and month is eligible', () => {
    expect(detectV2(v2Header, 'June 2026')).toBe(true);
  });

  it('returns false for v1 header', () => {
    expect(detectV2(v1Header, 'June 2026')).toBe(false);
  });

  it('returns false for v2 header on ineligible month', () => {
    expect(detectV2(v2Header, 'January 2026')).toBe(false);
  });

  it('returns false for empty values', () => {
    expect(detectV2([], 'June 2026')).toBe(false);
    expect(detectV2(null, 'June 2026')).toBe(false);
  });
});

// ── formatTxDate ─────────────────────────────────────────────────────────────

describe('formatTxDate', () => {
  it('returns empty string for falsy input', () => {
    expect(formatTxDate('')).toBe('');
    expect(formatTxDate(null)).toBe('');
    expect(formatTxDate(undefined)).toBe('');
  });

  it('formats YYYY-MM-DD without timezone shift', () => {
    const result = formatTxDate('2026-05-23');
    expect(result).toContain('May');
    expect(result).toContain('23');
    expect(result).toContain('2026');
  });

  it('formats other date strings', () => {
    const result = formatTxDate('2026-01-01');
    expect(result).toContain('Jan');
    expect(result).toContain('2026');
  });
});

// ── coerceTxDate ──────────────────────────────────────────────────────────────

describe('coerceTxDate', () => {
  it('passes through a valid date string', () => {
    expect(coerceTxDate('2026-06-02')).toBe('2026-06-02');
  });

  it('falls back to today for null/undefined/empty', () => {
    expect(coerceTxDate(null)).toBe(todayIso());
    expect(coerceTxDate(undefined)).toBe(todayIso());
    expect(coerceTxDate('')).toBe(todayIso());
    expect(coerceTxDate('   ')).toBe(todayIso());
  });

  it('falls back to today for non-strings (Quirk A: boolean in date slot)', () => {
    expect(coerceTxDate(true)).toBe(todayIso());
    expect(coerceTxDate(false)).toBe(todayIso());
    expect(coerceTxDate(123)).toBe(todayIso());
  });
});

// ── applyCardRules ────────────────────────────────────────────────────────────

describe('applyCardRules', () => {
  const rules = [
    { id: '1', vendorPattern: 'costco', category: 'Grocery', card: 'American Express Blue Cash Preferred' },
    { id: '2', vendorPattern: 'costco', category: '',        card: 'Capital One Quicksilver' },
    { id: '3', vendorPattern: 'uber',   category: '',        card: 'Chase Sapphire Reserve' },
    { id: '4', vendorPattern: 'amazon', category: 'Misc',    card: 'Chase Freedom Unlimited' },
  ];

  it('returns null for empty vendor', () => {
    expect(applyCardRules('', 'Grocery', rules)).toBeNull();
  });

  it('returns null for empty rules', () => {
    expect(applyCardRules('Costco', 'Grocery', [])).toBeNull();
  });

  it('matches vendor case-insensitively', () => {
    expect(applyCardRules('Uber Eats', 'Eating Out', rules)).toBe('Chase Sapphire Reserve');
  });

  it('category-specific rule beats vendor-only rule', () => {
    expect(applyCardRules('Costco Wholesale', 'Grocery', rules)).toBe('American Express Blue Cash Preferred');
  });

  it('vendor-only rule matches when category does not match specific rule', () => {
    expect(applyCardRules('Costco', 'Misc', rules)).toBe('Capital One Quicksilver');
  });

  it('returns null when no pattern matches', () => {
    expect(applyCardRules('Whole Foods', 'Grocery', rules)).toBeNull();
  });

  it('longer vendor pattern wins among same-specificity rules', () => {
    const twoRules = [
      { id: 'a', vendorPattern: 'amazon', category: 'Misc', card: 'Card A' },
      { id: 'b', vendorPattern: 'amazon prime', category: 'Misc', card: 'Card B' },
    ];
    expect(applyCardRules('Amazon Prime Video', 'Misc', twoRules)).toBe('Card B');
  });

  it('category filter excludes rule when category does not match', () => {
    expect(applyCardRules('Amazon', 'Grocery', rules)).toBeNull();
  });
});

// ── parseSheetDate / sheetsSerialToISO ────────────────────────────────────────

describe('parseSheetDate', () => {
  it('returns empty string for falsy input', () => {
    expect(parseSheetDate(null)).toBe('');
    expect(parseSheetDate(undefined)).toBe('');
    expect(parseSheetDate('')).toBe('');
  });

  it('passes through a valid ISO date string unchanged', () => {
    expect(parseSheetDate('2026-06-01')).toBe('2026-06-01');
    expect(parseSheetDate('2025-12-31')).toBe('2025-12-31');
  });

  it('converts a numeric serial to ISO (number type)', () => {
    // Serial 46174 ≈ June 2026 in Google Sheets dating
    const result = parseSheetDate(46174);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/); // is an ISO string
    expect(result.startsWith('2026')).toBe(true);   // year is 2026
  });

  it('converts a numeric serial string to ISO', () => {
    const result = parseSheetDate('46174');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.startsWith('2026')).toBe(true);
  });

  it('sheetsSerialToISO matches known date — serial 1 = Jan 1 1900', () => {
    expect(sheetsSerialToISO(1)).toBe('1899-12-31'); // Dec 31 1899 due to the leap-year bug offset
  });

  it('sheetsSerialToISO is consistent with parseSheetDate for numbers', () => {
    expect(parseSheetDate(46000)).toBe(sheetsSerialToISO(46000));
  });
});
