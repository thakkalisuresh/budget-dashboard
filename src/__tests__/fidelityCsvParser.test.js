import { describe, it, expect } from 'vitest';
import { parseFidelityCsv, classifyAction } from '../fidelityCsvParser.js';

const ACTIVITY_CSV = `Run Date,Account,Action,Symbol,Security Description,Security Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date
07/02/2026,Individual X12345678, YOU BOUGHT VANGUARD S&P 500 ETF (VOO) (Cash), VOO, VANGUARD S&P 500 ETF,Cash,10,502.11,,,,"-5,021.10",07/03/2026
06/15/2026,Individual X12345678, YOU SOLD NVIDIA CORP (NVDA) (Cash), NVDA, NVIDIA CORP,Cash,-4,168.20,,0.02,,672.78,06/16/2026
06/10/2026,Individual X12345678, DIVIDEND RECEIVED VANGUARD S&P 500 ETF (VOO) (Cash), VOO, VANGUARD S&P 500 ETF,Cash,,,,,,17.42,
06/01/2026,Individual X12345678, REINVESTMENT VANGUARD S&P 500 ETF (VOO) (Cash), VOO, VANGUARD S&P 500 ETF,Cash,0.034,512.00,,,,-17.41,
05/28/2026,Individual X12345678, Electronic Funds Transfer Received (Cash),, No Description,Cash,,,,,,"2,000.00",
05/20/2026,Individual X12345678, JOURNALED SPP PURCHASE CREDIT,, No Description,Cash,,,,,,55.00,

"The data and information in this spreadsheet is provided to you solely for your use, blah."
"Date downloaded 07/08/2026"`;

const POSITIONS_CSV = `Account Number,Account Name,Symbol,Description,Quantity,Last Price,Last Price Change,Current Value,Today's Gain/Loss Dollar,Today's Gain/Loss Percent,Total Gain/Loss Dollar,Total Gain/Loss Percent,Percent Of Account,Cost Basis Total,Average Cost Basis,Type
X12345678,Individual,VOO,VANGUARD S&P 500 ETF,18,$512.40,+$3.10,"$9,223.20",+$55.80,+0.61%,"+$1,003.20",+12.2%,32.52%,"$8,220.00",$456.67,Cash
X12345678,Individual,AAPL,APPLE INC,25,$233.60,+$2.59,"$5,840.00",+$64.75,+1.12%,+$590.00,+11.24%,20.59%,"$5,250.00",$210.00,Cash
X12345678,Individual,SPAXX**,FIDELITY GOVERNMENT MONEY MARKET,412.15,$1.00,$0.00,$412.15,$0.00,0.00%,,,1.45%,,,Cash
X12345678,Individual,Pending Activity,,,,,"$1,201.00",,,,,,,,

"Brokerage services are provided by Fidelity Brokerage Services LLC"`;

describe('classifyAction', () => {
  it('maps Fidelity action strings to activity types', () => {
    expect(classifyAction(' YOU BOUGHT VOO (Cash)')).toBe('BUY');
    expect(classifyAction('REINVESTMENT VOO')).toBe('BUY');
    expect(classifyAction('YOU SOLD NVDA')).toBe('SELL');
    expect(classifyAction('DIVIDEND RECEIVED VOO')).toBe('DIVIDEND');
    expect(classifyAction('INTEREST EARNED')).toBe('INTEREST');
    expect(classifyAction('Electronic Funds Transfer Received')).toBe('DEPOSIT');
    expect(classifyAction('Electronic Funds Transfer Paid')).toBe('WITHDRAW');
    expect(classifyAction('JOURNALED SPP PURCHASE CREDIT')).toBeNull();
    expect(classifyAction('')).toBeNull();
  });
});

describe('parseFidelityCsv — activity export', () => {
  const result = parseFidelityCsv(ACTIVITY_CSV, { accountId: 'fidelity' });

  it('detects the activity shape', () => {
    expect(result.kind).toBe('activity');
    expect(result.error).toBeUndefined();
  });

  it('parses buys with ISO dates and positive quantities', () => {
    const buy = result.activities.find(a => a.type === 'BUY' && a.qty === 10);
    expect(buy).toMatchObject({ date: '2026-07-02', symbol: 'VOO', price: 502.11, accountId: 'fidelity' });
  });

  it('parses sells with abs(qty)', () => {
    const sell = result.activities.find(a => a.type === 'SELL');
    expect(sell).toMatchObject({ symbol: 'NVDA', qty: 4, price: 168.2 });
  });

  it('parses dividends, reinvestments, and deposits', () => {
    expect(result.activities.filter(a => a.type === 'DIVIDEND')).toHaveLength(1);
    const reinvest = result.activities.find(a => a.type === 'BUY' && a.qty === 0.034);
    expect(reinvest.symbol).toBe('VOO');
    const dep = result.activities.find(a => a.type === 'DEPOSIT');
    expect(dep.amount).toBe(2000);
    expect(dep.symbol).toBe('');
  });

  it('skips unclassifiable rows and disclaimer tail without failing', () => {
    expect(result.activities).toHaveLength(5);
    expect(result.skipped).toBeGreaterThanOrEqual(1); // the JOURNALED row
  });
});

describe('parseFidelityCsv — positions export', () => {
  const result = parseFidelityCsv(POSITIONS_CSV, { accountId: 'fidelity', asOfDate: '2026-07-08' });

  it('detects the positions shape and seeds synthetic BUY lots', () => {
    expect(result.kind).toBe('positions');
    expect(result.activities).toHaveLength(2); // SPAXX** cash + Pending Activity skipped
    const voo = result.activities.find(a => a.symbol === 'VOO');
    expect(voo).toMatchObject({ type: 'BUY', qty: 18, price: 456.67, date: '2026-07-08' });
    expect(voo.amount).toBeCloseTo(8220.06, 2);
  });

  it('skips the cash sweep and pending rows', () => {
    expect(result.activities.find(a => a.symbol.startsWith('SPAXX'))).toBeUndefined();
    expect(result.skipped).toBeGreaterThanOrEqual(2);
  });
});

describe('parseFidelityCsv — junk input', () => {
  it('reports unknown format', () => {
    const r = parseFidelityCsv('a,b,c\n1,2,3');
    expect(r.kind).toBe('unknown');
    expect(r.error).toMatch(/not a recognised/i);
    expect(parseFidelityCsv('').error).toMatch(/empty/i);
  });
});
