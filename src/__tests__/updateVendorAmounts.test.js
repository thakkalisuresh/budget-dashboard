import { describe, it, expect, vi, beforeEach } from 'vitest';

// updateVendorAmounts runs in the browser; stub the bits it touches.
vi.stubGlobal('navigator', { onLine: true });

const mockFetch = vi.fn();
global.fetch = mockFetch;

const { updateVendorAmounts } = await import('../sheetExpenses.js');

const SHEET_ID = 'test-sheet-id';
const TOKEN = 'test-token';

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(data) };
}

/**
 * URL-routed fetch mock covering the History reads appendHistoryEntry makes.
 * Every write (PUT/POST) succeeds and is recorded in `calls`.
 */
function routeFetch() {
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
    return Promise.resolve(jsonResponse({}));
  });
  return calls;
}

const clearsOf = (calls) => calls.filter(c => c.url.includes(':batchClear'));

beforeEach(() => {
  vi.clearAllMocks();
  navigator.onLine = true;
});

describe('updateVendorAmounts — delete path (amounts = [])', () => {
  // Regression: Travel/Holiday V2 rows have uuidCol 7, so uuidCol + 19 = 26,
  // which colLetter turned into '[' (past Z) and the Sheets API rejected with 400.
  it('caps the clear range at column Z for a Travel V2 row', async () => {
    const calls = routeFetch();

    await updateVendorAmounts('Travel', 5, [], TOKEN, SHEET_ID, 'Delta', 120, [], true);

    const clears = clearsOf(calls);
    expect(clears).toHaveLength(1);
    expect(clears[0].body.ranges).toEqual(["'Travel'!A5:Z5"]);
  });

  it('caps the clear range at column Z for a Holiday V2 row', async () => {
    const calls = routeFetch();

    await updateVendorAmounts('Holiday', 8, [], TOKEN, SHEET_ID, 'Airbnb', 300, [], true);

    const clears = clearsOf(calls);
    expect(clears).toHaveLength(1);
    expect(clears[0].body.ranges).toEqual(["'Holiday'!A8:Z8"]);
  });

  it('still clears through Z for a non-Travel V2 row (uuidCol 6)', async () => {
    const calls = routeFetch();

    await updateVendorAmounts('Grocery', 3, [], TOKEN, SHEET_ID, 'Costco', 80, [], true);

    const clears = clearsOf(calls);
    expect(clears).toHaveLength(1);
    expect(clears[0].body.ranges).toEqual(["'Grocery'!A3:Z3"]);
  });

  it('never emits a column letter past Z in any clear range', async () => {
    const calls = routeFetch();

    await updateVendorAmounts('Travel', 5, [], TOKEN, SHEET_ID, 'Delta', 120, [], true);

    for (const c of clearsOf(calls)) {
      for (const range of c.body.ranges) {
        expect(range).toMatch(/^'[^']+'!A\d+:[A-Z]\d+$/);
      }
    }
  });
});
