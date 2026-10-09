import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');

// A trimmed NAVAll.txt carrying the real quirks: per-category and per-AMC
// header lines, blank lines, N.A. NAVs, blank Plan/Option columns, option text
// variants (GROWTH / Growth Option / IDCW Payout), closed-ended rows.
const NAV_ALL = [
  'Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date',
  ' ',
  'Open Ended Schemes(Equity Scheme - Small Cap Fund)',
  ' ',
  'ITI Mutual Fund',
  ' ',
  '147919;INF00XX01747;-;ITI Small Cap Fund;Direct Plan;Growth Option;37.2823;09-Oct-2026',
  '147917;INF00XX01754;INF00XX01762;ITI Small Cap Fund;Direct Plan;IDCW Option;35.3431;09-Oct-2026',
  '147920;INF00XX01713;-;ITI Small Cap Fund;Regular Plan;Growth Option;32.9929;09-Oct-2026',
  '147918;INF00XX01721;INF00XX01739;ITI Small Cap Fund;Regular Plan;IDCW Option;31.1066;09-Oct-2026',
  ' ',
  'Open Ended Schemes(Equity Scheme - Flexi Cap Fund)',
  ' ',
  'Aditya Birla Sun Life Mutual Fund',
  ' ',
  '103166;INF209K01AJ8;-;Aditya Birla Sun Life Flexi Cap Fund;Regular Plan;GROWTH;1868.58;09-Oct-2026',
  '120564;INF209K01XX1;-;Aditya Birla Sun Life Flexi Cap Fund;Direct Plan;GROWTH;2108.34;09-Oct-2026',
  '153125;INF209KC1381;-;Aditya Birla Sun Life Conglomerate Fund;Direct Plan;IDCW Payout;10.23;09-Oct-2026',
  '153124;INF209KC1373;-;Aditya Birla Sun Life Conglomerate Fund;Direct Plan;GROWTH;10.22;09-Oct-2026',
  ' ',
  'Open Ended Schemes(Other Scheme - Retirement)',
  ' ',
  'SBI Mutual Fund',
  ' ',
  '148685;INF200KA1S97;-;SBI Retirement Benefit Fund - Aggressive Hybrid Plan;Direct Plan;Growth;20.0289;09-Oct-2026',
  '148683;INF200KA1S55;-;SBI Retirement Benefit Fund - Aggressive Plan;Direct Plan;Growth;20.6600;09-Oct-2026',
  '148690;INF200KA1T70;-;SBI Retirement Benefit Fund - Conservative Hybrid Plan;Direct Plan;Growth;16.0581;09-Oct-2026',
  '148692;INF200KA1T54;-;SBI Retirement Benefit Fund - Conservative Hybrid Plan;Regular Plan;Growth;15.5300;09-Oct-2026',
  '148699;INF200KA1T99;-;SBI Retirement Benefit Fund - Conservative Plan;Direct Plan;Growth;N.A.;09-Oct-2026',
  ' ',
  'Open Ended Schemes(Debt Scheme - Banking and PSU Fund)',
  ' ',
  'Name-Only Plan Mutual Fund',
  ' ',
  '111111;INF000000001;-;Sample Dynamic Bond Fund - Direct Plan - Monthly IDCW;;;11.5;09-Oct-2026',
  ' ',
  'Close Ended Schemes(Income)',
  ' ',
  'Some Mutual Fund',
  ' ',
  '222222;INF000000002;-;Some Fixed Maturity Plan Series 99;;;10.1;09-Oct-2026',
  '',
].join('\r\n');

const mfapiCalls = [];
const amfiHistCalls = [];
const navAllCalls = [];
const ctl = {
  userinfoOk: true,
  navAllOk: true,
  navAllGate: null, // a Promise the NAVAll fetch awaits before answering
  mfapiOk: true,
  amfiHistOk: true,
  fxOk: true,
};

