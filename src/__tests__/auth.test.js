import { describe, it, expect } from 'vitest';
import { corsOriginFor, hasValidSecFetchSite, sendJson } from '../../functions/lib/http-common.mjs';

// Express-style request: header lookup via req.get(name).
function fakeReq(headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()] };
}

// Express-style response capturer for sendJson.
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    set(key, value) { this.headers[key.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
  };
}

describe('corsOriginFor', () => {
  it('accepts the production web.app origin', () => {
    expect(corsOriginFor(fakeReq({ origin: 'https://fundient-dashboard.web.app' })))
      .toBe('https://fundient-dashboard.web.app');
  });

  it('accepts the firebaseapp.com origin', () => {
    expect(corsOriginFor(fakeReq({ origin: 'https://fundient-dashboard.firebaseapp.com' })))
      .toBe('https://fundient-dashboard.firebaseapp.com');
  });

  it('accepts localhost dev origin', () => {
    expect(corsOriginFor(fakeReq({ origin: 'http://localhost:5173' }))).toBe('http://localhost:5173');
  });

  it('rejects unknown origin', () => {
    expect(corsOriginFor(fakeReq({ origin: 'https://evil.com' }))).toBeNull();
  });

  it('rejects empty origin', () => {
    expect(corsOriginFor(fakeReq({}))).toBeNull();
  });
});

describe('hasValidSecFetchSite', () => {
  it('accepts same-origin', () => {
    expect(hasValidSecFetchSite(fakeReq({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('accepts same-site', () => {
    expect(hasValidSecFetchSite(fakeReq({ 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it('rejects cross-site', () => {
    expect(hasValidSecFetchSite(fakeReq({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('rejects missing header', () => {
    expect(hasValidSecFetchSite(fakeReq({}))).toBe(false);
  });
});

describe('sendJson', () => {
  it('writes status, JSON body, and CORS header when origin provided', () => {
    const res = fakeRes();
    sendJson(res, 200, { ok: true }, 'https://fundient-dashboard.web.app');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['access-control-allow-origin']).toBe('https://fundient-dashboard.web.app');
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('omits the CORS header when origin is null', () => {
    const res = fakeRes();
    sendJson(res, 403, { error: 'Forbidden' }, null);
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ error: 'Forbidden' });
  });
});
