import { Buffer } from 'node:buffer';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { zipSync } from 'fflate';
import { makeClient, USER_AGENT } from '../../functions/lib/mf-holdings/_http.mjs';
import { fetchAbsl, ABSL_LISTING_URL } from '../../functions/lib/mf-holdings/absl.mjs';
import { fetchSbi, sbiUrl } from '../../functions/lib/mf-holdings/sbi.mjs';
import { fetchIti, validateItiUrl } from '../../functions/lib/mf-holdings/iti.mjs';
import { parseAbslWorkbook } from '../../functions/lib/mf-holdings/absl.mjs';
import { parseSbiWorkbook } from '../../functions/lib/mf-holdings/sbi.mjs';
import { parseItiWorkbook } from '../../functions/lib/mf-holdings/iti.mjs';
import { MfFetchError } from '../../functions/lib/_mf-holdings.mjs';

const fx = (n) => readFileSync(resolve(process.cwd(), 'src/__tests__/fixtures/mf-holdings', n));
const noSleep = async () => {};
const ok = (body, headers = {}) => new Response(body, { status: 200, headers });
const status = (s) => new Response('x', { status: s });

/** fetch stub routing by exact URL; records the calls. */
function router(routes) {
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (r === undefined) return status(404);
    return typeof r === 'function' ? r() : r.clone ? r.clone() : r;
  });
  fn.calls = calls;
  return fn;
}

