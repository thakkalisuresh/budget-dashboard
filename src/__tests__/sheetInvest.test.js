import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createInvestSheet, ensureInvestSheet, fetchAccounts, updateAccount,
  appendActivity, appendActivities, fetchActivities, fetchRateWatch,
  deleteActivityByUUID, INVEST_TABS, ensureInvestTabs,
  writeEtfHoldings, readEtfHoldings, quarterKey, currentQuarterKey, isHoldingsFresh,
  appendRateHistory, fetchRateHistory, ensureRateHistoryTab, writeRateWatchDetails,
  readCusipMap, writeCusipMap,
  ACTIVITY_TYPES, MANUAL_ACTIVITY_TYPES, ensureInvestColumns, ensureInvestMf,
  fetchSipPlans, appendSipPlan, updateSipPlan, SEED_SIP_PLANS,
  withRetry429, setRetrySleepForTests, RETRY_429_DELAYS_MS,
} from '../sheetInvest.js';

// Route-based fetch mock: each entry is [urlSubstring+method matcher, response]
let calls;
let routes;
function mockFetch() {
  calls = [];
  routes = [];
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url: String(url), method, body: opts.body ? JSON.parse(opts.body) : null });
    const hit = routes.find(r => String(url).includes(r.match) && (!r.method || r.method === method));
    return {
      ok: hit ? hit.ok !== false : true,
      status: hit?.status || 200,
      json: async () => (hit ? hit.json : {}),
    };
  }));
}

beforeEach(() => mockFetch());

describe('createInvestSheet', () => {
  it('creates the spreadsheet with all four tabs, headers, and seed accounts', async () => {
    routes.push({ match: 'sheets.googleapis.com/v4/spreadsheets', method: 'POST', json: { spreadsheetId: 'inv123' } });
    const id = await createInvestSheet('tok', ['a@x.com']);
    expect(id).toBe('inv123');

    const create = calls.find(c => c.method === 'POST' && c.url.endsWith('/v4/spreadsheets'));
    const titles = create.body.sheets.map(s => s.properties.title);
    expect(titles).toEqual(Object.keys(INVEST_TABS));

    const accounts = create.body.sheets.find(s => s.properties.title === 'Accounts');
    const headerCells = accounts.data[0].rowData[0].values.map(v => v.userEnteredValue.stringValue);
    expect(headerCells).toEqual(INVEST_TABS.Accounts);
    // 4 seed accounts (incl. the NRO mf_in account) follow the header
    expect(accounts.data[0].rowData).toHaveLength(5);
    const nro = accounts.data[0].rowData[4].values.map(v => v.userEnteredValue.stringValue ?? v.userEnteredValue.numberValue);
    expect(nro[0]).toBe('nro-mf');
    expect(nro[2]).toBe('mf_in');
    expect(nro[8]).toBe('INR');
    // SipPlans tab is created and seeded with the four funds at INR 5000
    const sip = create.body.sheets.find(s => s.properties.title === 'SipPlans');
    expect(sip.data[0].rowData).toHaveLength(5);
    expect(sip.data[0].rowData[1].values[0].userEnteredValue.stringValue).toBe('birla-flexi');
    expect(accounts.data[0].rowData[1].values[0].userEnteredValue.stringValue).toBe('amex-hysa');
    // HYSA goal seeded at 250k
    expect(accounts.data[0].rowData[1].values[7].userEnteredValue.numberValue).toBe(250000);
  });

  it('surfaces API errors', async () => {
    routes.push({ match: '/v4/spreadsheets', method: 'POST', ok: false, json: { error: { message: 'quota' } } });
    await expect(createInvestSheet('tok', [])).rejects.toThrow('quota');
  });
});

