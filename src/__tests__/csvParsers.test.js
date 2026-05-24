import { describe, it, expect } from 'vitest';
import {
  parseCSVText,
  detectBank,
  parseChase,
  parseAmex,
  parseGeneric,
  parseStatementFile,
} from '../csvParsers.js';

// ── parseCSVText ─────────────────────────────────────────────────────────────

describe('parseCSVText', () => {
  it('parses simple rows', () => {
    const rows = parseCSVText('a,b,c\n1,2,3');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('handles quoted fields with commas', () => {
    const rows = parseCSVText('"hello, world",b\n1,2');
    expect(rows[0][0]).toBe('hello, world');
  });

  it('handles escaped quotes inside fields', () => {
    const rows = parseCSVText('"say ""hello""",b');
    expect(rows[0][0]).toBe('say "hello"');
  });

  it('strips \\r\\n line endings', () => {
    const rows = parseCSVText('a,b\r\n1,2\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('filters empty rows', () => {
    const rows = parseCSVText('a,b\n\n1,2\n');
    expect(rows.length).toBe(2);
  });
});

// ── detectBank ───────────────────────────────────────────────────────────────

describe('detectBank', () => {
  it('detects Chase by header pattern', () => {
    expect(detectBank(['Transaction Date', 'Post Date', 'Description', 'Amount'])).toBe('chase');
  });

  it('detects Amex by header pattern', () => {
    expect(detectBank(['Date', 'Description', 'Amount', 'Extended Details', 'Card Member'])).toBe('amex');
  });

  it('returns generic for unknown headers', () => {
    expect(detectBank(['Date', 'Payee', 'Amount'])).toBe('generic');
  });
});

// ── parseChase ───────────────────────────────────────────────────────────────

describe('parseChase', () => {
  const headers = ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'];

  it('parses a purchase row', () => {
    const rows = [headers, ['01/15/2026', '01/16/2026', 'WHOLEFDS #1234', 'Groceries', 'Sale', '-45.67', '']];
    const txs = parseChase(rows, 'chase.csv');
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(45.67);
    expect(txs[0].bank).toBe('chase');
    expect(txs[0].date).toBe('2026-01-15');
  });

  it('classifies payments as transfers', () => {
    const rows = [headers, ['01/15/2026', '01/16/2026', 'AUTOMATIC PAYMENT', '', 'Payment', '500.00', '']];
    const txs = parseChase(rows, 'chase.csv');
    expect(txs[0].type).toBe('transfer');
  });

  it('skips rows with zero amount', () => {
    const rows = [headers, ['01/15/2026', '01/16/2026', 'Nothing', '', 'Sale', '0.00', '']];
    expect(parseChase(rows, 'chase.csv')).toHaveLength(0);
  });

  it('returns empty for missing columns', () => {
    expect(parseChase([['Bad', 'Headers']], 'chase.csv')).toEqual([]);
  });
});

// ── parseAmex ────────────────────────────────────────────────────────────────

describe('parseAmex', () => {
  const headers = ['Date', 'Description', 'Amount', 'Extended Details', 'Card Member'];

  it('parses a charge', () => {
    const rows = [headers, ['03/10/2026', 'AMAZON WEB SERVICES', '29.99', '', 'John']];
    const txs = parseAmex(rows, 'amex.csv');
    expect(txs).toHaveLength(1);
    expect(txs[0].amount).toBe(29.99);
    expect(txs[0].bank).toBe('amex');
  });

  it('strips dollar signs and commas from amounts', () => {
    const rows = [headers, ['03/10/2026', 'BIG PURCHASE', '$1,234.56', '', 'John']];
    const txs = parseAmex(rows, 'amex.csv');
    expect(txs[0].amount).toBe(1234.56);
  });
});

// ── parseGeneric ─────────────────────────────────────────────────────────────

describe('parseGeneric', () => {
  it('auto-detects date/desc/amount columns', () => {
    const rows = [['Posted Date', 'Description', 'Amount'], ['05/01/2026', 'TARGET', '55.00']];
    const txs = parseGeneric(rows, 'bank.csv');
    expect(txs).toHaveLength(1);
    expect(txs[0].vendor).toBeTruthy();
  });

  it('returns empty when required columns missing', () => {
    expect(parseGeneric([['Foo', 'Bar']], 'x.csv')).toEqual([]);
  });
});

// ── parseStatementFile (integration) ─────────────────────────────────────────

describe('parseStatementFile', () => {
  it('auto-detects Chase and parses', () => {
    const csv = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n01/20/2026,01/21/2026,GROCERY STORE,Food,Sale,-32.50,';
    const result = parseStatementFile(csv, 'chase.csv');
    expect(result.bank).toBe('chase');
    expect(result.transactions).toHaveLength(1);
    expect(result.error).toBeNull();
  });

  it('returns error for empty file', () => {
    const result = parseStatementFile('', 'empty.csv');
    expect(result.transactions).toEqual([]);
    expect(result.error).toBeTruthy();
  });

  it('returns error for single-row file', () => {
    const result = parseStatementFile('just a header', 'one.csv');
    expect(result.transactions).toEqual([]);
  });
});