describe('http client', () => {
  it('sends an honest User-Agent and a timeout signal', async () => {
    const f = router({ 'https://a.example/x': ok('hi') });
    await makeClient({ fetchImpl: f, sleep: noSleep }).get('https://a.example/x');
    expect(f.calls[0].init.headers['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/Fundient/);
    expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('spaces requests to the same host by >= 1 s, not requests to another host', async () => {
    const f = router({ 'https://a.example/1': ok('1'), 'https://a.example/2': ok('2'), 'https://b.example/1': ok('3') });
    const sleep = vi.fn(async () => {});
    const c = makeClient({ fetchImpl: f, sleep });
    await c.get('https://a.example/1');
    await c.get('https://b.example/1');
    expect(sleep).not.toHaveBeenCalled();
    await c.get('https://a.example/2');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(900);
  });

  it('maps 404 to missing and other errors to failed', async () => {
    const c = makeClient({ fetchImpl: router({ 'https://a.example/500': status(500) }), sleep: noSleep });
    await expect(c.get('https://a.example/nope')).rejects.toMatchObject({ kind: 'missing' });
    await expect(c.get('https://a.example/500')).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('HTTP 500') });
  });

  it('aborts a response that exceeds the byte cap (declared and streamed)', async () => {
    const big = Buffer.alloc(2000, 1);
    // Fresh Response per request: cancelling a cloned (tee'd) stream would hang the test, not the code.
    const c = makeClient({ fetchImpl: router({ 'https://a.example/big': () => ok(big), 'https://a.example/big2': () => ok(big, { 'content-length': '2000' }) }), sleep: noSleep });
    await expect(c.get('https://a.example/big', { maxBytes: 1000 })).rejects.toThrow(/exceeded|too large/);
    await expect(c.get('https://a.example/big2', { maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it('flags a truncated download (fewer bytes than Content-Length)', async () => {
    const c = makeClient({ fetchImpl: router({ 'https://a.example/t': ok(Buffer.alloc(10), { 'content-length': '100' }) }), sleep: noSleep });
    await expect(c.get('https://a.example/t')).rejects.toThrow(/truncated/);
  });

  it('refuses non-https and non-allowlisted hosts; reports network errors/timeouts as failed', async () => {
    const c = makeClient({ fetchImpl: router({}), sleep: noSleep, allowedHosts: ['a.example'] });
    await expect(c.get('http://a.example/x')).rejects.toThrow(/non-https/);
    await expect(c.get('https://evil.example/x')).rejects.toThrow(/not allowed/);
    const boom = makeClient({ fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, sleep: noSleep });
    await expect(boom.get('https://a.example/x')).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('timed out') });
  });
});

const LISTING = {
  ReturnCode: '1',
  ReturnMsg: 'ok',
  AccordionList: [
    { ResourceLink: 'Monthly Portfolios as on September 30, 2026', pdfUrl: 'https://abcscprod.azureedge.net/-/media/bsl/files/resources/monthly-portfolio/2026/30092026_abslmf_monthlydisclosure.zip' },
    { ResourceLink: 'Monthly Portfolios as on August 31, 2026', pdfUrl: 'https://abcscprod.azureedge.net/-/media/bsl/files/resources/monthly-portfolio/2026/monthly-portfolio-31082026_abslmf.zip' },
    { ResourceLink: 'Monthly Portfolio of Debt Oriented Close Ended /FMPs/Interval Schemes as on September 30, 2012', pdfUrl: 'https://abcscprod.azureedge.net/x/fmp.zip' },
  ],
};
const SEP_ZIP = 'https://abcscprod.azureedge.net/-/media/bsl/files/resources/monthly-portfolio/2026/30092026_abslmf_monthlydisclosure.zip';
const zipOf = (files) => Buffer.from(zipSync(files));

describe('ABSL fetch', () => {
  it('reads the listing, finds the target month, unzips the .xls and the result parses', async () => {
    const f = router({ [ABSL_LISTING_URL]: ok(JSON.stringify(LISTING)), [SEP_ZIP]: ok(zipOf({ '30092026_ABSLMF_MonthlyDisclosure.xls': new Uint8Array(fx('absl.xls')) })) });
    const file = await fetchAbsl({ asOf: '2026-09-30', fetchImpl: f, sleep: noSleep });
    expect(f.calls.map(c => c.url)).toEqual([ABSL_LISTING_URL, SEP_ZIP]);
    expect(file.fileName).toBe('30092026_ABSLMF_MonthlyDisclosure.xls');
    const out = parseAbslWorkbook(file.buffer, { fileName: file.fileName });
    expect(out['absl-flexi-cap'].sourceFile).toBe('absl:30092026_ABSLMF_MonthlyDisclosure.xls#BSLEQTY');
  });

  it('listing URL carries the required month=&year=0 params', () => {
    expect(ABSL_LISTING_URL).toMatch(/FactsheetAccordionById\?id=3ccab227-9de5-4494-b78d-2b4f7c0c054a/);
    expect(ABSL_LISTING_URL).toMatch(/&month=&year=0$/);
  });

  it('missing month in the listing (not published yet) is "missing"; the 2012 FMP lines never match', async () => {
    const f = router({ [ABSL_LISTING_URL]: ok(JSON.stringify(LISTING)) });
    await expect(fetchAbsl({ asOf: '2026-10-31', fetchImpl: f, sleep: noSleep })).rejects.toMatchObject({ kind: 'missing' });
    await expect(fetchAbsl({ asOf: '2012-09-30', fetchImpl: f, sleep: noSleep })).rejects.toMatchObject({ kind: 'missing' });
  });

  it('listing HTTP 500 (endpoint drift) and bad JSON are failures that name the cause', async () => {
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: router({ [ABSL_LISTING_URL]: status(500) }), sleep: noSleep })).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('500') });
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: router({ [ABSL_LISTING_URL]: ok('<html>') }), sleep: noSleep })).rejects.toMatchObject({ kind: 'failed', message: expect.stringMatching(/listing/i) });
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: router({ [ABSL_LISTING_URL]: ok(JSON.stringify({ AccordionList: 'x' })) }), sleep: noSleep })).rejects.toMatchObject({ kind: 'failed' });
  });

  it('refuses a listing item that points at an unexpected host or a non-zip', async () => {
    const bad = (pdfUrl) => router({ [ABSL_LISTING_URL]: ok(JSON.stringify({ AccordionList: [{ ResourceLink: 'Monthly Portfolios as on September 30, 2026', pdfUrl }] })) });
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: bad('https://evil.example/a.zip'), sleep: noSleep })).rejects.toThrow(/not allowed|unexpected/i);
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: bad('https://abcscprod.azureedge.net/a.exe'), sleep: noSleep })).rejects.toThrow(/zip/i);
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: bad('http://abcscprod.azureedge.net/a.zip'), sleep: noSleep })).rejects.toThrow(/https|unexpected/i);
  });

  it('rejects a zip with too many entries, an oversized member, or no spreadsheet', async () => {
    const run = (zip, opts = {}) => fetchAbsl({ asOf: '2026-09-30', fetchImpl: router({ [ABSL_LISTING_URL]: ok(JSON.stringify(LISTING)), [SEP_ZIP]: ok(zip) }), sleep: noSleep, ...opts });
    await expect(run(zipOf({ 'a.xls': new Uint8Array(10), 'b.xls': new Uint8Array(10), 'c.xls': new Uint8Array(10), 'd.xls': new Uint8Array(10) }))).rejects.toThrow(/entries/);
    await expect(run(zipOf({ 'a.xls': new Uint8Array(5000) }), { maxUnzipBytes: 1000 })).rejects.toThrow(/uncompressed/);
    await expect(run(zipOf({ 'readme.txt': new Uint8Array(10) }))).rejects.toThrow(/spreadsheet/);
    await expect(run(Buffer.from('not a zip'))).rejects.toThrow(/zip/i);
  });

  const PAGE = 'https://mutualfund.adityabirlacapital.com/forms-and-downloads/portfolio';
  const acc = (id) => `https://mutualfund.adityabirlacapital.com/postlogin/CustomApi/Resources/FactsheetAccordionById?id=${id}&ctype=%2Fsitecore%2Fcontent%2FRoot%2FBSL%2FLibrary%2FLists%2FFAQ%2FCustomer%20Types%2FIndividual&month=&year=0`;
  const HTML = ['56e98138-8200-4188-9119-90870c17498e', '12341969-e855-4a80-b20a-dfb63e2268d4', 'aaaaaaaa-1111-2222-3333-444444444444']
    .map(id => `<li data-accordian-api="/postlogin/CustomApi/Resources/FactsheetAccordionById?id=${id}&amp;ctype=x">`).join('');

  it('if the hard-coded accordion id breaks, discovers the monthly accordion from the portfolio page', async () => {
    const f = router({
      [ABSL_LISTING_URL]: status(500),
      [PAGE]: ok(HTML),
      [acc('56e98138-8200-4188-9119-90870c17498e')]: ok(JSON.stringify({ AccordionList: [{ ResourceLink: 'Half Yearly as on Mar 31, 2026', pdfUrl: 'https://abcscprod.azureedge.net/h.zip' }] })),
      [acc('12341969-e855-4a80-b20a-dfb63e2268d4')]: ok(JSON.stringify(LISTING)),
      [SEP_ZIP]: ok(zipOf({ 'a.xls': new Uint8Array(fx('absl.xls')) })),
    });
    const file = await fetchAbsl({ asOf: '2026-09-30', fetchImpl: f, sleep: noSleep });
    expect(file.fileName).toBe('a.xls');
    expect(f.calls.map(c => c.url)).toEqual([ABSL_LISTING_URL, PAGE, acc('56e98138-8200-4188-9119-90870c17498e'), acc('12341969-e855-4a80-b20a-dfb63e2268d4'), SEP_ZIP]);
  });

  it('reports the primary failure when discovery finds nothing either; a merely-unpublished month never triggers discovery', async () => {
    const dead = router({ [ABSL_LISTING_URL]: status(500), [PAGE]: ok('<html>no accordions</html>') });
    await expect(fetchAbsl({ asOf: '2026-09-30', fetchImpl: dead, sleep: noSleep })).rejects.toMatchObject({ kind: 'failed', message: expect.stringContaining('500') });
    const none = router({ [ABSL_LISTING_URL]: ok(JSON.stringify(LISTING)) });
    await expect(fetchAbsl({ asOf: '2026-10-31', fetchImpl: none, sleep: noSleep })).rejects.toMatchObject({ kind: 'missing' });
    expect(none.calls).toHaveLength(1);
  });

  it('does not accept path-traversal member names as the file name', async () => {
    const f = router({ [ABSL_LISTING_URL]: ok(JSON.stringify(LISTING)), [SEP_ZIP]: ok(zipOf({ '../../etc/x.xls': new Uint8Array(fx('absl.xls')) })) });
    const file = await fetchAbsl({ asOf: '2026-09-30', fetchImpl: f, sleep: noSleep });
    expect(file.fileName).toBe('x.xls');
  });
});