describe('ensureInvestSheet', () => {
  it('returns the existing id without any network call', async () => {
    const id = await ensureInvestSheet({
      settings: { investSheetId: 'existing' },
      updateSettings: vi.fn(), accessToken: 'tok',
    });
    expect(id).toBe('existing');
    expect(calls).toHaveLength(0);
  });

  it('provisions on first use and persists the id into settings', async () => {
    routes.push({ match: '/v4/spreadsheets', method: 'POST', json: { spreadsheetId: 'fresh1' } });
    const updateSettings = vi.fn();
    const id = await ensureInvestSheet({ settings: {}, updateSettings, accessToken: 'tok', allowedEmails: [] });
    expect(id).toBe('fresh1');
    const next = updateSettings.mock.calls[0][0]({ other: true });
    expect(next).toEqual({ other: true, investSheetId: 'fresh1' });
  });
});

describe('fetchAccounts', () => {
  it('parses account rows and skips blanks', async () => {
    routes.push({
      match: "'Accounts'!A2%3AI50", json: {
        values: [
          ['amex-hysa', 'Amex Savings', 'hysa', 'American Express', 3.7, 28400, '2026-07-01', 250000],
          ['fidelity', 'Fidelity', 'brokerage', 'Fidelity', '', '', '', ''],
          [],
        ],
      },
    });
    const accounts = await fetchAccounts('inv123', 'tok');
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({ id: 'amex-hysa', apy: 3.7, balance: 28400, goal: 250000, rowIndex: 2 });
    expect(accounts[1]).toMatchObject({ id: 'fidelity', type: 'brokerage', rowIndex: 3 });
  });
});

describe('updateAccount', () => {
  it('writes apy/balance/asOf and snapshots a balance change', async () => {
    routes.push({
      match: "'Accounts'!A2%3AI50", json: {
        values: [['happen-hysa', 'Happen Bank', 'hysa', 'Happen', 4.4, 41250, '2026-06-01', 250000]],
      },
    });
    await updateAccount('inv123', 'tok', 'happen-hysa', { balance: 43250 });

    const put = calls.find(c => c.method === 'PUT' && c.url.includes("'Accounts'!E2%3AG2"));
    expect(put.body.values[0][0]).toBe(4.4);      // apy preserved
    expect(put.body.values[0][1]).toBe(43250);    // new balance
    const snap = calls.find(c => c.url.includes('Snapshots'));
    expect(snap.body.values[0][1]).toBe('happen-hysa');
    expect(snap.body.values[0][2]).toBe(43250);
  });

  it('throws on unknown account and skips snapshot when balance unchanged', async () => {
    routes.push({
      match: "'Accounts'!A2%3AI50", json: {
        values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
      },
    });
    await expect(updateAccount('inv123', 'tok', 'nope', {})).rejects.toThrow('Unknown account');
    mockFetch();
    routes.push({
      match: "'Accounts'!A2%3AI50", json: {
        values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
      },
    });
    await updateAccount('inv123', 'tok', 'amex-hysa', { apy: 3.9 });
    expect(calls.find(c => c.url.includes('Snapshots'))).toBeUndefined();
  });
});

describe('activities', () => {
  it('appends rows RAW with generated uuids and normalised symbols', async () => {
    const uuids = await appendActivities('inv123', 'tok', [
      { date: '2026-07-02', accountId: 'fidelity', type: 'BUY', symbol: 'voo', qty: 10, price: 502.11, amount: 5021.1, note: 'import' },
      { accountId: 'amex-hysa', type: 'DEPOSIT', amount: 2000 },
    ]);
    expect(uuids).toHaveLength(2);
    expect(uuids[0]).toMatch(/^act_[0-9a-f]{12}$/);

    const append = calls.find(c => c.url.includes('Activities') && c.url.includes(':append'));
    expect(append.url).toContain('valueInputOption=RAW');
    expect(append.body.values[0][3]).toBe('VOO');
    expect(append.body.values[1][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/); // defaults to today
    expect(append.body.values[1][4]).toBe(''); // qty blank for deposits
  });

  it('appendActivity delegates to bulk append', async () => {
    const uuids = await appendActivity('inv123', 'tok', { accountId: 'fidelity', type: 'INTEREST', amount: 5 });
    expect(uuids).toHaveLength(1);
  });

  it('fetchActivities parses typed rows and skips junk', async () => {
    routes.push({
      match: "'Activities'!A2%3AK5000", json: {
        values: [
          ['2026-07-02', 'fidelity', 'BUY', 'VOO', 10, 502.11, 5021.1, 'import', 'act_aaa'],
          ['', '', '', '', '', '', '', '', ''],
        ],
      },
    });
    const acts = await fetchActivities('inv123', 'tok');
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: 'BUY', symbol: 'VOO', qty: 10, price: 502.11, uuid: 'act_aaa', rowIndex: 2 });
  });

  it('deleteActivityByUUID deletes the matching sheet row', async () => {
    routes.push({
      match: "'Activities'!A2%3AK5000", json: {
        values: [['2026-07-02', 'fidelity', 'BUY', 'VOO', 10, 502.11, 5021.1, '', 'act_kill']],
      },
    });
    routes.push({ match: '?fields=sheets.properties', json: { sheets: [{ properties: { title: 'Activities', sheetId: 77 } }] } });
    await deleteActivityByUUID('inv123', 'tok', 'act_kill');
    const del = calls.find(c => c.url.includes(':batchUpdate'));
    expect(del.body.requests[0].deleteDimension.range).toMatchObject({ sheetId: 77, startIndex: 1, endIndex: 2 });
  });
});

