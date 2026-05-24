import { describe, it, expect } from 'vitest';
import { checkOrigin, checkSecFetchSite, corsHeaders, jsonResp } from '../../netlify/functions/_auth.mjs';

function fakeReq(headers = {}) {
  return { headers: new Map(Object.entries(headers)) };
}

describe('checkOrigin', () => {
  it('accepts production origin', () => {
    expect(checkOrigin(fakeReq({ origin: 'https://budget-dashboard-tracker.netlify.app' }))).toBe('https://budget-dashboard-tracker.netlify.app');
  });

  it('accepts localhost dev origin', () => {
    expect(checkOrigin(fakeReq({ origin: 'http://localhost:5173' }))).toBe('http://localhost:5173');
  });

  it('rejects unknown origin', () => {
    expect(checkOrigin(fakeReq({ origin: 'https://evil.com' }))).toBeNull();
  });

  it('rejects empty origin', () => {
    expect(checkOrigin(fakeReq({}))).toBeNull();
  });
});

describe('checkSecFetchSite', () => {
  it('accepts same-origin', () => {
    expect(checkSecFetchSite(fakeReq({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
  });

  it('accepts same-site', () => {
    expect(checkSecFetchSite(fakeReq({ 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it('rejects cross-site', () => {
    expect(checkSecFetchSite(fakeReq({ 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('rejects missing header', () => {
    expect(checkSecFetchSite(fakeReq({}))).toBe(false);
  });
});

describe('corsHeaders', () => {
  it('includes CORS header when origin provided', () => {
    const h = corsHeaders('https://example.com');
    expect(h['Access-Control-Allow-Origin']).toBe('https://example.com');
    expect(h['Content-Type']).toBe('application/json');
  });

  it('omits CORS header when origin is null', () => {
    const h = corsHeaders(null);
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('jsonResp', () => {
  it('returns a Response with correct status and JSON body', async () => {
    const resp = jsonResp(200, { ok: true }, 'https://example.com');
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(resp.headers.get('Access-Control-Allow-Origin')).toBe('https://example.com');
  });

  it('returns error response', async () => {
    const resp = jsonResp(403, { error: 'Forbidden' }, null);
    expect(resp.status).toBe(403);
  });
});
