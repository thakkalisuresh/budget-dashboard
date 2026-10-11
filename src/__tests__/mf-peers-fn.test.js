import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com,viewer@example.com');
vi.stubEnv('VIEWER_EMAILS', 'viewer@example.com');

const { store, reportMock, sheetIdMock } = vi.hoisted(() => ({
  store: { tabs: {}, calls: [] },
  reportMock: vi.fn(async () => {}),
  sheetIdMock: vi.fn(async () => 'sheet-1'),
}));

vi.mock('../../functions/lib/_invest-sheets.mjs', () => ({
  getInvestSheetId: sheetIdMock,
  ensureInvestTabsServer: vi.fn(async (_id, tabs) => {
    store.calls.push(['ensure', Object.keys(tabs)]);
    for (const [t, h] of Object.entries(tabs)) if (!store.tabs[t]) store.tabs[t] = { header: h, rows: [] };
    return [];
  }),
  readInvestTabs: vi.fn(async (_id, specs) => specs.map((s) => {
    if (!store.tabs[s.title]) throw new Error('Invest Sheets API (400): Unable to parse range');
    return store.tabs[s.title].rows.map((r) => [...r]);
  })),
  replaceInvestRows: vi.fn(async (_id, title, _w, values) => { store.calls.push(['replace', title, values.length]); store.tabs[title].rows = values.map((r) => [...r]); }),
}));
vi.mock('../../functions/lib/_error-log.mjs', () => ({ reportError: reportMock }));
vi.mock('firebase-functions/v2/scheduler', () => ({ onSchedule: (_opts, fn) => fn }));
vi.mock('../../functions/lib/_mf-nav.mjs', () => ({
  getSchemes: async () => ({ byCode: new Map([['1001', { date: '2026-10-09' }], ['1002', { date: '2026-10-09' }]]) }),
}));
const getText = vi.fn();
vi.mock('../../functions/lib/mf-peers/_http.mjs', async (orig) => ({ ...(await orig()), makeClient: () => ({ getText }) }));

vi.stubGlobal('fetch', vi.fn(async (url, init) => {
  if (String(url).includes('oauth2/v3/userinfo')) {
    const auth = init?.headers?.Authorization || '';
    const email = /viewer-token/.test(auth) ? 'viewer@example.com' : /stranger-token/.test(auth) ? 'stranger@example.com' : 'nair.sabarish97@gmail.com';
    return { ok: true, json: async () => ({ email }) };
  }
  throw new Error(`unexpected network call in test: ${url}`);
}));

const { mfPeers, mfPeersHeldRefresh, mfPeersMonthlyRefresh, scopesFor, sheetsIo, _setDepsForTests } = await import('../../functions/mf-peers.mjs');

function mfBody(code) {
  const rows = []; let nav = 100; let t = Date.parse('2020-01-01T00:00:00Z'); const e = Date.parse('2026-10-09T00:00:00Z');
  for (; t <= e; t += 86_400_000) {
    const d = new Date(t); if ([0, 6].includes(d.getUTCDay())) continue;
    nav *= 1.0004; const iso = d.toISOString().slice(0, 10);
    rows.push({ date: `${iso.slice(8)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`, nav: nav.toFixed(4) });
  }
  return JSON.stringify({ meta: { scheme_code: code }, data: rows.reverse() });
}

const CONFIG_ROW = ['cat-a', 'held', 'held-a', 'AMC', 'Held A', '1001', '1002', '', '2020-01-01', '', false, true, ''];

function req({ method = 'POST', origin = 'https://fundient-dashboard.web.app', secFetch = 'same-origin', auth = 'Bearer good-token', body = {} } = {}) {
  const headers = { origin, 'sec-fetch-site': secFetch, ...(auth ? { authorization: auth } : {}) };
  return { method, get: (h) => headers[h.toLowerCase()], body };
}
async function call(request) {
  let status = 200; let sent; const headers = {};
  const res = {
    status(c) { status = c; return this; },
    set(h) { Object.assign(headers, typeof h === 'object' ? h : {}); return this; },
    send(s) { sent = s; return this; },
    end() { return this; },
  };
  await mfPeers(request, res);
  let json; try { json = JSON.parse(sent); } catch { json = sent; }
  return { status, json, headers };
}
const post = (body, auth) => call(req({ body, ...(auth ? { auth } : {}) }));

