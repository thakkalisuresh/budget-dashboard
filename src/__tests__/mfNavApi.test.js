import { describe, it, expect, vi } from 'vitest';
import { fetchMfHistory, fetchInrPerUsd } from '../mfNavApi.js';

const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const err = (status, json = {}) => ({ ok: false, status, json: async () => json });
const noSleep = async () => {};

describe('fetchMfHistory', () => {
  it('POSTs the history action with bearer auth and returns the payload', async () => {
    const f = vi.fn(async () => ok({ schemeCode: '1', date: '2026-11-05', resolvedDate: '2026-11-05', fellBack: false, nav: 123.4 }));
    const r = await fetchMfHistory({ code: '1', date: '2026-11-05', accessToken: 'tok', fetchImpl: f, sleep: noSleep });
    expect(r.nav).toBe(123.4);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/mf-nav');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ action: 'history', code: '1', date: '2026-11-05' });
  });
  it('retries retryable 503/502 then succeeds', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(err(503, { retryable: true }))
      .mockResolvedValueOnce(err(502, { retryable: true }))
      .mockResolvedValueOnce(ok({ nav: 10 }));
    const r = await fetchMfHistory({ code: '1', date: '2026-11-05', accessToken: 't', fetchImpl: f, sleep: noSleep });
    expect(r.nav).toBe(10);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('gives up after maxTries and flags retryable', async () => {
    const f = vi.fn(async () => err(503, { retryable: true }));
    await expect(fetchMfHistory({ code: '1', date: 'd', accessToken: 't', fetchImpl: f, sleep: noSleep, maxTries: 3 }))
      .rejects.toMatchObject({ retryable: true });
    expect(f).toHaveBeenCalledTimes(3);
  });
  it('does not retry hard errors', async () => {
    const f = vi.fn(async () => err(400, { error: 'bad date' }));
    await expect(fetchMfHistory({ code: '1', date: 'd', accessToken: 't', fetchImpl: f, sleep: noSleep }))
      .rejects.toMatchObject({ message: 'bad date', retryable: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('treats network failure as retryable', async () => {
    const f = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(ok({ nav: 5 }));
    const r = await fetchMfHistory({ code: '1', date: 'd', accessToken: 't', fetchImpl: f, sleep: noSleep });
    expect(r.nav).toBe(5);
  });
  it('rejects a response without a usable NAV', async () => {
    const f = vi.fn(async () => ok({ nav: null }));
    await expect(fetchMfHistory({ code: '1', date: 'd', accessToken: 't', fetchImpl: f, sleep: noSleep })).rejects.toThrow(/NAV/);
  });
});

describe('fetchInrPerUsd', () => {
  it('returns the rate or null on any failure', async () => {
    const good = vi.fn(async () => ok({ fx: { currency: 'INR', rate: 88.2, updatedAt: 'x' } }));
    expect(await fetchInrPerUsd({ accessToken: 't', fetchImpl: good, sleep: noSleep })).toBe(88.2);
    const bad = vi.fn(async () => err(500));
    expect(await fetchInrPerUsd({ accessToken: 't', fetchImpl: bad, sleep: noSleep })).toBeNull();
    const weird = vi.fn(async () => ok({ fx: { rate: 'x' } }));
    expect(await fetchInrPerUsd({ accessToken: 't', fetchImpl: weird, sleep: noSleep })).toBeNull();
  });
});