describe('SBI fetch', () => {
  it('builds the predictable URL with the right day suffix', () => {
    const base = 'https://www.sbimf.com/docs/default-source/scheme-portfolios/all-schemes-monthly-portfolio---as-on-';
    expect(sbiUrl('2026-09-30')).toBe(`${base}30th-september-2026.xlsx`);
    expect(sbiUrl('2026-08-31')).toBe(`${base}31st-august-2026.xlsx`);
    expect(sbiUrl('2026-02-28')).toBe(`${base}28th-february-2026.xlsx`);
    expect(sbiUrl('2028-02-29')).toBe(`${base}29th-february-2028.xlsx`);
    expect(sbiUrl('2026-05-31')).toBe(`${base}31st-may-2026.xlsx`);
  });

  it('downloads and the result parses; 404 is "missing"', async () => {
    const url = sbiUrl('2026-09-30');
    const file = await fetchSbi({ asOf: '2026-09-30', fetchImpl: router({ [url]: ok(fx('sbi.xlsx')) }), sleep: noSleep });
    expect(file.fileName).toBe('all-schemes-monthly-portfolio---as-on-30th-september-2026.xlsx');
    expect(parseSbiWorkbook(file.buffer, { fileName: file.fileName })['sbi-retirement-aggressive'].sourceFile)
      .toBe('sbi:all-schemes-monthly-portfolio---as-on-30th-september-2026.xlsx#SRBF-AP');
    await expect(fetchSbi({ asOf: '2026-10-31', fetchImpl: router({}), sleep: noSleep })).rejects.toMatchObject({ kind: 'missing' });
  });

  it('a truncated xlsx fails per fund instead of crashing the parse', async () => {
    const half = fx('sbi.xlsx').subarray(0, 4000);
    const out = parseSbiWorkbook(half);
    expect(Object.keys(out)).toHaveLength(4);
    expect(Object.values(out).every(r => r.error)).toBe(true);
  });
});

