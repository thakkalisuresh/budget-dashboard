import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');

const { store, reportMock, sheetIdMock } = vi.hoisted(() => ({
  store: { tabs: {}, calls: [] },
  reportMock: vi.fn(async () => {}),
  sheetIdMock: vi.fn(async () => 'sheet-1'),
}));

// In-memory Invest sheet behind the server-side tab helpers.
vi.mock('../../functions/lib/_invest-sheets.mjs', () => ({
  getInvestSheetId: sheetIdMock,
  ensureInvestTabsServer: vi.fn(async (_id, tabs) => {
    store.calls.push(['ensure', Object.keys(tabs)]);
    for (const [t, h] of Object.entries(tabs)) if (!store.tabs[t]) store.tabs[t] = { header: h, rows: [] };
    return [];
  }),
  readInvestTabs: vi.fn(async (_id, specs) => specs.map(s => (store.tabs[s.title]?.rows || []).map(r => [...r]))),
  replaceInvestRows: vi.fn(async (_id, title, width, values) => { store.calls.push(['replace', title, values.length]); store.tabs[title].rows = values.map(r => [...r]); }),
}));
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: reportMock }));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_opts, fn) => fn }));

vi.stubGlobal('fetch', vi.fn(async (url) => {
  if (String(url).includes('oauth2/v3/userinfo')) return { ok: true, json: async () => ({ email: 'nair.sabarish97@gmail.com' }) };
  throw new Error(`unexpected network call in test: ${url}`);
}));

const { mfHoldings, mfHoldingsRefresh, runMonthlyHoldings, sheetsIo } = await import('../../functions/mf-holdings.mjs');

function req({ method = 'POST', origin = 'https://fundient-dashboard.web.app', secFetch = 'same-origin', auth = 'Bearer good-token', body = {} } = {}) {
  const headers = { origin, 'sec-fetch-site': secFetch, ...(auth ? { authorization: auth } : {}) };
  return { method, get: (h) => headers[h.toLowerCase()], body };
}
async function call(request) {
  let status = 200, sent; const headers = {};
  const res = {
    status(c) { status = c; return this; },
    set(h) { Object.assign(headers, typeof h === 'object' ? h : {}); return this; },
    send(s) { sent = s; return this; },
    end() { return this; },
  };
  await mfHoldings(request, res);
  let json; try { json = JSON.parse(sent); } catch { json = sent; }
  return { status, json, headers };
}
const post = (body) => call(req({ body }));