beforeEach(() => {
  _setDepsForTests({ sleep: async () => {} }); // no real 5 s retry pauses
  store.tabs = {}; store.calls = [];
  store.tabs.MfPeersConfig = { header: [], rows: [[...CONFIG_ROW]] };
  reportMock.mockClear(); getText.mockReset();
  getText.mockImplementation(async (url) => ({ status: 200, text: mfBody(/\/mf\/(\d+)$/.exec(url)[1]) }));
  sheetIdMock.mockResolvedValue('sheet-1');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-11T04:00:00+05:30'));
});

describe('mf-peers endpoint — gates', () => {
  it('403s a bad origin / cross-site, 401s a bad bearer, 405s GET', async () => {
    expect((await call(req({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await call(req({ secFetch: 'cross-site' }))).status).toBe(403);
    expect((await call(req({ auth: null, body: { action: 'status' } }))).status).toBe(401);
    expect((await call(req({ method: 'GET' }))).status).toBe(405);
  });
  it('rejects a Google user outside ALLOWED_EMAILS on every action', async () => {
    for (const body of [{ action: 'status' }, { action: 'refresh', scope: 'held' }]) expect((await post(body, 'Bearer stranger-token')).status).toBe(401);
    expect(store.calls).toEqual([]);
  });
  it('lets read-only viewers call status, but 403s refresh (no read, no write, no network)', async () => {
    expect((await post({ action: 'status' }, 'Bearer viewer-token')).status).toBe(200);
    store.calls = [];
    for (const body of [{ action: 'refresh' }, { action: 'refresh', scope: 'held' }, { action: 'refresh', scope: 'nope' }]) {
      const r = await post(body, 'Bearer viewer-token');
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json).toEqual({ ok: false, error: 'Read-only users cannot refresh peers' });
    }
    expect(store.calls).toEqual([]);
    expect(getText).not.toHaveBeenCalled();
  });
  it('answers the CORS preflight', async () => {
    const r = await call(req({ method: 'OPTIONS' }));
    expect(r.status).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBe('https://fundient-dashboard.web.app');
  });
  it('400s unknown actions, scopes and malformed force; 409s without an Invest sheet', async () => {
    expect((await post({ action: 'nope' })).status).toBe(400);
    expect((await post({ action: 'refresh', scope: 'weekly' })).status).toBe(400);
    expect((await post({ action: 'refresh', force: 'yes' })).status).toBe(400);
    sheetIdMock.mockResolvedValue(null);
    expect((await post({ action: 'status' })).status).toBe(409);
    expect((await post({ action: 'refresh' })).status).toBe(409);
  });
});

describe('mf-peers endpoint — behaviour', () => {
  it('scopesFor: all = peers, ter, held (held last so it sees fresh month-end series)', () => {
    expect(scopesFor('all')).toEqual(['peers', 'ter', 'held']);
    expect(scopesFor('held')).toEqual(['held']);
    expect(scopesFor('x')).toBeNull();
  });

  it('status creates the five tabs on an old sheet and returns run rows + status counts', async () => {
    const r = await post({ action: 'status' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ action: 'status', run: [], counts: {} });
    expect(store.calls[0]).toEqual(['ensure', ['MfPeersConfig', 'MfPeers', 'MfTer', 'MfPeersSeries', 'MfPeersRun']]);
  });

  it('refresh scope=held does one slice, writes the tabs, and reports done/remaining', async () => {
    const r = await post({ action: 'refresh', scope: 'held' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ action: 'refresh', done: true, remaining: 0 });
    expect(r.json.scopes[0]).toMatchObject({ scope: 'held', ok: 2, failed: 0, total: 2 });
    expect(store.tabs.MfPeers.rows).toHaveLength(2);
    expect(store.tabs.MfPeersSeries.rows).toHaveLength(2);
    expect(store.tabs.MfPeersRun.rows[0][0]).toBe('held');
    const s = await post({ action: 'status' });
    expect(s.json.counts).toEqual({ ok: 2 });
    expect(s.json.run[0]).toMatchObject({ scope: 'held', done: 2, total: 2 });
  });

  it('failures are reported once per scope through INV-001 with a stage tag (no new error code)', async () => {
    getText.mockImplementation(async () => { throw Object.assign(new Error('phase=nav-fetch host=api.mfapi.in cause=ECONNRESET: x')); });
    const r = await post({ action: 'refresh', scope: 'held' });
    expect(r.status).toBe(200);
    expect(r.json.scopes[0].failed).toBe(2);
    expect(r.json.scopes[0].failures[0].reason).toContain('phase=nav-fetch host=api.mfapi.in');
    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock).toHaveBeenCalledWith('INV-001', expect.any(Error), { stage: 'mf-peers-held' });
  });

  it('409s (retryable) while a refresh is already running', async () => {
    let release; const hold = new Promise((r) => { release = r; });
    getText.mockImplementation(async (url) => { await hold; return { status: 200, text: mfBody(/\/mf\/(\d+)$/.exec(url)[1]) }; });
    const first = post({ action: 'refresh', scope: 'held' });
    await vi.waitFor(() => expect(getText).toHaveBeenCalled());
    const second = await post({ action: 'refresh', scope: 'held' });
    expect(second.status).toBe(409);
    expect(second.json).toMatchObject({ retryable: true });
    release();
    expect((await first).status).toBe(200);
    expect((await post({ action: 'refresh', scope: 'held' })).status).toBe(200);
  });
});

describe('scheduled functions', () => {
  it('weekly held run refreshes the held scope', async () => {
    await mfPeersHeldRefresh();
    expect(store.tabs.MfPeers.rows).toHaveLength(2);
    expect(store.tabs.MfPeersRun.rows.map((r) => r[0])).toEqual(['held']);
  });
  it('monthly run does peers then ter; with no peers configured it still completes', async () => {
    store.tabs.MfPeersConfig.rows = [[...CONFIG_ROW]];
    vi.setSystemTime(new Date('2026-10-03T03:00:00+05:30'));
    getText.mockImplementation(async (url) => {
      if (/\/mf\//.test(url)) return { status: 200, text: mfBody('x') };
      if (url.includes('populate-sub-category')) return { status: 200, text: '[]' };
      return { status: 200, text: JSON.stringify({ data: [], meta: { pageCount: 0 } }) };
    });
    await mfPeersMonthlyRefresh();
    expect(store.tabs.MfPeersRun.rows.map((r) => r[0])).toEqual(['peers', 'ter']);
    expect(store.tabs.MfTer.rows).toHaveLength(2);
    expect(store.tabs.MfTer.rows[0][7]).toBe(false);
  });
  it('a crash is reported with the run stage and never thrown out of the scheduler', async () => {
    sheetIdMock.mockRejectedValue(new Error('sheets down'));
    await expect(mfPeersHeldRefresh()).resolves.toBeUndefined();
    expect(reportMock).toHaveBeenCalledWith('INV-001', expect.any(Error), { stage: 'mf-peers-held-run' });
  });
  it('skips quietly when no Invest sheet exists', async () => {
    sheetIdMock.mockResolvedValue(null);
    await mfPeersHeldRefresh();
    expect(store.calls).toEqual([]);
  });
});

describe('sheetsIo', () => {
  it('reads SipPlans optionally: a sheet without that tab still reads', async () => {
    const st = await sheetsIo('s').read();
    expect(st.sip).toEqual([]);
    expect(st.config).toHaveLength(1);
  });
});
