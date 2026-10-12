import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { INVEST_TABS } from '../sheetInvest.js';
import {
  CONFIG_COLUMNS, PEERS_COLUMNS, TER_COLUMNS, SERIES_COLUMNS, RUN_COLUMNS, SEED_CATEGORIES,
  seedConfigValues, valuesToConfig, buildTargets, targetsOfScope, sbiCategoryFromSip, cycleOf, istDate,
  valuesToPeers, peersToValues, upsertSuccess, markProblem,
} from '../../functions/lib/_mf-peers.mjs';
import { makeClient, causeOf, PeersFetchError, USER_AGENT } from '../../functions/lib/mf-peers/_http.mjs';
import { fetchHistory, parseMfapiBody, SeriesError } from '../../functions/lib/mf-peers/_series.mjs';
import { normName, indexTerRows, matchTer, loadTerIndex, resolveCategoryIds, FALLBACK_CATEGORY_IDS } from '../../functions/lib/mf-peers/_ter.mjs';
import { KNOWN_NO_TER, TER_NAME_ALIAS, BENCHMARK_CODES } from '../../functions/lib/mf-peers/_seed.mjs';
import { spotCheck } from '../../functions/lib/mf-peers/_spotcheck.mjs';
import { parseNavAll } from '../../functions/lib/_mf-nav.mjs';

const fx = (n) => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/mf-peers', n), 'utf8');
const json = (n) => JSON.parse(fx(n));
const config = () => valuesToConfig(seedConfigValues());

describe('tab contract', () => {
  it('keeps the sheet column lists identical to src/sheetInvest.js INVEST_TABS (client/server contract)', () => {
    expect(INVEST_TABS.MfPeersConfig).toEqual(CONFIG_COLUMNS);
    expect(INVEST_TABS.MfPeers).toEqual(PEERS_COLUMNS);
    expect(INVEST_TABS.MfTer).toEqual(TER_COLUMNS);
    expect(INVEST_TABS.MfPeersSeries).toEqual(SERIES_COLUMNS);
    expect(INVEST_TABS.MfPeersRun).toEqual(RUN_COLUMNS);
  });
  it('MfPeers carries exactly the header names the card reader maps by', () => {
    expect([...PEERS_COLUMNS].sort()).toEqual([
      'asOf', 'categoryKey', 'role', 'fundKey', 'code', 'plan', 'name', 'firstNavDate', 'lastNavDate', 'nav', 'ret1yPct', 'ret3yPct', 'ret5yPct',
      'volPct', 'maxDrawdownPct', 'rollingBeatPeerMedianPct', 'rollingWindows', 'historyDays', 'status', 'reason', 'windowStartDate', 'retWindowPct',
      'windowReturnBasis', 'volWindowPct', 'maxDrawdownWindowPct', 'fetchedAt',
    ].sort());
    expect(CONFIG_COLUMNS).toEqual(['categoryKey', 'role', 'fundKey', 'amc', 'name', 'directCode', 'regularCode', 'isin', 'launch', 'note', 'weakMatch', 'active', 'comparisonJson']);
  });
});