beforeEach(() => {
  store.tabs = {}; store.calls = [];
  reportMock.mockClear();
  sheetIdMock.mockResolvedValue('sheet-1');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T06:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('mf-holdings endpoint — gates & validation', () => {
  it('403s a bad origin / cross-site, 401s a bad bearer, 405s GET', async () => {
    expect((await call(req({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await call(req({ secFetch: 'cross-site' }))).status).toBe(403);
    expect((await call(req({ auth: null, body: { action: 'status' } }))).status).toBe(401);
    expect((await call(req({ method: 'GET' }))).status).toBe(405);
  });

  it('answers the CORS preflight', async () => {
    const r = await call(req({ method: 'OPTIONS' }));
    expect(r.status).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('https://fundient-dashboard.web.app');
  });

  it('400s unknown actions and malformed refresh inputs', async () => {
    expect((await post({ action: 'nope' })).status).toBe(400);
    expect((await post({ action: 'refresh', asOf: '2026-08-15' })).status).toBe(400);
    expect((await post({ action: 'refresh', asOf: '2026-01-31' })).status).toBe(400);
    expect((await post({ action: 'refresh', houses: ['hdfc'] })).status).toBe(400);
    expect((await post({ action: 'refresh', houses: [] })).status).toBe(400);
    expect((await post({ action: 'refresh', force: 'yes' })).status).toBe(400);
    expect((await post({ action: 'refresh', itiUrl: 5 })).status).toBe(400);
    expect((await post({ action: 'refresh', itiUrl: 'x'.repeat(301) })).status).toBe(400);
  });

  it('409s when the Invest sheet is not provisioned yet', async () => {
    sheetIdMock.mockResolvedValue(null);
    expect((await post({ action: 'status' })).status).toBe(409);
  });
});

describe('mf-holdings endpoint — behaviour', () => {
  it('status creates the tabs on an old sheet and returns an empty status', async () => {
    const r = await post({ action: 'status' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ action: 'status', target: '2026-09-30', status: [] });
    expect(store.calls[0]).toEqual(['ensure', ['MfHoldings', 'MfHoldingsStatus']]);
  });

  it('ITI without a link is recorded as missing with an actionable reason (no network)', async () => {
    const r = await post({ action: 'refresh', houses: ['iti'] });
    expect(r.status).toBe(200);
    expect(r.json.houses.iti.status).toBe('missing');
    const s = r.json.status.find(x => x.fundKey === 'iti-small-cap');
    expect(s).toMatchObject({ status: 'missing' });
    expect(s.reason).toMatch(/itiUrl/);
    expect(reportMock).not.toHaveBeenCalled();          // "not published / not supplied" is not an error
  });

  it('an invalid itiUrl is a failure, reported with the INV-001 stage tag, never fetched', async () => {
    const r = await post({ action: 'refresh', houses: ['iti'], itiUrl: 'https://evil.example/a.xlsx' });
    expect(r.json.houses.iti.status).toBe('failed');
    expect(reportMock).toHaveBeenCalledWith('INV-001', expect.any(Error), expect.objectContaining({ stage: 'mf-holdings', house: 'iti' }));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('evil.example'), expect.anything());
  });

  it('rejects a concurrent refresh with 409 retryable', async () => {
    // Hold the first refresh open by blocking the sheet read.
    const { readInvestTabs } = await import('../../functions/lib/_invest-sheets.mjs');
    let release;
    readInvestTabs.mockImplementationOnce(() => new Promise(r => { release = () => r([[], []]); }));
    const first = post({ action: 'refresh', houses: ['iti'] });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await post({ action: 'refresh', houses: ['iti'] });
    expect(second.status).toBe(409);
    expect(second.json.retryable).toBe(true);
    release();
    expect((await first).status).toBe(200);
  });
});

describe('sheetsIo round trip', () => {
  it('writes holdings then status, and reads them back as objects', async () => {
    const io = sheetsIo('sheet-1');
    const holdings = [{ asOf: '2026-09-30', fundKey: 'iti-small-cap', isin: 'INE00FF01025', name: 'Acutaas', industry: 'Pharma', assetClass: 'equity', weightPct: 3.55, marketValueInrLakh: 13006.56, sourceFile: 'iti:f#ITISCF' }];
    const status = [{ fundKey: 'iti-small-cap', asOf: '2026-09-30', status: 'ok', checkedAt: '2026-10-10T06:00:00.000Z', rowCount: 1, weightSum: 3.55, reason: '', sourceFile: 'iti:f#ITISCF' }];
    await io.read();                                    // creates the tabs
    await io.write({ holdings, status });
    expect(store.calls.filter(c => c[0] === 'replace').map(c => c[1])).toEqual(['MfHoldings', 'MfHoldingsStatus']);
    expect(await io.read()).toEqual({ holdings, status });
  });
});

describe('scheduled job', () => {
  it('does nothing outside the day 8-12 window', async () => {
    vi.setSystemTime(new Date('2026-10-20T06:00:00Z'));
    await mfHoldingsRefresh({});
    expect(store.calls).toEqual([]);
  });

  it('inside the window it runs once for the previous month-end and records per-house status', async () => {
    const miss = vi.fn(async () => { const { MfFetchError } = await import('../../functions/lib/_mf-holdings.mjs'); throw new MfFetchError('missing', 'not published yet (HTTP 404)'); });
    const impl = { absl: { fetch: miss, parse: vi.fn() }, sbi: { fetch: miss, parse: vi.fn() }, iti: { fetch: miss, parse: vi.fn() } };
    const memory = { holdings: [], status: [] };
    const io = { read: async () => ({ ...memory }), write: async (d) => { Object.assign(memory, d); } };
    const out = await runMonthlyHoldings({ now: new Date('2026-10-10T06:00:00Z'), io, impl });
    expect(out.target).toBe('2026-09-30');
    expect(Object.values(out.houses).map(h => h.status)).toEqual(['missing', 'missing', 'missing']);
    expect(memory.status).toHaveLength(7);
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('a scheduled run swallows an unexpected error into INV-001 (never throws)', async () => {
    sheetIdMock.mockRejectedValue(new Error('settings down'));
    await expect(mfHoldingsRefresh({})).resolves.toBeUndefined();
    expect(reportMock).toHaveBeenCalledWith('INV-001', expect.any(Error), expect.objectContaining({ stage: 'mf-holdings-run' }));
  });

  it('skips quietly when no Invest sheet is provisioned', async () => {
    sheetIdMock.mockResolvedValue(null);
    expect(await runMonthlyHoldings({ now: new Date('2026-10-10T06:00:00Z') })).toEqual({ ran: false, reason: 'no_invest_sheet' });
  });
});
