import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../sheetApi.js', () => ({ apiFetch: (...a) => apiFetch(...a) }));

const {
  MF_HOLDINGS_COLUMNS, MF_HOLDINGS_STATUS_COLUMNS, parseHoldingsRows, parseStatusRows, toIsoDate, fetchMfHoldings,
} = await import('../mfHoldingsApi.js');

beforeEach(() => { apiFetch.mockReset(); });

describe('contract with the holdings pipeline', () => {
  it('column order is exactly the agreed one', () => {
    expect(MF_HOLDINGS_COLUMNS).toEqual(['asOf', 'fundKey', 'isin', 'name', 'industry', 'assetClass', 'weightPct', 'marketValueInrLakh', 'sourceFile']);
    expect(MF_HOLDINGS_STATUS_COLUMNS).toEqual(['fundKey', 'asOf', 'status', 'checkedAt', 'rowCount', 'weightSum', 'reason', 'sourceFile']);
  });
});

describe('parsing', () => {
  it('reads rows, coerces numbers, tolerates blanks and unknown asset classes', () => {
    const rows = parseHoldingsRows([
      ['2026-09-30', 'absl-flexi-cap', 'ine090a01021', 'ICICI Bank Ltd.', 'Banks', 'equity', 5.5967, '', 'f.zip'],
      ['2026-09-30', 'absl-flexi-cap', '', 'Cash', '', 'weird', '1.2', 12.5, ''],
      ['2026-09-30', '', 'X', 'no fund', '', 'equity', 1, '', ''],
      ['not a date', 'f', 'X', 'bad date', '', 'equity', 1, '', ''],
      ['2026-09-30', 'f', 'X', 'no weight', '', 'equity', '', '', ''],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ isin: 'INE090A01021', assetClass: 'equity', weightPct: 5.5967, marketValueInrLakh: null });
    expect(rows[1]).toMatchObject({ assetClass: 'other', weightPct: 1.2, marketValueInrLakh: 12.5 });
  });
  it('accepts Sheets date serials', () => {
    expect(toIsoDate(46295)).toBe('2026-09-30');
    expect(toIsoDate('2026-09-30')).toBe('2026-09-30');
    expect(toIsoDate('')).toBe('');
  });
  it('reads status rows keyed by fundKey', () => {
    const s = parseStatusRows([['iti-small-cap', '2026-09-30', 'FAILED', '2026-10-10T06:00Z', 84, 94.7, 'file not found', 'x.xlsx'], ['', '', '', '', '', '', '', '']]);
    expect(s['iti-small-cap']).toMatchObject({ status: 'failed', reason: 'file not found', rowCount: 84, weightSum: 94.7 });
    expect(Object.keys(s)).toEqual(['iti-small-cap']);
  });
});

describe('fetchMfHoldings', () => {
  it('returns the empty state when both tabs are absent', async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error('x'), { code: 'SHT-001' }));
    const r = await fetchMfHoldings('sheet', 'tok');
    expect(r).toEqual({ rows: [], statusByFund: {}, asOfByFund: {}, missing: true });
  });
  it('tolerates the status tab missing while holdings exist, and records the latest asOf per fund', async () => {
    apiFetch.mockImplementation(async (_id, path) => {
      if (path.includes('MfHoldingsStatus')) throw Object.assign(new Error('x'), { code: 'SHT-001' });
      return { values: [['2026-08-31', 'f', 'INE1', 'A', 'Banks', 'equity', 5], ['2026-09-30', 'f', 'INE1', 'A', 'Banks', 'equity', 6]] };
    });
    const r = await fetchMfHoldings('sheet', 'tok');
    expect(r.missing).toBe(false);
    expect(r.asOfByFund).toEqual({ f: '2026-09-30' });
    expect(r.statusByFund).toEqual({});
  });
  it('does not hide a sign-in problem as "no holdings"', async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error('denied'), { code: 'AUTH-005' }));
    await expect(fetchMfHoldings('sheet', 'tok')).rejects.toThrow('denied');
  });
  it('makes no call without a sheet or token', async () => {
    expect((await fetchMfHoldings('', 'tok')).missing).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