describe('fetchRateWatch', () => {
  it('parses detailsJson, tolerates bad JSON, returns newest first', async () => {
    routes.push({
      match: "'RateWatch'!A2%3AF200", json: {
        values: [
          ['2026-06-24', 'Openbank', 4.75, 4.4, 0.35, '[{"bank":"Openbank","apy":4.75}]'],
          ['2026-07-08', 'Pibank', 4.8, 4.4, 0.4, 'not-json'],
        ],
      },
    });
    const rows = await fetchRateWatch('inv123', 'tok');
    expect(rows[0]).toMatchObject({ scanDate: '2026-07-08', bestBank: 'Pibank', details: [], proposals: [] });
    expect(rows[1].details[0].bank).toBe('Openbank');
  });

  it('parses the { alternatives, proposals } object form and tags rowIndex', async () => {
    routes.push({
      match: "'RateWatch'!A2%3AF200", json: {
        values: [
          ['2026-10-01', 'Openbank', 4.75, 4.4, 0.35,
            '{"alternatives":[{"bank":"Openbank","apy":4.75}],"proposals":[{"accountId":"amex-hysa","bank":"Amex","currentApy":3.7,"proposedApy":3.85,"effectiveDate":"2026-10-01"}]}'],
        ],
      },
    });
    const rows = await fetchRateWatch('inv123', 'tok');
    expect(rows[0].rowIndex).toBe(2);
    expect(rows[0].details[0].bank).toBe('Openbank');
    expect(rows[0].proposals[0]).toMatchObject({ accountId: 'amex-hysa', proposedApy: 3.85 });
  });
});

describe('writeRateWatchDetails', () => {
  it('PUTs column F of the given row with the { alternatives, proposals } object', async () => {
    await writeRateWatchDetails('inv123', 'tok', 5, { alternatives: [{ bank: 'X', apy: 5 }], proposals: [] });
    const put = calls.find(c => c.method === 'PUT' && c.url.includes("'RateWatch'!F5"));
    expect(put).toBeTruthy();
    const payload = JSON.parse(put.body.values[0][0]);
    expect(payload).toEqual({ alternatives: [{ bank: 'X', apy: 5 }], proposals: [] });
  });
});

// RateHistory tab exists on the sheet, so ensureRateHistoryTab is a no-op and
// each APY change produces a single clean append.
function withRateHistoryTab() {
  routes.push({ match: '?fields=sheets.properties', json: { sheets: [
    { properties: { title: 'Accounts' } }, { properties: { title: 'RateHistory', sheetId: 9 } },
  ] } });
}

