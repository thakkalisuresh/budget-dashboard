import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('FINNHUB_API_KEY', 'fh-test-key');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');

// Track outbound Finnhub calls; googleapis userinfo answers verifyBearer.
const { finnhubCalls, ctl } = vi.hoisted(() => ({
  finnhubCalls: [],
  ctl: { finnhubStatus: 200, price: 512.4, userinfoOk: true },
}));

vi.stubGlobal('fetch', vi.fn(async (url) => {
  const u = String(url);
  if (u.includes('googleapis.com/oauth2/v3/userinfo')) {
    return { ok: ctl.userinfoOk, json: async () => ({ email: 'nair.sabarish97@gmail.com' }) };
  }
  if (u.includes('finnhub.io')) {
    finnhubCalls.push(u);
    if (ctl.finnhubStatus !== 200) return { ok: false, status: ctl.finnhubStatus, json: async () => ({}) };
    if (u.includes('/quote?')) {
      const symbol = u.match(/symbol=([A-Z0-9.^-]+)/)[1];
      // UNKNOWN → Finnhub's all-zeros shape for bad tickers
      if (symbol === 'ZZZZ') return { ok: true, status: 200, json: async () => ({ c: 0, pc: 0 }) };
      return { ok: true, status: 200, json: async () => ({ c: ctl.price, pc: 509.3, dp: 0.61, h: 514, l: 508, o: 509.9, t: 1751980000 }) };
    }
    if (u.includes('/stock/recommendation')) {
      return { ok: true, status: 200, json: async () => ([{ buy: 12, hold: 4, sell: 1, strongBuy: 5, period: '2026-07-01' }]) };
    }
  }
  throw new Error('unexpected fetch ' + u);
}));

const { quotes } = await import('../../functions/quotes.mjs');

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
  await quotes(request, res);
  let json;
  try { json = JSON.parse(sent); } catch { json = sent; }
  return { status, json, headers };
}

beforeEach(() => { finnhubCalls.length = 0; ctl.finnhubStatus = 200; ctl.userinfoOk = true; });

describe('quotes function — gates', () => {
  it('403s a disallowed origin', async () => {
    const { status } = await call(req({ origin: 'https://evil.example' }));
    expect(status).toBe(403);
  });

  it('403s cross-site sec-fetch', async () => {
    const { status } = await call(req({ secFetch: 'cross-site' }));
    expect(status).toBe(403);
  });

  it('401s without a valid bearer', async () => {
    ctl.userinfoOk = false;
    const { status } = await call(req({ auth: 'Bearer bad', body: { symbols: ['VOO'] } }));
    expect(status).toBe(401);
  });

  it('405s non-POST after preflight', async () => {
    const { status } = await call(req({ method: 'GET' }));
    expect(status).toBe(405);
  });
});

describe('quotes function — validation', () => {
  it('400s empty, oversized, and malformed symbol lists', async () => {
    expect((await call(req({ body: { symbols: [] } }))).status).toBe(400);
    expect((await call(req({ body: { symbols: Array.from({ length: 31 }, (_, i) => `S${i}`) } }))).status).toBe(400);
    expect((await call(req({ body: { symbols: ['VOO', 'not a ticker!'] } }))).status).toBe(400);
    expect((await call(req({ body: { symbols: ['VOO'], kind: 'insider-trades' } }))).status).toBe(400);
  });
});

describe('quotes function — data & cache', () => {
  it('returns normalised quotes keyed by symbol; unknown tickers are null', async () => {
    const { status, json } = await call(req({ body: { symbols: ['voo', 'ZZZZ'] } }));
    expect(status).toBe(200);
    expect(json.data.VOO).toMatchObject({ price: 512.4, prevClose: 509.3, dayChangePct: 0.61 });
    expect(json.data.ZZZZ).toBeNull();
    expect(json.stale).toBe(false);
  });

  it('serves repeats from the per-instance cache within the TTL', async () => {
    await call(req({ body: { symbols: ['AAPL'] } }));
    const before = finnhubCalls.length;
    ctl.price = 999; // a fresh fetch would show this
    const { json } = await call(req({ body: { symbols: ['AAPL'] } }));
    expect(finnhubCalls.length).toBe(before); // no new upstream call
    expect(json.data.AAPL.price).toBe(512.4); // cached value, not 999
  });

  it('flags stale on Finnhub 429 without caching the miss', async () => {
    ctl.finnhubStatus = 429;
    const r1 = await call(req({ body: { symbols: ['MSFT'] } }));
    expect(r1.json.stale).toBe(true);
    expect(r1.json.data.MSFT).toBeNull();
    ctl.finnhubStatus = 200;
    const r2 = await call(req({ body: { symbols: ['MSFT'] } }));
    expect(r2.json.data.MSFT.price).toBeGreaterThan(0); // retried, not cached-null
  });

  it('passes recommendation kind through untouched', async () => {
    const { json } = await call(req({ body: { symbols: ['NVDA'], kind: 'recommendation' } }));
    expect(json.kind).toBe('recommendation');
    expect(json.data.NVDA[0]).toMatchObject({ buy: 12, hold: 4, sell: 1 });
  });

  it('503s when the key is missing', async () => {
    vi.stubEnv('FINNHUB_API_KEY', '');
    const { status } = await call(req({ body: { symbols: ['VOO'] } }));
    expect(status).toBe(503);
    vi.stubEnv('FINNHUB_API_KEY', 'fh-test-key');
  });
});
