import { describe, it, expect } from 'vitest';
import { cleanCodes, readMfCache, writeMfCache, MF_CACHE_KEY } from '../useMfNav.js';

function memStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m };
}

describe('useMfNav helpers', () => {
  it('cleanCodes keeps valid scheme codes, drops "unmapped"/empty/garbage, dedupes and sorts', () => {
    expect(cleanCodes(['147919', 'unmapped', '', null, undefined, ' 120564 ', 'abc', '147919', '12'])).toEqual(['120564', '147919']);
    expect(cleanCodes(undefined)).toEqual([]);
  });

  it('round-trips the last response through storage', () => {
    const st = memStorage();
    writeMfCache(st, { navs: { 147919: { nav: 37.28 } }, fx: { rate: 83.2 }, lastUpdated: '2026-10-09T10:00:00.000Z' });
    expect(readMfCache(st)).toEqual({ navs: { 147919: { nav: 37.28 } }, fx: { rate: 83.2 }, lastUpdated: '2026-10-09T10:00:00.000Z' });
  });

  it('survives missing, corrupt or throwing storage', () => {
    expect(readMfCache(undefined)).toBeNull();
    expect(readMfCache(memStorage())).toBeNull();
    expect(readMfCache(memStorage({ [MF_CACHE_KEY]: '{not json' }))).toBeNull();
    expect(readMfCache(memStorage({ [MF_CACHE_KEY]: '"a string"' }))).toBeNull();
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    expect(readMfCache(boom)).toBeNull();
    expect(() => writeMfCache(boom, { navs: {}, fx: null, lastUpdated: null })).not.toThrow();
  });
});