describe('RateHistory on APY change', () => {
  it('appends a manual-source row when the APY changes', async () => {
    routes.push({ match: "'Accounts'!A2%3AI50", json: {
      values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
    } });
    withRateHistoryTab();
    await updateAccount('inv123', 'tok', 'amex-hysa', { apy: 3.85 });

    const hist = calls.find(c => c.url.includes('RateHistory') && c.url.includes(':append'));
    expect(hist).toBeTruthy();
    expect(hist.body.values[0]).toEqual(['amex-hysa', 3.85, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'manual']);
  });

  it('does NOT append RateHistory when only the balance changes', async () => {
    routes.push({ match: "'Accounts'!A2%3AI50", json: {
      values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
    } });
    withRateHistoryTab();
    await updateAccount('inv123', 'tok', 'amex-hysa', { balance: 30000 });

    expect(calls.find(c => c.url.includes('RateHistory'))).toBeUndefined();
    expect(calls.find(c => c.url.includes('Snapshots'))).toBeTruthy();
  });

  it('honours an explicit rate-watch source (the confirmed-finding path)', async () => {
    routes.push({ match: "'Accounts'!A2%3AI50", json: {
      values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
    } });
    withRateHistoryTab();
    await updateAccount('inv123', 'tok', 'amex-hysa', { apy: 3.85, rateSource: 'rate-watch' });

    const hist = calls.find(c => c.url.includes('RateHistory') && c.url.includes(':append'));
    expect(hist.body.values[0][3]).toBe('rate-watch');
  });
});

describe('ensureRateHistoryTab', () => {
  it('is a no-op when the tab already exists', async () => {
    withRateHistoryTab();
    const created = await ensureRateHistoryTab('inv123', 'tok');
    expect(created).toBe(false);
    expect(calls.find(c => c.url.includes(':batchUpdate'))).toBeUndefined();
  });

  it('adds the tab and writes its header when missing', async () => {
    routes.push({ match: '?fields=sheets.properties', json: { sheets: [{ properties: { title: 'Accounts' } }] } });
    const created = await ensureRateHistoryTab('inv123', 'tok');
    expect(created).toBe(true);
    const add = calls.find(c => c.url.includes(':batchUpdate'));
    expect(add.body.requests[0].addSheet.properties.title).toBe('RateHistory');
    const header = calls.find(c => c.method === 'PUT' && c.url.includes("'RateHistory'!A1"));
    expect(header.body.values[0]).toEqual(INVEST_TABS.RateHistory);
  });
});

describe('fetchRateHistory', () => {
  it('parses rows and skips blanks', async () => {
    routes.push({ match: "'RateHistory'!A2%3AD500", json: {
      values: [
        ['amex-hysa', 4.4, '2026-07-08', 'manual'],
        ['amex-hysa', 3.85, '2026-10-01', 'rate-watch'],
        [],
      ],
    } });
    const rows = await fetchRateHistory('inv123', 'tok');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ accountId: 'amex-hysa', apy: 3.85, effectiveDate: '2026-10-01', source: 'rate-watch', rowIndex: 3 });
  });
});