describe('seed from peers.approved.json', () => {
  const c = config();
  it('seeds 7 categories: 7 held rows (holdings-job fundKeys), 51 peers incl. 1 benchmark', () => {
    expect(Object.keys(SEED_CATEGORIES)).toHaveLength(7);
    expect(c.filter((e) => e.role === 'held').map((e) => e.fundKey)).toEqual([
      'absl-flexi-cap', 'iti-small-cap', 'absl-conglomerate', 'sbi-retirement-aggressive-hybrid', 'sbi-retirement-aggressive',
      'sbi-retirement-conservative-hybrid', 'sbi-retirement-conservative',
    ]);
    expect(c.filter((e) => e.role === 'peer')).toHaveLength(50);
    expect(c.filter((e) => e.role === 'benchmark').map((e) => e.directCode)).toEqual(['153132']);
    expect(c.every((e) => e.active)).toBe(true);
    expect(c.some((e) => /sbi-ret-/.test(e.fundKey))).toBe(false);
  });
  it('held codes match the research (SBI AHP 148685/148695), peers carry note + weakMatch', () => {
    const ahp = c.find((e) => e.fundKey === 'sbi-retirement-aggressive-hybrid');
    expect([ahp.directCode, ahp.regularCode]).toEqual(['148685', '148695']);
    expect(c.find((e) => e.name === 'Parag Parikh Flexi Cap Fund').note).toBe('includes overseas equity');
    expect(c.some((e) => e.weakMatch)).toBe(true);
  });
  it('conglomerate rows carry the comparison object; other categories none', () => {
    const cg = c.filter((e) => e.categoryKey === 'conglomerate');
    expect(cg).toHaveLength(4);
    for (const e of cg) expect(e.comparison).toEqual({ window: 'common-since-2025-10-27', benchmarkProxyCode: '153132', label: 'weak comparability', thematicMedian: false });
    expect(c.filter((e) => e.categoryKey === 'flexi-cap').every((e) => e.comparison === null)).toBe(true);
  });
  it('every seeded value row has the config width and uses RAW-safe primitives', () => {
    for (const v of seedConfigValues()) { expect(v).toHaveLength(CONFIG_COLUMNS.length); for (const x of v) expect(['string', 'boolean']).toContain(typeof x); }
  });
  it('valuesToConfig parses sheet values: numeric codes, blank active = true, FALSE strings, bad JSON ignored', () => {
    const [e] = valuesToConfig([['k', 'peer', 'f', 'amc', 'n', 123456, '123457', '', '', '', 'TRUE', 'FALSE', '{bad']]);
    expect(e).toMatchObject({ directCode: '123456', regularCode: '123457', weakMatch: true, active: false, comparison: null });
    expect(valuesToConfig([['k', 'peer', 'f', 'amc', 'n', '1', '2', '', '', '', '', '', '']])[0].active).toBe(true);
  });
});

describe('targets', () => {
  it('both plans per scheme; an inactive held row skips the whole category; inactive peers are skipped', () => {
    const cfg = config().map((e) => (e.fundKey === 'iti-small-cap' ? { ...e, active: false } : e.name === 'HDFC Flexi Cap Fund' ? { ...e, active: false } : e));
    const t = buildTargets(cfg);
    expect(t.some((x) => x.categoryKey === 'small-cap')).toBe(false);
    expect(t.some((x) => x.name === 'HDFC Flexi Cap Fund')).toBe(false);
    expect(t.filter((x) => x.fundKey === 'absl-flexi-cap').map((x) => [x.plan, x.code])).toEqual([['direct', '120564'], ['regular', '103166']]);
  });
  it('SBI auto-rule narrows retirement to the held sub-plan; unmapped = all four; explicit FALSE always wins', () => {
    const all = buildTargets(config());
    expect(new Set(all.filter((x) => x.categoryKey.startsWith('retirement-')).map((x) => x.categoryKey)).size).toBe(4);
    const narrowed = buildTargets(config(), 'retirement-aggressive-hybrid');
    expect(new Set(narrowed.filter((x) => x.categoryKey.startsWith('retirement-')).map((x) => x.categoryKey))).toEqual(new Set(['retirement-aggressive-hybrid']));
    expect(narrowed.some((x) => x.categoryKey === 'flexi-cap')).toBe(true);
    const off = config().map((e) => (e.categoryKey === 'retirement-aggressive-hybrid' && e.role === 'held' ? { ...e, active: false } : e));
    expect(buildTargets(off, 'retirement-aggressive-hybrid').some((x) => x.categoryKey.startsWith('retirement-'))).toBe(false); // narrowing never re-enables
  });
  it('sbiCategoryFromSip: by mapped code, by name, unmapped = null', () => {
    const row = (code, name = 'SBI Retirement Fund') => [['sbi-retirement', code, name, 'SBI', 5000, '', 'nro-mf', true]];
    expect(sbiCategoryFromSip(row('148695'))).toBe('retirement-aggressive-hybrid');
    expect(sbiCategoryFromSip(row('148688'))).toBe('retirement-conservative');
    expect(sbiCategoryFromSip(row('unmapped', 'SBI Retirement Benefit Fund - Conservative Hybrid Plan'))).toBe('retirement-conservative-hybrid');
    expect(sbiCategoryFromSip(row('unmapped', 'SBI Retirement Benefit Fund - Aggressive Plan'))).toBe('retirement-aggressive');
    expect(sbiCategoryFromSip(row('unmapped'))).toBeNull();
    expect(sbiCategoryFromSip([['birla-flexi', '120564', 'Birla Flexi', 'ABSL']])).toBeNull();
    expect(sbiCategoryFromSip(undefined)).toBeNull();
  });
  it('scopes: held = held rows + the whole conglomerate category; peers = everything else', () => {
    const t = buildTargets(config());
    const held = targetsOfScope('held', t); const peers = targetsOfScope('peers', t);
    expect(held.filter((x) => x.role === 'held').length).toBe(14);
    expect(held.filter((x) => x.categoryKey === 'conglomerate' && x.role !== 'held').length).toBe(6); // 2 peers + benchmark, both plans
    expect(peers.some((x) => x.categoryKey === 'conglomerate')).toBe(false);
    expect(held.length + peers.length).toBe(t.length);
    expect(targetsOfScope('ter', t)).toHaveLength(t.length);
    expect(held.length).toBe(20); // ~6-8 extra calls weekly, as agreed
  });
});