describe('ITI fetch (semi-manual: the listing API is encrypted)', () => {
  const URL_OK = 'https://itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx';

  it('validates the pasted URL strictly', () => {
    expect(validateItiUrl(URL_OK, '2026-09-30')).toEqual({ ok: true });
    expect(validateItiUrl('https://www.itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx', '2026-09-30').ok).toBe(true);
    for (const bad of [
      'http://itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://evil.example/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://itiamc.com.evil.example/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://itiamc.com/admin/pdf/../x/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'https://itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx?x=1',
      'https://itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_31082026.xlsx',   // wrong month
      'https://itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.pdf',
      'https://user:pw@itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx',
      'not a url', '',
    ]) expect(validateItiUrl(bad, '2026-09-30').ok, bad).toBe(false);
  });

  it('without a URL it is "missing" with an actionable reason, and never fetches', async () => {
    const f = router({});
    await expect(fetchIti({ asOf: '2026-09-30', fetchImpl: f, sleep: noSleep })).rejects.toMatchObject({ kind: 'missing', message: expect.stringContaining('awaiting manual link') });
    expect(f).not.toHaveBeenCalled();
  });

  it('with a valid URL downloads and parses; with an invalid one fails without fetching', async () => {
    const f = router({ [URL_OK]: ok(fx('iti.xlsx')) });
    const file = await fetchIti({ asOf: '2026-09-30', itiUrl: URL_OK, fetchImpl: f, sleep: noSleep });
    expect(file.fileName).toBe('1791539984-ITIMF_Monthly_Portfolio_30092026.xlsx');
    expect(parseItiWorkbook(file.buffer, { fileName: file.fileName })['iti-small-cap'].error).toBeUndefined();
    const g = router({});
    await expect(fetchIti({ asOf: '2026-09-30', itiUrl: 'https://evil.example/a.xlsx', fetchImpl: g, sleep: noSleep })).rejects.toMatchObject({ kind: 'failed' });
    expect(g).not.toHaveBeenCalled();
  });

  it('without asOf, returns the filename date (ISO) for backfill validation', () => {
    expect(validateItiUrl(URL_OK)).toEqual({ ok: true, asOf: '2026-09-30' });
    expect(validateItiUrl('https://itiamc.com/admin/pdf/1791539984-ITIMF_Monthly_Portfolio_31082026.xlsx')).toEqual({ ok: true, asOf: '2026-08-31' });
  });

  it('does not follow redirects, rejects non-xlsx bodies and oversized files', async () => {
    const redirect = router({ [URL_OK]: () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.xlsx' } }) });
    await expect(fetchIti({ asOf: '2026-09-30', itiUrl: URL_OK, fetchImpl: redirect, sleep: noSleep })).rejects.toThrow(/redirect/i);
    expect(redirect.calls[0].init.redirect).toBe('manual');
    const html = router({ [URL_OK]: () => ok('<html>maintenance</html>') });
    await expect(fetchIti({ asOf: '2026-09-30', itiUrl: URL_OK, fetchImpl: html, sleep: noSleep })).rejects.toThrow(/signature|xlsx/i);
    const big = router({ [URL_OK]: () => ok(Buffer.alloc(10), { 'content-length': '7000000' }) });
    await expect(fetchIti({ asOf: '2026-09-30', itiUrl: URL_OK, fetchImpl: big, sleep: noSleep })).rejects.toThrow(/too large/);
  });

  it('exposes MfFetchError for fetchers', () => {
    expect(new MfFetchError('missing', 'x').kind).toBe('missing');
    expect(new MfFetchError('weird', 'x').kind).toBe('failed');
  });
});