describe('appendRateHistory', () => {
  it('defaults source to manual and date to today', async () => {
    await appendRateHistory('inv123', 'tok', { accountId: 'happen-hysa', apy: 4.5 });
    const hist = calls.find(c => c.url.includes('RateHistory') && c.url.includes(':append'));
    expect(hist.body.values[0][0]).toBe('happen-hysa');
    expect(hist.body.values[0][3]).toBe('manual');
    expect(hist.body.values[0][2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('ensureInvestTabs', () => {
  it('adds only the missing tabs, each with its header row (idempotent backfill)', async () => {
    // Existing sheet predates EtfHoldings + CusipMap + RateHistory — older tabs present.
    routes.push({
      match: '?fields=sheets.properties.title',
      json: { sheets: ['Accounts', 'Activities', 'Snapshots', 'RateWatch'].map(t => ({ properties: { title: t } })) },
    });
    const added = await ensureInvestTabs('inv123', 'tok');
    expect(added).toEqual(['EtfHoldings', 'CusipMap', 'RateHistory', 'SipPlans']);

    const batch = calls.find(c => c.url.includes(':batchUpdate'));
    expect(batch.body.requests).toEqual([
      { addSheet: { properties: { title: 'EtfHoldings' } } },
      { addSheet: { properties: { title: 'CusipMap' } } },
      { addSheet: { properties: { title: 'RateHistory' } } },
      { addSheet: { properties: { title: 'SipPlans' } } },
    ]);
    const header = calls.find(c => c.method === 'PUT' && c.url.includes('EtfHoldings'));
    expect(header.body.values[0]).toEqual(INVEST_TABS.EtfHoldings);
  });

  it('is a no-op when all tabs already exist', async () => {
    routes.push({
      match: '?fields=sheets.properties.title',
      json: { sheets: Object.keys(INVEST_TABS).map(t => ({ properties: { title: t } })) },
    });
    expect(await ensureInvestTabs('inv123', 'tok')).toEqual([]);
    expect(calls.find(c => c.url.includes(':batchUpdate'))).toBeUndefined();
  });
});

describe('EtfHoldings cache round-trip', () => {
  it('writes flat rows and reads them back, recency-wins by asOf', async () => {
    const n = await writeEtfHoldings('inv123', 'tok', 'voo', {
      asOf: '2026-09-30',
      holdings: [
        { cusip: '037833100', name: 'Apple Inc', ticker: 'AAPL', weight: 7.12 },
        { cusip: '594918104', name: 'Microsoft Corp', ticker: '', weight: 6.5 },
      ],
    });
    expect(n).toBe(2);
    const append = calls.find(c => c.url.includes('EtfHoldings') && c.url.includes(':append'));
    expect(append.url).toContain('valueInputOption=RAW');
    expect(append.body.values[0]).toEqual(['VOO', '2026-09-30', '037833100', 'Apple Inc', 'AAPL', 7.12]);

    mockFetch();
    routes.push({
      match: "'EtfHoldings'!A2", json: {
        values: [
          ['VOO', '2026-06-30', '037833100', 'Apple Inc', 'AAPL', 7.0],   // stale filing
          ['VOO', '2026-09-30', '037833100', 'Apple Inc', 'AAPL', 7.12],  // latest
          ['VOO', '2026-09-30', '594918104', 'Microsoft Corp', '', 6.5],
          ['QQQ', '2026-09-30', '037833100', 'Apple Inc', 'AAPL', 9.0],   // other ticker
        ],
      },
    });
    const got = await readEtfHoldings('inv123', 'tok', 'voo');
    expect(got.ticker).toBe('VOO');
    expect(got.asOf).toBe('2026-09-30');       // newest only
    expect(got.holdings).toHaveLength(2);       // no stale 2026-06-30 row, no QQQ
    expect(got.holdings[0]).toMatchObject({ cusip: '037833100', ticker: 'AAPL', weight: 7.12 });
  });

  it('returns null for an uncached ticker', async () => {
    routes.push({ match: "'EtfHoldings'!A2", json: { values: [['QQQ', '2026-09-30', 'x', 'y', '', 1]] } });
    expect(await readEtfHoldings('inv123', 'tok', 'VTI')).toBeNull();
  });
});

describe('CusipMap cache round-trip', () => {
  it('reads the map as { cusip: ticker }, first-seen wins, skips empty tickers', async () => {
    routes.push({
      match: "'CusipMap'!A2", json: {
        values: [
          ['037833100', 'AAPL', 'cache'],
          ['037833100', 'WRONG', 'openfigi'], // duplicate cusip — first wins
          ['594918104', 'MSFT', 'openfigi'],
          ['000000000', '', 'openfigi'],       // empty ticker — skipped
        ],
      },
    });
    const map = await readCusipMap('inv123', 'tok');
    expect(map).toEqual({ '037833100': 'AAPL', '594918104': 'MSFT' });
  });

  it('returns {} when the tab is absent (tolerated)', async () => {
    routes.push({ match: "'CusipMap'!A2", ok: false, status: 400, json: {} });
    expect(await readCusipMap('inv123', 'tok')).toEqual({});
  });

  it('appends only rows with both a cusip and a ticker, uppercased', async () => {
    // ensureInvestTabs runs first; pretend every tab already exists (no-op).
    routes.push({
      match: '?fields=sheets.properties.title',
      json: { sheets: Object.keys(INVEST_TABS).map(t => ({ properties: { title: t } })) },
    });
    const n = await writeCusipMap('inv123', 'tok', [
      { cusip: '037833100', ticker: 'aapl', source: 'openfigi' },
      { cusip: 'deadbeef1', ticker: '', source: 'openfigi' }, // no ticker — skipped
    ]);
    expect(n).toBe(1);
    const append = calls.find(c => c.url.includes('CusipMap') && c.url.includes(':append'));
    expect(append.body.values).toEqual([['037833100', 'AAPL', 'openfigi']]);
  });
});

describe('holdings freshness (quarterly)', () => {
  it('maps dates to calendar quarters', () => {
    expect(quarterKey('2026-07-31')).toBe('2026-Q3');
    expect(quarterKey('2026-10-01')).toBe('2026-Q4');
    expect(quarterKey('2026-01-15')).toBe('2026-Q1');
    expect(quarterKey('bad')).toBe('');
    expect(currentQuarterKey(new Date('2026-10-07T00:00:00Z'))).toBe('2026-Q4');
  });

  it('is fresh only when asOf is in the current quarter', () => {
    const now = new Date('2026-10-07T00:00:00Z'); // Q4
    expect(isHoldingsFresh('2026-10-01', now)).toBe(true);
    expect(isHoldingsFresh('2026-07-31', now)).toBe(false); // last quarter → refetch
    expect(isHoldingsFresh('', now)).toBe(false);
  });
});


describe('mf_in schema', () => {
  it('adds INR_RECEIVED but keeps it out of the manual-entry list', () => {
    expect(ACTIVITY_TYPES).toContain('INR_RECEIVED');
    expect(MANUAL_ACTIVITY_TYPES).not.toContain('INR_RECEIVED');
    expect(MANUAL_ACTIVITY_TYPES).toContain('BUY');
  });

  it('tab headers carry the new columns at the right edge', () => {
    expect(INVEST_TABS.Accounts.slice(-1)).toEqual(['currency']);
    expect(INVEST_TABS.Activities.slice(-2)).toEqual(['currency', 'fxToUsd']);
    expect(INVEST_TABS.SipPlans).toEqual(['id', 'schemeCode', 'name', 'amc', 'amountInr', 'day', 'accountId', 'active']);
  });

  it('fetchAccounts defaults currency (INR for mf_in, USD otherwise)', async () => {
    routes.push({ match: "'Accounts'!A2%3AI50", json: { values: [
      ['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 100, '', 250000],
      ['nro-mf', 'NRO', 'mf_in', 'NRO', '', '', '', '', ''],
      ['x', 'X', 'brokerage', 'F', '', '', '', '', 'USD'],
    ] } });
    const a = await fetchAccounts('inv', 'tok');
    expect(a.map(x => x.currency)).toEqual(['USD', 'INR', 'USD']);
  });

  it('activities round-trip currency + fxToUsd; legacy rows read USD/1', async () => {
    await appendActivity('inv', 'tok', {
      date: '2026-11-03', accountId: 'nro-mf', type: 'INR_RECEIVED', amount: 20000,
      currency: 'INR', fxToUsd: 0.0115, note: 'settles:act_1',
    });
    await appendActivity('inv', 'tok', { accountId: 'amex-hysa', type: 'DEPOSIT', amount: 5 });
    const rows = calls.filter(c => c.url.includes(':append')).map(c => c.body.values[0]);
    expect(rows[0]).toHaveLength(11);
    expect(rows[0][8]).toMatch(/^act_/);
    expect(rows[0].slice(9)).toEqual(['INR', 0.0115]);
    expect(rows[1].slice(9)).toEqual(['USD', 1]);

    mockFetch();
    routes.push({ match: "'Activities'!A2%3AK5000", json: { values: [
      ['2026-11-03', 'nro-mf', 'INR_RECEIVED', '', '', '', 20000, 'settles:act_1', 'act_2', 'INR', 0.0115],
      ['2026-07-02', 'fidelity', 'BUY', 'VOO', 10, 500, 5000, '', 'act_3'],
    ] } });
    const acts = await fetchActivities('inv', 'tok');
    expect(acts[0]).toMatchObject({ currency: 'INR', fxToUsd: 0.0115 });
    expect(acts[1]).toMatchObject({ currency: 'USD', fxToUsd: 1 });
  });
});

describe('ensureInvestColumns', () => {
  it('appends only missing header cells and never touches data rows', async () => {
    routes.push({ match: 'values:batchGet', json: { valueRanges: [
      { values: [INVEST_TABS.Accounts.slice(0, 8)] },
      { values: [INVEST_TABS.Activities.slice(0, 9)] },
    ] } });
    const added = await ensureInvestColumns('inv', 'tok');
    expect(added).toEqual({ Accounts: ['currency'], Activities: ['currency', 'fxToUsd'] });
    const puts = calls.filter(c => c.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0].url).toContain(encodeURIComponent("'Accounts'!I1"));
    expect(puts[0].body.values).toEqual([['currency']]);
    expect(puts[1].url).toContain(encodeURIComponent("'Activities'!J1"));
    expect(puts[1].body.values).toEqual([['currency', 'fxToUsd']]);
  });

  it('is a no-op when headers are complete', async () => {
    routes.push({ match: 'values:batchGet', json: { valueRanges: [
      { values: [INVEST_TABS.Accounts] }, { values: [INVEST_TABS.Activities] },
    ] } });
    expect(await ensureInvestColumns('inv', 'tok')).toEqual({});
    expect(calls.filter(c => c.method === 'PUT')).toHaveLength(0);
  });
});

describe('SipPlans', () => {
  it('seeds the four funds at INR 5000, unmapped, no day, active', () => {
    expect(SEED_SIP_PLANS.map(r => r[0])).toEqual(['birla-flexi', 'birla-conglomerate', 'sbi-retirement', 'iti-small-cap']);
    for (const r of SEED_SIP_PLANS) {
      expect(r[1]).toBe('unmapped'); expect(r[4]).toBe(5000); expect(r[5]).toBe('');
      expect(r[6]).toBe('nro-mf'); expect(r[7]).toBe(true);
    }
    expect(SEED_SIP_PLANS.map(r => r[3])).toEqual(['Aditya Birla Sun Life', 'Aditya Birla Sun Life', 'SBI', 'ITI']);
  });

  it('fetchSipPlans parses rows, optional day, active flag, unmapped', async () => {
    routes.push({ match: "'SipPlans'!A2%3AH50", json: { values: [
      ['birla-flexi', 'unmapped', 'Birla Flexi Cap Fund', 'Aditya Birla Sun Life', 5000, '', 'nro-mf', true],
      ['sbi-retirement', '119775', 'SBI Retirement Fund', 'SBI', 5000, 7, 'nro-mf', 'FALSE'],
      [],
    ] } });
    const plans = await fetchSipPlans('inv', 'tok');
    expect(plans).toHaveLength(2);
    expect(plans[0]).toMatchObject({ id: 'birla-flexi', schemeCode: 'unmapped', mapped: false, day: null, active: true, rowIndex: 2 });
    expect(plans[1]).toMatchObject({ mapped: true, day: 7, active: false, amountInr: 5000, rowIndex: 3 });
  });

  it('appendSipPlan writes a RAW row', async () => {
    await appendSipPlan('inv', 'tok', { id: 'p1', name: 'P1', amc: 'X', amountInr: 1000, accountId: 'nro-mf' });
    const ap = calls.find(c => c.url.includes('SipPlans') && c.url.includes(':append'));
    expect(ap.body.values[0]).toEqual(['p1', 'unmapped', 'P1', 'X', 1000, '', 'nro-mf', true]);
  });

  it('updateSipPlan rewrites the row in place, merging fields', async () => {
    routes.push({ match: "'SipPlans'!A2%3AH50", json: { values: [
      ['birla-flexi', 'unmapped', 'Birla Flexi Cap Fund', 'ABSL', 5000, '', 'nro-mf', true],
    ] } });
    await updateSipPlan('inv', 'tok', 'birla-flexi', { schemeCode: '120', day: 5, active: false });
    const put = calls.find(c => c.method === 'PUT' && c.url.includes(encodeURIComponent("'SipPlans'!A2:H2")));
    expect(put.body.values[0]).toEqual(['birla-flexi', '120', 'Birla Flexi Cap Fund', 'ABSL', 5000, 5, 'nro-mf', false]);
    await expect(updateSipPlan('inv', 'tok', 'nope', {})).rejects.toThrow('Unknown SIP plan');
  });
});

describe('ensureInvestMf', () => {
  it('seeds nro-mf and the SIP plans on a sheet that has neither', async () => {
    routes.push({ match: '?fields=sheets.properties.title', json: { sheets: Object.keys(INVEST_TABS).map(t => ({ properties: { title: t } })) } });
    routes.push({ match: 'values:batchGet', json: { valueRanges: [{ values: [INVEST_TABS.Accounts] }, { values: [INVEST_TABS.Activities] }] } });
    routes.push({ match: "'Accounts'!A2%3AI50", json: { values: [['amex-hysa', 'Amex', 'hysa', 'A', 1, 1, '', 250000]] } });
    routes.push({ match: "'SipPlans'!A2%3AH50", json: {} });
    await ensureInvestMf('inv', 'tok');
    const acct = calls.find(c => c.url.includes('Accounts') && c.url.includes(':append'));
    expect(acct.body.values[0][0]).toBe('nro-mf');
    expect(acct.body.values[0][8]).toBe('INR');
    const plans = calls.find(c => c.url.includes('SipPlans') && c.url.includes(':append'));
    expect(plans.body.values).toHaveLength(4);
  });

  it('is a no-op when everything is already there', async () => {
    routes.push({ match: '?fields=sheets.properties.title', json: { sheets: Object.keys(INVEST_TABS).map(t => ({ properties: { title: t } })) } });
    routes.push({ match: 'values:batchGet', json: { valueRanges: [{ values: [INVEST_TABS.Accounts] }, { values: [INVEST_TABS.Activities] }] } });
    routes.push({ match: "'Accounts'!A2%3AI50", json: { values: [['nro-mf', 'N', 'mf_in', 'N', '', '', '', '', 'INR']] } });
    routes.push({ match: "'SipPlans'!A2%3AH50", json: { values: [['birla-flexi', 'unmapped', 'B', 'A', 5000, '', 'nro-mf', true]] } });
    await ensureInvestMf('inv', 'tok');
    expect(calls.filter(c => c.url.includes(':append') || c.method === 'PUT')).toHaveLength(0);
  });
});

describe('429 backoff (Invest reads)', () => {
  const waits = [];
  beforeEach(() => {
    waits.length = 0;
    setRetrySleepForTests(async (ms) => { waits.push(ms); });
  });
  afterEach(() => setRetrySleepForTests(null));

  it('retries a 429 with growing waits and then succeeds', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n++;
      if (n <= 2) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ values: [['nro-mf', 'India MF (NRO)', 'mf_in']] }) };
    }));
    const accounts = await fetchAccounts('s1', 'tok');
    expect(accounts[0].id).toBe('nro-mf');
    expect(n).toBe(3);
    expect(waits).toEqual([1000, 3000]);
  });

  it('gives up after the last delay and rethrows SHT-001', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    vi.stubGlobal('fetch', f);
    await expect(fetchSipPlans('s1', 'tok')).rejects.toMatchObject({ code: 'SHT-001' });
    expect(f).toHaveBeenCalledTimes(RETRY_429_DELAYS_MS.length + 1);
    expect(waits).toEqual(RETRY_429_DELAYS_MS);
  });

  it('does not retry other errors', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal('fetch', f);
    await expect(fetchAccounts('s1', 'tok')).rejects.toMatchObject({ code: 'SHT-001' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });

  it('withRetry429 passes through non-rate-limit errors untouched', async () => {
    const err = Object.assign(new Error('nope'), { code: 'AUTH-005' });
    await expect(withRetry429(async () => { throw err; }, { sleep: async () => {} })).rejects.toBe(err);
  });
});