describe('cycles (IST)', () => {
  it('istDate rolls over at 18:30 UTC', () => {
    expect(istDate(new Date('2026-10-10T18:29:00Z'))).toBe('2026-10-10');
    expect(istDate(new Date('2026-10-10T18:31:00Z'))).toBe('2026-10-11');
  });
  it('held cycle = the IST week starting Sunday; peers/ter cycle = the IST month', () => {
    const h = cycleOf('held', new Date('2026-10-11T04:00:00+05:30')); // Sunday
    expect(h.cycle).toBe('W2026-10-11');
    expect(h.startMs).toBe(Date.parse('2026-10-11T00:00:00+05:30'));
    expect(cycleOf('held', new Date('2026-10-17T12:00:00+05:30')).cycle).toBe('W2026-10-11');
    expect(cycleOf('held', new Date('2026-10-18T00:30:00+05:30')).cycle).toBe('W2026-10-18');
    const p = cycleOf('peers', new Date('2026-11-03T03:00:00+05:30'));
    expect(p.cycle).toBe('2026-11');
    expect(p.startMs).toBe(Date.parse('2026-11-01T00:00:00+05:30'));
  });
});

describe('MfPeers rows', () => {
  const t = { categoryKey: 'c', role: 'held', fundKey: 'f', code: '1', plan: 'direct', name: 'N' };
  const row = (asOf, extra = {}) => ({ ...Object.fromEntries(PEERS_COLUMNS.map((k) => [k, ''])), asOf, code: '1', plan: 'direct', status: 'ok', fetchedAt: `${asOf}T00:00:00Z`, ...extra });
  it('keeps the latest 2 asOf per code/plan; same asOf replaces (idempotent)', () => {
    const store = new Map();
    upsertSuccess(store, row('2026-10-01')); upsertSuccess(store, row('2026-10-08')); upsertSuccess(store, row('2026-10-08', { nav: 5 })); upsertSuccess(store, row('2026-10-15'));
    expect(store.get('1|direct').map((r) => r.asOf)).toEqual(['2026-10-15', '2026-10-08']);
    upsertSuccess(store, row('2026-10-15', { nav: 9 }));
    expect(store.get('1|direct')).toHaveLength(2);
    expect(store.get('1|direct')[0].nav).toBe(9);
  });
  it('a failure updates status/reason in place without bumping asOf or fetchedAt; a first-time failure leaves a placeholder that a success replaces', () => {
    const store = new Map();
    markProblem(store, t, 'failed', 'phase=nav-fetch boom');
    expect(store.get('1|direct')[0]).toMatchObject({ asOf: '', status: 'failed', reason: 'phase=nav-fetch boom', fetchedAt: '' });
    upsertSuccess(store, row('2026-10-08'));
    expect(store.get('1|direct').map((r) => r.asOf)).toEqual(['2026-10-08']);
    markProblem(store, t, 'stale', 'lagging');
    expect(store.get('1|direct')[0]).toMatchObject({ asOf: '2026-10-08', status: 'stale', reason: 'lagging', fetchedAt: '2026-10-08T00:00:00Z' });
  });
  it('round-trips through sheet values (blank = null, numbers stay numbers)', () => {
    const r = row('2026-10-08', { nav: 12.5, ret1yPct: 3.25, rollingWindows: 25, historyDays: 400 });
    const back = valuesToPeers(peersToValues([r]))[0];
    expect(back.nav).toBe(12.5); expect(back.ret3yPct).toBeNull(); expect(back.rollingWindows).toBe(25); expect(back.asOf).toBe('2026-10-08');
  });
});

