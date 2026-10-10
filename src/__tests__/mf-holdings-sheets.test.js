import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../functions/lib/_drive.mjs', () => ({ getAccessToken: async () => 'tok' }));
vi.mock('../../functions/lib/_sheets.mjs', () => ({ getUserSettings: async () => ({}) }));

const calls = [];
let routes = [];
vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url: decodeURIComponent(String(url)), method: init.method || 'GET', body, headers: init.headers });
  const r = routes.find(x => decodeURIComponent(String(url)).includes(x.match));
  return { ok: true, status: 200, json: async () => (r ? r.json : {}) };
}));

const { ensureInvestTabsServer, readInvestTabs, replaceInvestRows } = await import('../../functions/lib/_invest-sheets.mjs');

beforeEach(() => { calls.length = 0; routes = []; });

describe('server tab helpers', () => {
  it('creates only the missing tabs, each with its header row', async () => {
    routes.push({ match: '?fields=sheets.properties.title', json: { sheets: [{ properties: { title: 'Accounts' } }, { properties: { title: 'MfHoldings' } }] } });
    const added = await ensureInvestTabsServer('s1', { MfHoldings: ['a'], MfHoldingsStatus: ['fundKey', 'asOf'] });
    expect(added).toEqual(['MfHoldingsStatus']);
    expect(calls.find(c => c.url.includes(':batchUpdate')).body.requests).toEqual([{ addSheet: { properties: { title: 'MfHoldingsStatus' } } }]);
    const put = calls.find(c => c.method === 'PUT');
    expect(put.url).toContain("'MfHoldingsStatus'!A1");
    expect(put.body.values).toEqual([['fundKey', 'asOf']]);
  });

  it('is a no-op when every tab exists', async () => {
    routes.push({ match: '?fields=', json: { sheets: [{ properties: { title: 'T' } }] } });
    expect(await ensureInvestTabsServer('s1', { T: ['x'] })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('reads several tabs in one batchGet with unformatted values', async () => {
    routes.push({ match: 'values:batchGet', json: { valueRanges: [{ values: [['a', 1]] }, {}] } });
    const out = await readInvestTabs('s1', [{ title: 'T1', width: 2, maxRows: 10 }, { title: 'T2', width: 8 }]);
    expect(out).toEqual([[['a', 1]], []]);
    expect(calls[0].url).toContain("ranges='T1'!A2:B11");
    expect(calls[0].url).toContain("ranges='T2'!A2:H5001");
    expect(calls[0].url).toContain('valueRenderOption=UNFORMATTED_VALUE');
  });

  it('replaces rows RAW (no formula interpretation) then clears the leftover tail', async () => {
    await replaceInvestRows('s1', 'MfHoldings', 9, [['2026-09-30', 'k', '=HYPERLINK("x")']], 5000);
    const [put, clear] = calls;
    expect(put.method).toBe('PUT');
    expect(put.url).toContain("'MfHoldings'!A2:I2");
    expect(put.url).toContain('valueInputOption=RAW');
    expect(put.body.values[0][2]).toBe('=HYPERLINK("x")');
    expect(clear.url).toContain("'MfHoldings'!A3:I5001:clear");
  });

  it('an empty set only clears (never PUTs an empty block)', async () => {
    await replaceInvestRows('s1', 'MfHoldings', 9, [], 5000);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("'MfHoldings'!A2:I5001:clear");
  });

  it('refuses to exceed the row cap', async () => {
    await expect(replaceInvestRows('s1', 'T', 2, Array.from({ length: 4 }, () => ['a', 'b']), 3)).rejects.toThrow(/cap/);
    expect(calls).toHaveLength(0);
  });
});