// mfapi.in range response: only trading days, newest first, DD-MM-YYYY.
const MFAPI_DATA = [
  { date: '30-09-2026', nav: '37.83670' },
  { date: '29-09-2026', nav: '37.96730' },
  { date: '28-09-2026', nav: '37.82950' },
  { date: '25-09-2026', nav: '38.49420' }, // Fri — 26/27 Sep are a weekend
];

vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('googleapis.com/oauth2/v3/userinfo')) {
    return { ok: ctl.userinfoOk, json: async () => ({ email: 'nair.sabarish97@gmail.com' }) };
  }
  if (u.includes('portal.amfiindia.com/spages/NAVAll.txt')) {
    navAllCalls.push(u);
    if (ctl.navAllGate) await ctl.navAllGate;
    if (!ctl.navAllOk) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, status: 200, text: async () => NAV_ALL };
  }
  if (u.includes('api.mfapi.in/mf/')) {
    mfapiCalls.push(u);
    if (!ctl.mfapiOk) return { ok: false, status: 502, json: async () => ({}) };
    const code = u.match(/\/mf\/(\d+)/)[1];
    if (code === '999999') return { ok: true, status: 200, json: async () => ({ status: 'ERROR', data: [] }) };
    const start = new URL(u).searchParams.get('startDate');
    const end = new URL(u).searchParams.get('endDate');
    const iso = (d) => d.split('-').reverse().join('-');
    const data = MFAPI_DATA.filter(r => iso(r.date) >= start && iso(r.date) <= end);
    return { ok: true, status: 200, json: async () => ({ meta: { scheme_code: Number(code) }, data, status: 'SUCCESS' }) };
  }
  if (u.includes('DownloadNAVHistoryReport_Po.aspx')) {
    amfiHistCalls.push(u);
    if (!ctl.amfiHistOk) return { ok: false, status: 500, text: async () => '' };
    const text = [
      'Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Net Asset Value;Date',
      '',
      'Open Ended Schemes ( Equity )',
      '',
      '147919;ITI Small Cap Fund - Direct Plan - Growth Option;Direct Plan;Growth Option;INF00XX01747;;37.5000;29-Sep-2026',
      '147919;ITI Small Cap Fund - Direct Plan - Growth Option;Direct Plan;Growth Option;INF00XX01747;;37.4000;30-Sep-2026',
      '147920;ITI Small Cap Fund - Regular Plan - Growth Option;Regular Plan;Growth Option;INF00XX01713;;31.0000;30-Sep-2026',
    ].join('\r\n');
    return { ok: true, status: 200, text: async () => text };
  }
  if (u.includes('open.er-api.com')) {
    if (!ctl.fxOk) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ rates: { INR: 83.25, USD: 1 }, time_last_update_unix: 1791504000 }) };
  }
  throw new Error('unexpected fetch ' + u);
}));

const { mfNav } = await import('../../functions/mf-nav.mjs');
const lib = await import('../../functions/lib/_mf-nav.mjs');
const { getRate, _resetRatesCache } = await import('../../functions/lib/_currency.mjs');

function req({ method = 'POST', origin = 'https://fundient-dashboard.web.app', secFetch = 'same-origin', auth = 'Bearer good-token', body = {} } = {}) {
  const headers = {
    origin, 'sec-fetch-site': secFetch,
    ...(auth ? { authorization: auth } : {}),
    'content-length': '99',
  };
  return { method, get: (h) => headers[h.toLowerCase()], body, rawBody: Buffer.from(JSON.stringify(body)) };
}

async function call(request) {
  let status = 200, sent, headers = {};
  const res = {
    status(c) { status = c; return this; },
    set(h) { Object.assign(headers, typeof h === 'object' ? h : {}); return this; },
    send(s) { sent = s; return this; },
    end() { return this; },
  };
  await mfNav(request, res);
  let json;
  try { json = JSON.parse(sent); } catch { json = sent; }
  return { status, json, headers };
}

const post = (body) => call(req({ body }));

