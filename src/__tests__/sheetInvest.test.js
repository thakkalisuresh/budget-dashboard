import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInvestSheet, ensureInvestSheet, fetchAccounts, updateAccount,
  appendActivity, appendActivities, fetchActivities, fetchRateWatch,
  deleteActivityByUUID, INVEST_TABS, ensureInvestTabs,
  writeEtfHoldings, readEtfHoldings, quarterKey, currentQuarterKey, isHoldingsFresh,
  appendRateHistory, fetchRateHistory, ensureRateHistoryTab, writeRateWatchDetails,
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
    // 3 seed accounts follow the header
    expect(accounts.data[0].rowData).toHaveLength(4);
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
      match: "'Accounts'!A2%3AH50", json: {
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
      match: "'Accounts'!A2%3AH50", json: {
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
      match: "'Accounts'!A2%3AH50", json: {
        values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
      },
    });
    await expect(updateAccount('inv123', 'tok', 'nope', {})).rejects.toThrow('Unknown account');
    mockFetch();
    routes.push({
      match: "'Accounts'!A2%3AH50", json: {
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
      match: "'Activities'!A2%3AI5000", json: {
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
      match: "'Activities'!A2%3AI5000", json: {
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
    routes.push({ match: "'Accounts'!A2%3AH50", json: {
      values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
    } });
    withRateHistoryTab();
    await updateAccount('inv123', 'tok', 'amex-hysa', { apy: 3.85 });

    const hist = calls.find(c => c.url.includes('RateHistory') && c.url.includes(':append'));
    expect(hist).toBeTruthy();
    expect(hist.body.values[0]).toEqual(['amex-hysa', 3.85, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 'manual']);
  });

  it('does NOT append RateHistory when only the balance changes', async () => {
    routes.push({ match: "'Accounts'!A2%3AH50", json: {
      values: [['amex-hysa', 'Amex', 'hysa', 'Amex', 3.7, 28400, '', 250000]],
    } });
    withRateHistoryTab();
    await updateAccount('inv123', 'tok', 'amex-hysa', { balance: 30000 });

    expect(calls.find(c => c.url.includes('RateHistory'))).toBeUndefined();
    expect(calls.find(c => c.url.includes('Snapshots'))).toBeTruthy();
  });

  it('honours an explicit rate-watch source (the confirmed-finding path)', async () => {
    routes.push({ match: "'Accounts'!A2%3AH50", json: {
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
    // Existing sheet predates EtfHoldings + RateHistory — every older tab present.
    routes.push({
      match: '?fields=sheets.properties.title',
      json: { sheets: ['Accounts', 'Activities', 'Snapshots', 'RateWatch'].map(t => ({ properties: { title: t } })) },
    });
    const added = await ensureInvestTabs('inv123', 'tok');
    expect(added).toEqual(['EtfHoldings', 'RateHistory']);

    const batch = calls.find(c => c.url.includes(':batchUpdate'));
    expect(batch.body.requests).toEqual([
      { addSheet: { properties: { title: 'EtfHoldings' } } },
      { addSheet: { properties: { title: 'RateHistory' } } },
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
