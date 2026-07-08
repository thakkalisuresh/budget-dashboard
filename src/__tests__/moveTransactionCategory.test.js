import { describe, it, expect, vi, beforeEach } from 'vitest';

// moveTransactionCategory runs in the browser; stub the bits it touches.
vi.stubGlobal('navigator', { onLine: true });

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { moveTransactionCategory } = await import('../sheetExpenses.js');

const SHEET_ID = 'test-sheet-id';
const TOKEN = 'test-token';
const MONTH = 'July 2026';

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) };
}

// V2 header row: col C (index 2) === 'Date' triggers detectV2.
const V2_HEADER = ['Month', 'Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'UUID'];
const V1_HEADER = ['Month', 'Year', 'Description', 'Amount'];

/**
 * URL-routed fetch mock. `tabs` maps tab name → values array returned for its
 * fetchRaw read. Every write (PUT/POST) succeeds and is recorded in `calls`.
 */
function routeFetch(tabs) {
  const calls = [];
  mockFetch.mockImplementation((url, options = {}) => {
    const u = decodeURIComponent(url);
    calls.push({ url: u, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (u.includes('?fields=sheets.properties.title')) {
      return Promise.resolve(jsonResponse({ sheets: [{ properties: { title: 'History' } }] }));
    }
    if (u.includes("'History'!A:A")) {
      return Promise.resolve(jsonResponse({ values: [['Timestamp']] }));
    }
    if (u.includes('!A1:Z10000')) {
      for (const [tab, values] of Object.entries(tabs)) {
        if (u.includes(`'${tab}'!`)) return Promise.resolve(jsonResponse({ values }));
      }
      return Promise.resolve(jsonResponse({ values: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  });
  return calls;
}

const putsTo = (calls, tab) =>
  calls.filter(c => c.method === 'PUT' && c.url.includes(`'${tab}'!`));
const clearsOf = (calls) =>
  calls.filter(c => c.url.includes(':batchClear'));
const historyPuts = (calls) =>
  calls.filter(c => c.method === 'PUT' && c.url.includes("'History'!A"));

beforeEach(() => {
  vi.clearAllMocks();
  navigator.onLine = true;
});

describe('moveTransactionCategory', () => {
  const v2Row = {
    rowIndex: 5,
    description: 'Safeway',
    amounts: [42.1],
    uuids: ['tx_4210_abcd1234'],
    date: '2026-07-03',
    paymentMethod: 'Chase Freedom',
    bookingMethod: '',
    _v2: true,
  };

  it('no-ops when source and destination are the same', async () => {
    routeFetch({});
    await moveTransactionCategory('Grocery', 'Grocery', v2Row, TOKEN, SHEET_ID, MONTH);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws offline without touching the sheet', async () => {
    routeFetch({});
    navigator.onLine = false;
    await expect(
      moveTransactionCategory('Grocery', 'Misc', v2Row, TOKEN, SHEET_ID, MONTH)
    ).rejects.toThrow(/offline/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws on unknown destination category', async () => {
    routeFetch({});
    await expect(
      moveTransactionCategory('Grocery', 'Nope', v2Row, TOKEN, SHEET_ID, MONTH)
    ).rejects.toThrow('Unknown category: Nope');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('V2→V2 whole-row move: writes destination first, preserves UUID, clears source, logs one Moved entry', async () => {
    const calls = routeFetch({ Misc: [V2_HEADER, ['Jul', 2026, '2026-07-01', 'Old', 9.99, '', 'tx_999_old']] });

    await moveTransactionCategory('Grocery', 'Misc', v2Row, TOKEN, SHEET_ID, MONTH);

    // Destination row: same UUID, date, card; correct V2 shape (7 cols, uuid last)
    const destPut = putsTo(calls, 'Misc')[0];
    expect(destPut).toBeTruthy();
    expect(destPut.url).toContain('valueInputOption=RAW');
    const written = destPut.body.values[0];
    expect(written).toEqual(['July', 2026, '2026-07-03', 'Safeway', 42.1, 'Chase Freedom', 'tx_4210_abcd1234']);
    // Lands after the last data row (row 2 has data → next is row 3)
    expect(destPut.url).toContain("'Misc'!A3:G3");

    // Source row cleared (batchClear on the Grocery row)
    const clears = clearsOf(calls);
    expect(clears).toHaveLength(1);
    expect(clears[0].body.ranges[0]).toContain("'Grocery'!A5:");

    // Destination write happens before the source clear
    expect(calls.indexOf(destPut)).toBeLessThan(calls.indexOf(clears[0]));

    // Exactly one history entry: Moved, from → to
    const hist = historyPuts(calls);
    expect(hist).toHaveLength(1);
    const hRow = hist[0].body.values[0];
    expect(hRow[1]).toBe('Moved');
    expect(hRow[2]).toBe('Misc');
    expect(hRow[3]).toBe('Safeway');
    expect(hRow[4]).toBe(42.1);
    expect(hRow[5]).toBe('Grocery → Misc');
    expect(hRow[8]).toBe('tx_4210_abcd1234');
  });

  it('Travel destination gets the 8-col schema with booking method and uuid at col H', async () => {
    const calls = routeFetch({ Travel: [V2_HEADER] });

    await moveTransactionCategory('Grocery', 'Travel', { ...v2Row, bookingMethod: 'direct' }, TOKEN, SHEET_ID, MONTH);

    const destPut = putsTo(calls, 'Travel')[0];
    const written = destPut.body.values[0];
    expect(written).toHaveLength(8);
    expect(written[6]).toBe('direct');
    expect(written[7]).toBe('tx_4210_abcd1234');
    expect(destPut.url).toContain(':H');
  });

  it('single-amount move out of a multi-amount V1 row leaves the rest in place', async () => {
    const v1Row = {
      rowIndex: 4,
      description: 'Costco',
      amounts: [10, 20, 30],
      uuids: ['tx_1000_a', 'tx_2000_b', 'tx_3000_c'],
      date: '',
      paymentMethod: '',
      bookingMethod: '',
      _v2: false,
    };
    const calls = routeFetch({ Misc: [V2_HEADER] });

    await moveTransactionCategory('Grocery', 'Misc', v1Row, TOKEN, SHEET_ID, MONTH, 1);

    // Destination got only the 20 with its own uuid
    const destPut = putsTo(calls, 'Misc')[0];
    expect(destPut.body.values[0][4]).toBe(20);
    expect(destPut.body.values[0][6]).toBe('tx_2000_b');

    // Source NOT cleared — rewritten as remaining formula + uuids
    expect(clearsOf(calls)).toHaveLength(0);
    const srcPuts = putsTo(calls, 'Grocery');
    const amtPut  = srcPuts.find(c => c.body.values[0][0] === '=10+30');
    expect(amtPut).toBeTruthy();
    const uuidPut = srcPuts.find(c => Array.isArray(c.body.values[0]) && c.body.values[0][0] === 'tx_1000_a');
    expect(uuidPut).toBeTruthy();
    expect(uuidPut.body.values[0][1]).toBe('tx_3000_c');
    expect(uuidPut.body.values[0][2]).toBe(''); // removed uuid blanked out
  });

  it('V1 destination with an existing vendor row merges into its formula and appends uuids', async () => {
    const v1Dest = [
      V1_HEADER,
      ['Jul', 2026, 'Costco', '=5+7', 'tx_500_x', 'tx_700_y'],
    ];
    const calls = routeFetch({ Misc: v1Dest });
    const row = {
      rowIndex: 9, description: 'Costco', amounts: [12.5], uuids: ['tx_1250_z'],
      date: '', paymentMethod: '', bookingMethod: '', _v2: false,
    };

    // 'May 2026' is pre-V2, so the destination is treated as V1
    await moveTransactionCategory('Grocery', 'Misc', row, TOKEN, SHEET_ID, 'May 2026');

    const destPuts = putsTo(calls, 'Misc');
    const amtPut = destPuts.find(c => c.body.values[0][0] === '=5+7+12.5');
    expect(amtPut).toBeTruthy();
    expect(amtPut.url).toContain("'Misc'!D2");
    // uuid appended after the two existing ones (uuidStartCol 4 + 2 → col G)
    const uuidPut = destPuts.find(c => c.body.values[0][0] === 'tx_1250_z');
    expect(uuidPut).toBeTruthy();
    expect(uuidPut.url).toContain("'Misc'!G2");
  });

  it('invalidates both categories in the detail cache', async () => {
    // Covered indirectly: a failed invalidation would throw synchronously.
    const calls = routeFetch({ Misc: [V2_HEADER] });
    await expect(
      moveTransactionCategory('Grocery', 'Misc', v2Row, TOKEN, SHEET_ID, MONTH)
    ).resolves.toBeUndefined();
    expect(putsTo(calls, 'Misc')).toHaveLength(1);
  });
});
