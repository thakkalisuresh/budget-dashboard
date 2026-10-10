import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../sheetApi.js', () => ({ apiFetch: (...a) => apiFetch(...a) }));

const {
  MF_HOLDINGS_COLUMNS, MF_HOLDINGS_STATUS_COLUMNS, parseHoldingsRows, parseStatusRows, toIsoDate, fetchMfHoldings,
  validateItiUrl, ingestMfHoldingsUrl, expectedHoldingsMonth,
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

const GOOD = 'https://itiamc.com/admin/pdf/1760000000000-ITIMF_Monthly_Portfolio_30092026.xlsx';

describe('validateItiUrl', () => {
  it('accepts the monthly-file link (and www) and reads the date from the file name', () => {
    expect(validateItiUrl(`  ${GOOD} `)).toMatchObject({ ok: true, asOf: '2026-09-30' });
    expect(validateItiUrl(GOOD.replace('//itiamc', '//www.itiamc')).ok).toBe(true);
  });
  it('rejects anything else before it is sent', () => {
    for (const bad of [
      '', 'not a url', GOOD.replace('https', 'http'), GOOD.replace('itiamc.com', 'itiamc.com.evil.io'),
      'https://evil.com/admin/pdf/1-ITIMF_Monthly_Portfolio_30092026.xlsx', `${GOOD}?x=1`, `${GOOD}#a`,
      'https://user:pw@itiamc.com/admin/pdf/1-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://itiamc.com:8443/admin/pdf/1-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://itiamc.com/admin/pdf/ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://itiamc.com/admin/pdf/1-ITIMF_Monthly_Portfolio_31022026.xlsx',
      'https://itiamc.com/admin/pdf/1-other.xlsx',
    ]) expect(validateItiUrl(bad).ok, bad).toBe(false);
  });
});

describe('ingestMfHoldingsUrl', () => {
  const reply = (status, body) => vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
  const run = (over) => ({ ok: true, fundKey: 'iti-small-cap', asOf: '2026-09-30', status: 'ok', rowCount: 84, weightSum: 94.7, reason: '', ...over });
  it('posts the ingest contract with the bearer token and maps success', async () => {
    reply(200, run());
    expect(await ingestMfHoldingsUrl(GOOD, 'tok')).toMatchObject({ ok: true, status: 'ok', asOf: '2026-09-30', rowCount: 84, weightSum: 94.7 });
    const [path, init] = fetch.mock.calls[0];
    expect(path).toBe('/api/mf-holdings');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ action: 'ingest', house: 'iti', url: GOOD });
  });
  it('run outcomes with ok:false carry a plain label and the reason', async () => {
    reply(200, run({ ok: false, status: 'stale', reason: 'file is for 31-08-2026' }));
    expect(await ingestMfHoldingsUrl(GOOD, 'tok')).toMatchObject({ ok: false, status: 'stale', error: 'That file is for a different month than expected: file is for 31-08-2026' });
    reply(200, run({ ok: false, status: 'missing', reason: '' }));
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toBe('The file was not found');
    reply(200, run({ ok: false, status: 'failed', reason: 'weights sum to 40%' }));
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toBe('The file could not be loaded: weights sum to 40%');
  });
  it('maps HTTP statuses to plain words', async () => {
    reply(409, { error: 'A refresh is already running', retryable: true });
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toBe('A refresh is already running, try again in a minute.');
    reply(409, { error: 'No Invest sheet provisioned yet — open the Invest tab once' });
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toMatch(/No Invest sheet/);
    reply(403, { ok: false, error: 'Read-only users cannot load holdings' });
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toMatch(/viewers cannot/);
    reply(400, { ok: false, error: 'bad', reason: 'date is outside the last 3 months' });
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toBe('date is outside the last 3 months');
    reply(404, null);
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toMatch(/isn't deployed yet/);
    reply(500, { error: 'boom' });
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toBe('boom');
  });
  it('never throws: network errors and invalid input are returned, nothing is sent for bad input', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect((await ingestMfHoldingsUrl(GOOD, 'tok')).error).toMatch(/Could not reach/);
    const spy = vi.fn(); vi.stubGlobal('fetch', spy);
    expect((await ingestMfHoldingsUrl('https://evil.com/x', 'tok')).ok).toBe(false);
    expect((await ingestMfHoldingsUrl(GOOD, '')).ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('expectedHoldingsMonth', () => {
  it('is the previous month-end from the 10th, nothing before', () => {
    expect(expectedHoldingsMonth('2026-10-10')).toEqual({ asOf: '2026-09-30', label: 'September 2026' });
    expect(expectedHoldingsMonth('2027-01-15')).toEqual({ asOf: '2026-12-31', label: 'December 2026' });
    expect(expectedHoldingsMonth('2026-10-09')).toBeNull();
  });
});
