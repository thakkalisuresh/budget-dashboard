import { describe, it, expect } from 'vitest';
import { parseQIF  } from '../qifParser.js';
import { parseOFX  } from '../ofxParser.js';
import { parseMT940 } from '../mt940Parser.js';

// ── QIF ──────────────────────────────────────────────────────────────────────

describe('parseQIF', () => {
  const sample = `
!Type:Bank
D01/15/2024
T-45.67
PStarbucks
MCoffee run
^
D02/20/2024
T-120.00
PWhole Foods
^
D03/01/2024
T250.00
PSalary Deposit
^
`.trim();

  it('parses multiple records', () => {
    const { transactions, error } = parseQIF(sample, 'test.qif');
    expect(error).toBeNull();
    expect(transactions).toHaveLength(3);
  });

  it('parses vendor and amount correctly', () => {
    const { transactions } = parseQIF(sample, 'test.qif');
    expect(transactions[0].vendor).toBe('Starbucks');
    expect(transactions[0].amount).toBe(45.67);
    expect(transactions[0].type).toBe('purchase');
    expect(transactions[0].bank).toBe('qif');
  });

  it('marks positive amounts as credit', () => {
    const { transactions } = parseQIF(sample, 'test.qif');
    expect(transactions[2].type).toBe('credit');
    expect(transactions[2].amount).toBe(250);
  });

  it('parses date to ISO format', () => {
    const { transactions } = parseQIF(sample, 'test.qif');
    expect(transactions[0].date).toBe('2024-01-15');
  });

  it('falls back to memo when payee is missing', () => {
    const text = `!Type:Bank\nD01/01/2024\nT-10.00\nMGrocery store\n^`;
    const { transactions } = parseQIF(text);
    expect(transactions[0].vendor).toBe('Grocery store');
  });

  it('returns error for empty file', () => {
    const { error } = parseQIF('!Type:Bank\n');
    expect(error).toBeTruthy();
  });
});

// ── OFX ──────────────────────────────────────────────────────────────────────

describe('parseOFX', () => {
  const sample1x = `
OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<STMTTRNLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115120000
<TRNAMT>-45.67
<FITID>1001
<NAME>STARBUCKS #1234
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240301000000
<TRNAMT>2500.00
<FITID>1002
<NAME>DIRECT DEPOSIT
</STMTTRN>
</STMTTRNLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`.trim();

  const sample2x = `<?xml version="1.0"?>
<OFX>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><STMTTRNLIST>
<STMTTRN>
  <TRNTYPE>DEBIT</TRNTYPE>
  <DTPOSTED>20240220120000</DTPOSTED>
  <TRNAMT>-120.00</TRNAMT>
  <FITID>2001</FITID>
  <NAME>WHOLE FOODS</NAME>
</STMTTRN>
</STMTTRNLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

  it('parses OFX 1.x SGML format', () => {
    const { transactions, error } = parseOFX(sample1x, 'bank.ofx');
    expect(error).toBeNull();
    expect(transactions).toHaveLength(2);
  });

  it('parses OFX 2.x XML format', () => {
    const { transactions, error } = parseOFX(sample2x, 'bank.ofx');
    expect(error).toBeNull();
    expect(transactions).toHaveLength(1);
    expect(transactions[0].vendor).toBe('WHOLE FOODS');
    expect(transactions[0].amount).toBe(120);
  });

  it('marks debit as purchase, credit as credit', () => {
    const { transactions } = parseOFX(sample1x, 'bank.ofx');
    expect(transactions[0].type).toBe('purchase');
    expect(transactions[1].type).toBe('credit');
  });

  it('parses date to ISO', () => {
    const { transactions } = parseOFX(sample1x, 'bank.ofx');
    expect(transactions[0].date).toBe('2024-01-15');
  });

  it('returns error for empty file', () => {
    const { error } = parseOFX('<OFX></OFX>');
    expect(error).toBeTruthy();
  });
});

// ── MT940 ─────────────────────────────────────────────────────────────────────

describe('parseMT940', () => {
  const sample = `
:20:STARTUMS
:21:NONREF
:25:DE89370400440532013000/EUR
:28C:00001/001
:60F:C240101EUR1000,00
:61:2401150115D45,67NTRFNONREF//BANK-REF-001
:86:Starbucks Berlin
:61:2402200220D120,00NTRFNONREF//BANK-REF-002
:86:REWE Supermarkt
:61:2403010301C2500,00NTRFNONREF//BANK-REF-003
:86:Gehaltseingang
:62F:C240301EUR3334,33
`.trim();

  it('parses multiple :61: records', () => {
    const { transactions, error } = parseMT940(sample, 'statement.mt940');
    expect(error).toBeNull();
    expect(transactions).toHaveLength(3);
  });

  it('picks up vendor from :86: line', () => {
    const { transactions } = parseMT940(sample, 'statement.mt940');
    expect(transactions[0].vendor).toBe('Starbucks Berlin');
    expect(transactions[1].vendor).toBe('REWE Supermarkt');
  });

  it('converts European decimal amount correctly', () => {
    const { transactions } = parseMT940(sample, 'statement.mt940');
    expect(transactions[0].amount).toBe(45.67);
    expect(transactions[1].amount).toBe(120);
    expect(transactions[2].amount).toBe(2500);
  });

  it('marks D as purchase, C as credit', () => {
    const { transactions } = parseMT940(sample, 'statement.mt940');
    expect(transactions[0].type).toBe('purchase');
    expect(transactions[2].type).toBe('credit');
  });

  it('parses YYMMDD date to ISO', () => {
    const { transactions } = parseMT940(sample, 'statement.mt940');
    expect(transactions[0].date).toBe('2024-01-15');
  });

  it('returns error for file with no :61: lines', () => {
    const { error } = parseMT940(':20:STARTUMS\n:28C:00001/001');
    expect(error).toBeTruthy();
  });
});