beforeEach(() => {
  mfapiCalls.length = 0; amfiHistCalls.length = 0; navAllCalls.length = 0;
  Object.assign(ctl, { userinfoOk: true, navAllOk: true, navAllGate: null, mfapiOk: true, amfiHistOk: true, fxOk: true });
  _resetRatesCache();
  lib._resetForTests();
});

describe('parseNavAll', () => {
  it('skips headers, blanks and category lines; normalises dates; N.A. → null NAV', () => {
    const list = lib.parseNavAll(NAV_ALL);
    expect(list.length).toBe(15);
    const iti = list.find(s => s.code === '147919');
    expect(iti).toMatchObject({
      name: 'ITI Small Cap Fund', amc: 'ITI Mutual Fund', nav: 37.2823, date: '2026-10-09',
      plan: 'direct', option: 'growth', openEnded: true,
    });
    expect(list.find(s => s.code === '148699').nav).toBeNull();
  });

  it('infers option variants and falls back to the name when Plan/Option are blank', () => {
    const byCode = Object.fromEntries(lib.parseNavAll(NAV_ALL).map(s => [s.code, s]));
    expect(byCode['120564']).toMatchObject({ plan: 'direct', option: 'growth' }); // GROWTH
    expect(byCode['153125']).toMatchObject({ plan: 'direct', option: 'idcw' });   // IDCW Payout
    expect(byCode['147918']).toMatchObject({ plan: 'regular', option: 'idcw' });
    expect(byCode['111111']).toMatchObject({ plan: 'direct', option: 'idcw' });   // from the name
    expect(byCode['222222']).toMatchObject({ plan: null, openEnded: false });
  });
});

describe('mf-nav function — gates & validation', () => {
  it('403s a disallowed origin / cross-site, 401s a bad bearer, 405s GET', async () => {
    expect((await call(req({ origin: 'https://evil.example' }))).status).toBe(403);
    expect((await call(req({ secFetch: 'cross-site' }))).status).toBe(403);
    ctl.userinfoOk = false;
    expect((await call(req({ auth: 'Bearer bad', body: { action: 'fx' } }))).status).toBe(401);
    ctl.userinfoOk = true;
    expect((await call(req({ method: 'GET' }))).status).toBe(405);
  });

  it('answers the CORS preflight for an allowed origin', async () => {
    const { status, headers } = await call(req({ method: 'OPTIONS' }));
    expect(status).toBe(204);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://fundient-dashboard.web.app');
  });

  it('400s unknown actions and malformed inputs', async () => {
    expect((await post({ action: 'nope' })).status).toBe(400);
    expect((await post({ action: 'latest', codes: [] })).status).toBe(400);
    expect((await post({ action: 'latest', codes: ['abc'] })).status).toBe(400);
    expect((await post({ action: 'latest', codes: Array.from({ length: 21 }, (_, i) => String(100000 + i)) })).status).toBe(400);
    expect((await post({ action: 'search', q: '' })).status).toBe(400);
    expect((await post({ action: 'search', q: 'x'.repeat(61) })).status).toBe(400);
    expect((await post({ action: 'history', code: '12', date: '2026-09-30' })).status).toBe(400);
    expect((await post({ action: 'history', code: '147919', date: '30-09-2026' })).status).toBe(400);
    expect((await post({ action: 'history', code: '147919', date: '2026-02-31' })).status).toBe(400);
    expect((await post({ action: 'history', code: '147919', date: '2099-01-01' })).status).toBe(400);
    expect((await post({ action: 'history', code: '147919', from: '2024-01-01', to: '2026-01-01' })).status).toBe(400); // > 366 days
    expect((await post({ action: 'history', code: '147919', from: '2026-02-01', to: '2026-01-01' })).status).toBe(400);
  });
});