describe('http client', () => {
  it('sends the honest User-Agent and spaces requests to one host by >= 1 s', async () => {
    const sleep = vi.fn(async () => {});
    const seen = [];
    const fetchImpl = vi.fn(async (url, init) => { seen.push(init.headers['User-Agent']); return new Response('{}', { status: 200 }); });
    const c = makeClient({ fetchImpl, sleep });
    await c.getText('https://api.mfapi.in/mf/1', { phase: 'nav-fetch' });
    await c.getText('https://api.mfapi.in/mf/2', { phase: 'nav-fetch' });
    await c.getText('https://www.amfiindia.com/api/x', { phase: 'ter' });
    expect(new Set(seen)).toEqual(new Set([USER_AGENT]));
    expect(USER_AGENT).toBe('Fundient-household-dashboard/1.0 (private personal use)');
    expect(sleep).toHaveBeenCalledTimes(1); // only the 2nd call to the same host waited
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
    expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(1000);
  });
  it('failure messages carry phase, host, status and the underlying cause code', async () => {
    const cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const net = makeClient({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause }); }, sleep: async () => {}, minGapMs: 0 });
    await expect(net.getText('https://api.mfapi.in/mf/1', { phase: 'nav-fetch' })).rejects.toThrow('phase=nav-fetch host=api.mfapi.in cause=ECONNRESET: read ECONNRESET');
    const http = makeClient({ fetchImpl: async () => new Response('no', { status: 403 }), sleep: async () => {}, minGapMs: 0 });
    await expect(http.getText('https://www.amfiindia.com/api/x', { phase: 'ter' })).rejects.toThrow('phase=ter host=www.amfiindia.com status=403');
    const dns = makeClient({ fetchImpl: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }); }, sleep: async () => {}, minGapMs: 0 });
    await expect(dns.getText('https://x.example/', { phase: 'listing' })).rejects.toBeInstanceOf(PeersFetchError);
    expect(causeOf(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
  });
  it('refuses non-https URLs and oversized bodies', async () => {
    const c = makeClient({ fetchImpl: async () => new Response('x'.repeat(50)), sleep: async () => {}, minGapMs: 0 });
    await expect(c.getText('http://api.mfapi.in/mf/1', { phase: 'nav-fetch' })).rejects.toThrow(/non-https/);
    await expect(c.getText('https://api.mfapi.in/mf/1', { phase: 'nav-fetch', maxBytes: 10 })).rejects.toThrow(/exceeded 10 bytes/);
  });
});