describe('mf-nav function — latest', () => {
  it('returns normalised NAVs keyed by code; unknown and N.A. are null', async () => {
    const { status, json } = await post({ action: 'latest', codes: ['147919', '999998', '148699', '147919'] });
    expect(status).toBe(200);
    expect(json.data['147919']).toEqual({
      schemeCode: '147919', name: 'ITI Small Cap Fund', amc: 'ITI Mutual Fund',
      plan: 'direct', option: 'growth', nav: 37.2823, date: '2026-10-09',
    });
    expect(json.data['999998']).toBeNull();
    expect(json.data['148699']).toBeNull();
    expect(json.stale).toBe(false);
    expect(json.fx).toBeUndefined();
  });

  it('downloads AMFI once and serves repeats from the cache', async () => {
    await post({ action: 'latest', codes: ['147919'] });
    await post({ action: 'latest', codes: ['120564'] });
    expect(navAllCalls.length).toBe(1);
  });

  it('bundles the INR/USD rate with includeFx', async () => {
    const { json } = await post({ action: 'latest', codes: ['147919'], includeFx: true });
    expect(json.fx).toEqual({ currency: 'INR', rate: 83.25, updatedAt: new Date(1791504000 * 1000).toISOString() });
  });

  it('includeFx degrades to fx:null when the rate API is down', async () => {
    ctl.fxOk = false;
    const { status, json } = await post({ action: 'latest', codes: ['147919'], includeFx: true });
    expect(status).toBe(200);
    expect(json.fx).toBeNull();
    expect(json.data['147919'].nav).toBe(37.2823);
  });

  it('503s retryable while the first download is still loading, and shares the in-flight promise', async () => {
    let release;
    ctl.navAllGate = new Promise(r => { release = r; });
    lib._setLoadWaitMs(20);
    const r1 = await post({ action: 'latest', codes: ['147919'] });
    expect(r1.status).toBe(503);
    expect(r1.json.retryable).toBe(true);
    const r2 = await post({ action: 'search', q: 'iti' });
    expect(r2.status).toBe(503);
    expect(navAllCalls.length).toBe(1); // second request joined the first download
    lib._setLoadWaitMs(5000);
    release();
    const r3 = await post({ action: 'latest', codes: ['147919'] });
    expect(r3.status).toBe(200);
    expect(navAllCalls.length).toBe(1);
  });

  it('503s retryable when the first download fails with nothing cached', async () => {
    ctl.navAllOk = false;
    const { status, json } = await post({ action: 'latest', codes: ['147919'] });
    expect(status).toBe(503);
    expect(json.retryable).toBe(true);
  });

  it('serves the previous parse with stale:true when a refresh fails', async () => {
    await post({ action: 'latest', codes: ['147919'] });
    lib._expireForTests();
    ctl.navAllOk = false;
    const { status, json } = await post({ action: 'latest', codes: ['147919'] });
    expect(status).toBe(200);
    expect(json.stale).toBe(true);
    expect(json.data['147919'].nav).toBe(37.2823);
  });
});

describe('mf-nav function — search', () => {
  it('finds all variants, Direct Growth first', async () => {
    const { json } = await post({ action: 'search', q: 'ITI Small Cap' });
    expect(json.results.map(r => r.code)).toEqual(['147919', '147917', '147920', '147918']);
    expect(json.results[0]).toMatchObject({
      code: '147919', name: 'ITI Small Cap Fund', amc: 'ITI Mutual Fund', plan: 'direct', option: 'growth',
    });
  });

  it('returns the four SBI Retirement Benefit sub-plans as separate results', async () => {
    const { json } = await post({ action: 'search', q: 'sbi retirement' });
    const names = new Set(json.results.map(r => r.name));
    expect(names.size).toBe(4);
    expect(json.results[0].plan).toBe('direct');
    expect(json.results[0].option).toBe('growth');
  });

  it('matches on AMC words too, case-insensitively and token-wise', async () => {
    const { json } = await post({ action: 'search', q: 'aditya flexi' });
    expect(json.results.map(r => r.code).sort()).toEqual(['103166', '120564']);
  });

  it('hides closed-ended / unplanned rows unless the query matches exactly', async () => {
    expect((await post({ action: 'search', q: 'fixed maturity' })).json.results).toEqual([]);
    const exact = await post({ action: 'search', q: 'Some Fixed Maturity Plan Series 99' });
    expect(exact.json.results.map(r => r.code)).toEqual(['222222']);
    const byCode = await post({ action: 'search', q: '222222' });
    expect(byCode.json.results.map(r => r.code)).toEqual(['222222']);
  });

  it('caps results at 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      code: String(300000 + i), name: `Cap Fund ${i}`, amc: 'X', plan: 'regular', option: 'growth', openEnded: true, nav: 1, date: '2026-10-09',
    }));
    expect(lib.searchSchemes(many, 'cap fund').length).toBe(50);
  });
});