describe('mfapi history validation', () => {
  const navAll = new Map([['147919', { date: '2026-10-09' }]]);
  const good = fx('mfapi-147919.json');
  const truncated = fx('mfapi-108594.truncated.json');
  const clientOf = (...bodies) => { let i = 0; return { getText: vi.fn(async () => { const b = bodies[Math.min(i++, bodies.length - 1)]; if (b instanceof Error) throw b; return { status: 200, text: b }; }) }; };

  it('parses the complete body; the truncated sample (HTTP 200, cut mid-record) is rejected', () => {
    expect(parseMfapiBody(good).series.length).toBeGreaterThan(1000);
    expect(() => parseMfapiBody(truncated)).toThrow(/truncated or invalid JSON/);
    expect(() => parseMfapiBody('{"data":[]}')).toThrow(/no usable NAV rows/);
    expect(() => parseMfapiBody('{"x":1}')).toThrow(/no data array/);
  });
  it('retries a truncated body ONCE (after a pause) and then succeeds', async () => {
    const sleep = vi.fn(async () => {}); const client = clientOf(truncated, good);
    const r = await fetchHistory('147919', { navAll, client, sleep });
    expect(client.getText).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5000);
    expect(r.series[r.series.length - 1].date).toBe('2026-10-09');
  });
  it('a body that stays truncated fails with phase/host in the reason', async () => {
    await expect(fetchHistory('147919', { navAll, client: clientOf(truncated), sleep: async () => {} })).rejects.toMatchObject({ kind: 'failed', message: expect.stringMatching(/phase=nav-fetch host=api\.mfapi\.in truncated or invalid JSON body \(after 1 retry\)/) });
  });
  it('data[0].date older than the NAVAll date → one retry, then stale (not failed)', async () => {
    const lag = good.replace('"09-10-2026"', '"08-10-2026"').replace(/\{"date":"08-10-2026","nav":"36\.98990"\},/, '');
    const client = clientOf(lag);
    const err = await fetchHistory('147919', { navAll, client, sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(SeriesError);
    expect(err.kind).toBe('stale');
    expect(err.message).toMatch(/newest NAV 2026-10-08 is older than AMFI NAVAll 2026-10-09/);
    expect(client.getText).toHaveBeenCalledTimes(2);
  });
  it('a code missing from NAVAll fails without any request', async () => {
    const client = clientOf(good);
    await expect(fetchHistory('999', { navAll, client, sleep: async () => {} })).rejects.toThrow(/phase=nav-check code 999 is not in AMFI NAVAll/);
    expect(client.getText).not.toHaveBeenCalled();
  });
  it('a fetch error passes its diagnostic through, after one retry', async () => {
    const e = new PeersFetchError({ phase: 'nav-fetch', host: 'api.mfapi.in', cause: 'ECONNRESET: x' });
    const client = clientOf(e);
    await expect(fetchHistory('147919', { navAll, client, sleep: async () => {} })).rejects.toThrow('phase=nav-fetch host=api.mfapi.in cause=ECONNRESET: x (after 1 retry)');
    expect(client.getText).toHaveBeenCalledTimes(2);
  });
  it('NAVAll sample fixture parses and carries both plan codes of the held funds', () => {
    const by = new Map(parseNavAll(fx('NAVAll.sample.txt')).map((s) => [s.code, s]));
    for (const code of ['120564', '103166', '147919', '147920', '153124', '153127', '148685', '148695']) expect(by.has(code), code).toBe(true);
    expect(by.get('147919')).toMatchObject({ plan: 'direct', option: 'growth', date: '2026-10-09' });
  });
});

describe('TER join', () => {
  const rows = [...json('ter-small-10-2026-p1.json').data, ...json('ter-small-10-2026-p2.json').data];
  const index = indexTerRows(rows, '2026-10-09');
  it('normName ignores case, punctuation, & and fund/plan/scheme', () => {
    expect(normName('Invesco India Small cap Fund')).toBe(normName('INVESCO INDIA SMALL CAP FUND'));
    expect(normName('Franklin India Flexi-Cap Fund & Co')).toBe('franklin india flexi cap and co');
  });
  it('takes the latest row dated <= today per scheme and plan side; future-dated rows are ignored', () => {
    const icici = matchTer(index, { name: 'ICICI Prudential Small Cap Fund', directCode: '120591' }, 'direct');
    expect(icici).toMatchObject({ matched: true, terPct: 1.17, berPct: 0.71, terDate: '2026-10-08', matchedName: 'ICICI Prudential Small Cap Fund', reason: '' });
    expect(matchTer(index, { name: 'ICICI Prudential Small Cap Fund', directCode: '120591' }, 'regular').terPct).toBe(2.09);
    const mirae = matchTer(index, { name: 'Mirae Asset Small Cap Fund', directCode: '1' }, 'direct');
    expect(mirae.terDate).toBe('2026-10-09');
  });
  it('unmatched → matched=false with a blank value and a reason; a known gap says so', () => {
    expect(matchTer(index, { name: 'Nonexistent Fund', directCode: '5' }, 'direct')).toMatchObject({ matched: false, terPct: null, reason: expect.stringMatching(/no scheme with this name/) });
    expect(matchTer(index, { name: 'HDFC Small Cap Fund', directCode: '130503' }, 'direct').reason).toMatch(/known gap/);
  });
  it('the join must be one-to-one: two feed schemes with the same name → ambiguous, no guess', () => {
    const dup = indexTerRows([
      { NSDLSchemeCode: 'A/1', Scheme_Name: 'Twin Fund', TER_Date: '2026-10-01T00:00:00.000Z', D_TER: '1', R_TER: '2' },
      { NSDLSchemeCode: 'B/1', Scheme_Name: 'TWIN FUND', TER_Date: '2026-10-01T00:00:00.000Z', D_TER: '1.5', R_TER: '2.5' },
    ], '2026-10-09');
    expect(matchTer(dup, { name: 'Twin Fund', directCode: '9' }, 'direct')).toMatchObject({ matched: false, reason: expect.stringMatching(/ambiguous/) });
  });
  it('the alias maps the Axis retirement names AND still resolves one-to-one', () => {
    const idx = indexTerRows([{ NSDLSchemeCode: 'AXIS/1', Scheme_Name: 'Axis Retirement Fund - Aggressive Plan', TER_Date: '2026-10-08T00:00:00.000Z', D_TER: '1.26', D_BER: '1', R_TER: '2.5' }], '2026-10-09');
    expect(TER_NAME_ALIAS['147825']).toBe('Axis Retirement Fund - Aggressive Plan');
    expect(matchTer(idx, { name: 'Axis Retirement Savings Fund - Aggressive Plan', directCode: '147825' }, 'direct')).toMatchObject({ matched: true, terPct: 1.26 });
    expect(matchTer(idx, { name: 'Axis Retirement Savings Fund - Aggressive Plan', directCode: '999' }, 'direct').matched).toBe(false); // no alias → no match
  });
  it('COVERAGE PIN: every tracked scheme is name-matched, alias-matched, or in KNOWN_NO_TER (a new gap fails here); KNOWN_NO_TER stays honest', () => {
    const names = json('ter-names-oct2026.json');
    const idx = indexTerRows(names.map((n, i) => ({ NSDLSchemeCode: `S/${i}`, Scheme_Name: n, TER_Date: '2026-10-08T00:00:00.000Z', D_TER: '1', R_TER: '2' })), '2026-10-09');
    const unexplained = []; const wronglyKnown = [];
    for (const e of config()) {
      const m = matchTer(idx, { name: e.name, directCode: e.directCode }, 'direct');
      if (!m.matched && !KNOWN_NO_TER.has(e.directCode)) unexplained.push(`${e.directCode} ${e.name}: ${m.reason}`);
      // the benchmark twin IS in the full feed (under Index Funds) but that category is deliberately not fetched
      if (m.matched && KNOWN_NO_TER.has(e.directCode) && !BENCHMARK_CODES.has(e.directCode)) wronglyKnown.push(`${e.directCode} ${e.name}`);
    }
    expect(unexplained).toEqual([]);
    expect(wronglyKnown).toEqual([]);
    expect(KNOWN_NO_TER.size).toBe(10);
  });
});

describe('TER feed loading', () => {
  const page = (rows, pageCount = 1) => JSON.stringify({ data: rows, meta: { page: 1, pageSize: 100, total: rows.length, pageCount } });
  it('resolves category ids from both AMFI label families, else falls back to the constants (with a note)', async () => {
    const notes = [];
    const client = { getText: vi.fn(async (url) => {
      if (url.includes('category=Equity%20Schemes')) return { text: JSON.stringify([{ SubCat_Desc: 'Small Cap Fund', SchemeCat_Id: 77 }, { SubCat_Desc: 'Mid Cap Fund', SchemeCat_Id: 76 }]) };
      if (url.includes('category=Equity%20Scheme')) return { text: JSON.stringify([{ SubCat_Desc: 'Small Cap Fund', SchemeCat_Id: 18 }, { SubCat_Desc: 'Sectoral/ Thematic', SchemeCat_Id: 23 }]) };
      throw new PeersFetchError({ phase: 'ter', host: 'www.amfiindia.com', status: 500 });
    }) };
    expect((await resolveCategoryIds(client, notes)).sort((a, b) => a - b)).toEqual([18, 23, 77]);
    expect(notes.some((n) => /status=500/.test(n))).toBe(true);
    const dead = { getText: async () => { throw new PeersFetchError({ phase: 'ter', host: 'www.amfiindia.com', cause: 'ECONNRESET: x' }); } };
    const n2 = [];
    expect(await resolveCategoryIds(dead, n2)).toEqual(FALLBACK_CATEGORY_IDS);
    expect(n2.at(-1)).toMatch(/fallback ids/);
  });
  it('pages through a category and adds the previous month only when a tracked scheme found no row', async () => {
    const urls = [];
    const client = { getText: vi.fn(async (url) => {
      urls.push(url);
      if (url.includes('populate-sub-category')) return { text: '[]' };
      if (url.includes('Month=10-2026') && url.includes('strCat=77')) return { text: page([{ NSDLSchemeCode: 'A', Scheme_Name: 'Alpha Small Cap Fund', TER_Date: '2026-10-02T00:00:00.000Z', D_TER: '0.5', D_BER: '0.4', R_TER: '1' }], 1) };
      if (url.includes('Month=09-2026') && url.includes('strCat=77')) return { text: page([{ NSDLSchemeCode: 'B', Scheme_Name: 'Beta Small Cap Fund', TER_Date: '2026-09-28T00:00:00.000Z', D_TER: '0.6', D_BER: '0.5', R_TER: '1.1' }], 1) };
      return { text: page([], 0) };
    }) };
    const schemes = [{ name: 'Alpha Small Cap Fund', directCode: '1' }, { name: 'Beta Small Cap Fund', directCode: '2' }];
    const { index, rowCount } = await loadTerIndex(client, '2026-10-03', schemes);
    expect(rowCount).toBe(2);
    expect(matchTer(index, schemes[0], 'direct').terPct).toBe(0.5);
    expect(matchTer(index, schemes[1], 'direct')).toMatchObject({ matched: true, terPct: 0.6, terDate: '2026-09-28' });
    expect(urls.some((u) => u.includes('Month=09-2026'))).toBe(true);
    urls.length = 0;
    await loadTerIndex(client, '2026-10-03', [schemes[0]]);
    expect(urls.some((u) => u.includes('Month=09-2026'))).toBe(false); // everything matched: no fallback month
  });
});

describe('AMFI single-day spot check (rule 6)', () => {
  const line = (code, nav) => `${code};Name;Direct Plan;Growth;INF;-;${nav};09-Oct-2026`;
  it('reports mismatches and tolerates an unreachable report', async () => {
    const client = { getText: vi.fn(async () => ({ text: ['header', line('1', '10.5'), line('2', '20.0')].join('\n') })) };
    const r = await spotCheck(client, [{ code: '1', date: '2026-10-09', nav: 10.5 }, { code: '2', date: '2026-10-09', nav: 20.5 }]);
    expect(client.getText.mock.calls[0][0]).toContain('frmdt=09-Oct-2026&todt=09-Oct-2026');
    expect(r.mismatches).toEqual([{ code: '2', mfapi: 20.5, amfi: 20 }]);
    const down = await spotCheck({ getText: async () => { throw new PeersFetchError({ phase: 'spot-check', host: 'portal.amfiindia.com', status: 503 }); } }, [{ code: '1', date: '2026-10-09', nav: 1 }, { code: '2', date: '2026-10-09', nav: 1 }]);
    expect(down).toMatchObject({ checked: 0, mismatches: [] });
    expect(down.note).toMatch(/status=503/);
    expect((await spotCheck(client, [{ code: '1', date: '2026-10-09', nav: 1 }])).checked).toBe(0);
  });
});