describe('mf-nav function — history', () => {
  it('returns the exact-date NAV when it is a trading day', async () => {
    const { status, json } = await post({ action: 'history', code: '147919', date: '2026-09-29' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ schemeCode: '147919', date: '2026-09-29', resolvedDate: '2026-09-29', fellBack: false, nav: 37.9673, source: 'mfapi' });
  });

  it('falls back to the previous available NAV on a non-trading day', async () => {
    const { json } = await post({ action: 'history', code: '147919', date: '2026-09-27' }); // Sunday
    expect(json).toMatchObject({ date: '2026-09-27', resolvedDate: '2026-09-25', fellBack: true, nav: 38.4942 });
  });

  it('returns nav:null when nothing exists in the lookback window', async () => {
    const { status, json } = await post({ action: 'history', code: '147919', date: '2026-08-01' });
    expect(status).toBe(200);
    expect(json.nav).toBeNull();
    expect(json.resolvedDate).toBeNull();
  });

  it('returns nav:null for a scheme mfapi does not know', async () => {
    const { json } = await post({ action: 'history', code: '999999', date: '2026-09-29' });
    expect(json.nav).toBeNull();
  });

  it('returns an ascending series for a from/to range', async () => {
    const { json } = await post({ action: 'history', code: '147919', from: '2026-09-25', to: '2026-09-30' });
    expect(json.series.map(p => p.date)).toEqual(['2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(json.series[0]).toEqual({ date: '2026-09-25', nav: 38.4942 });
    expect(json.source).toBe('mfapi');
  });

  it('falls back to the AMFI history report when mfapi is down', async () => {
    ctl.mfapiOk = false;
    const { status, json } = await post({ action: 'history', code: '147919', date: '2026-09-30' });
    expect(status).toBe(200);
    expect(amfiHistCalls.length).toBe(1);
    expect(amfiHistCalls[0]).toContain('frmdt=24-Sep-2026');
    expect(amfiHistCalls[0]).toContain('todt=30-Sep-2026');
    expect(json).toMatchObject({ resolvedDate: '2026-09-30', nav: 37.4, source: 'amfi', fellBack: false });
  });

  it('502s when both sources fail', async () => {
    ctl.mfapiOk = false;
    ctl.amfiHistOk = false;
    const { status, json } = await post({ action: 'history', code: '147919', date: '2026-09-30' });
    expect(status).toBe(502);
    expect(json.retryable).toBe(true);
  });

  it('does not use the AMFI fallback for ranges over 7 days', async () => {
    ctl.mfapiOk = false;
    const { status } = await post({ action: 'history', code: '147919', from: '2026-09-01', to: '2026-09-30' });
    expect(status).toBe(502);
    expect(amfiHistCalls.length).toBe(0);
  });
});

describe('mf-nav function — fx', () => {
  it('returns INR per USD with its timestamp', async () => {
    const { status, json } = await post({ action: 'fx' });
    expect(status).toBe(200);
    expect(json.fx).toEqual({ currency: 'INR', rate: 83.25, updatedAt: new Date(1791504000 * 1000).toISOString() });
  });

  it('getRate exposes rate + updatedAt', async () => {
    expect(await getRate('inr')).toEqual({ rate: 83.25, updatedAt: new Date(1791504000 * 1000).toISOString() });
  });
});
