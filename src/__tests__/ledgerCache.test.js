import { describe, it, expect, beforeEach } from 'vitest';
import {
  ledgerCache,
  ledgerCacheKey,
  invalidateLedger,
  readMemoryCache,
  loadCachedLedger,
  storeLedger,
  LOCAL_CACHE_MAX_AGE_MS,
  CACHE_MS,
} from '../ledgerCache.js';
import { findHighlightTarget } from '../txHighlight.js';

// Minimal localStorage — the suite runs in node, where there isn't one.
function installLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

let store;
beforeEach(() => {
  store = installLocalStorage();
  ledgerCache.clear();
});

describe('invalidateLedger', () => {
  it('clears BOTH the memory map and the localStorage mirror', () => {
    // The reported bug: callers cleared only the Map, so the tab warm-started
    // from an hour-old localStorage copy and the new transaction was missing.
    storeLedger('sheet-1', [{ vendor: 'Costco' }]);
    expect(readMemoryCache('sheet-1')).toBeTruthy();
    expect(store.get(ledgerCacheKey('sheet-1'))).toBeTruthy();

    invalidateLedger('sheet-1');

    expect(ledgerCache.get('sheet-1')).toBeUndefined();
    expect(localStorage.getItem(ledgerCacheKey('sheet-1'))).toBeNull();
  });

  it('leaves other months alone', () => {
    storeLedger('sheet-1', [{ vendor: 'A' }]);
    storeLedger('sheet-2', [{ vendor: 'B' }]);

    invalidateLedger('sheet-1');

    expect(readMemoryCache('sheet-2')).toBeTruthy();
    expect(localStorage.getItem(ledgerCacheKey('sheet-2'))).toBeTruthy();
  });

  it('is a no-op without a sheetId', () => {
    storeLedger('sheet-1', [{ vendor: 'A' }]);
    expect(() => invalidateLedger(undefined)).not.toThrow();
    expect(readMemoryCache('sheet-1')).toBeTruthy();
  });

  it('survives localStorage throwing (private mode)', () => {
    storeLedger('sheet-1', [{ vendor: 'A' }]);
    globalThis.localStorage.removeItem = () => { throw new Error('QuotaExceeded'); };
    expect(() => invalidateLedger('sheet-1')).not.toThrow();
    // The memory tier must still be dropped even if the mirror can't be.
    expect(ledgerCache.get('sheet-1')).toBeUndefined();
  });
});

describe('storeLedger / readMemoryCache', () => {
  it('writes both tiers together so they cannot disagree', () => {
    storeLedger('sheet-1', [{ vendor: 'Costco' }]);
    const mirrored = JSON.parse(localStorage.getItem(ledgerCacheKey('sheet-1')));
    expect(mirrored.data).toEqual([{ vendor: 'Costco' }]);
    expect(readMemoryCache('sheet-1').data).toEqual(mirrored.data);
  });

  it('treats an entry older than CACHE_MS as absent', () => {
    ledgerCache.set('sheet-1', { data: [], fetchedAt: Date.now() - CACHE_MS - 1 });
    expect(readMemoryCache('sheet-1')).toBeNull();
  });

  it('still caches in memory when localStorage rejects the write', () => {
    globalThis.localStorage.setItem = () => { throw new Error('QuotaExceeded'); };
    expect(() => storeLedger('sheet-1', [{ vendor: 'A' }])).not.toThrow();
    expect(readMemoryCache('sheet-1')).toBeTruthy();
  });
});

describe('loadCachedLedger', () => {
  it('returns a fresh mirror', () => {
    storeLedger('sheet-1', [{ vendor: 'A' }]);
    expect(loadCachedLedger('sheet-1').data).toEqual([{ vendor: 'A' }]);
  });

  it('ignores a mirror past its max age', () => {
    localStorage.setItem(ledgerCacheKey('sheet-1'), JSON.stringify({
      data: [{ vendor: 'A' }],
      fetchedAt: Date.now() - LOCAL_CACHE_MAX_AGE_MS - 1,
    }));
    expect(loadCachedLedger('sheet-1')).toBeNull();
  });

  it('ignores corrupt JSON rather than throwing', () => {
    localStorage.setItem(ledgerCacheKey('sheet-1'), 'not json{');
    expect(loadCachedLedger('sheet-1')).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(loadCachedLedger('sheet-1')).toBeNull();
  });
});

describe('findHighlightTarget', () => {
  const groups = [
    { vendor: 'Costco', key: 'costco', members: [
      { description: 'Costco', uuids: ['u1', 'u2'], amounts: [12.5, 30] },
    ] },
    { vendor: 'Safeway', key: 'safeway', members: [
      { description: 'Safeway', uuids: ['u3'], amounts: [8.25] },
      { description: 'Safeway', uuids: ['u4'], amounts: [4.10] },
    ] },
    { vendor: 'Old Row', key: 'old row', members: [
      { description: 'Old Row', uuids: [], amounts: [99.99] },   // pre-UUID
    ] },
  ];

  it('matches on uuid', () => {
    expect(findHighlightTarget(groups, { uuid: 'u4' }).key).toBe('safeway');
  });

  it('matches a uuid anywhere in a multi-amount row', () => {
    expect(findHighlightTarget(groups, { uuid: 'u2' }).key).toBe('costco');
  });

  it('falls back to vendor + amount for rows with no uuid', () => {
    // V1 rows predate UUIDs entirely; without this they could never be found.
    expect(findHighlightTarget(groups, { vendor: 'Old Row', amount: 99.99 }).key).toBe('old row');
  });

  it('tolerates cent-level drift in the fallback', () => {
    expect(findHighlightTarget(groups, { vendor: 'Old Row', amount: 99.97 }).key).toBe('old row');
  });

  it('rejects a fallback amount that is clearly different', () => {
    expect(findHighlightTarget(groups, { vendor: 'Old Row', amount: 50 })).toBeNull();
  });

  it('falls back when the uuid belongs to another month', () => {
    // A stale uuid must not silently match the wrong row.
    expect(findHighlightTarget(groups, { uuid: 'gone', vendor: 'Costco', amount: 30 }).key).toBe('costco');
  });

  it('returns null when nothing matches', () => {
    expect(findHighlightTarget(groups, { uuid: 'gone' })).toBeNull();
    expect(findHighlightTarget(groups, { vendor: 'Nowhere', amount: 1 })).toBeNull();
    expect(findHighlightTarget([], { uuid: 'u1' })).toBeNull();
    expect(findHighlightTarget(null, { uuid: 'u1' })).toBeNull();
    expect(findHighlightTarget(groups, null)).toBeNull();
  });

  it('is case- and whitespace-insensitive on vendor', () => {
    expect(findHighlightTarget(groups, { vendor: '  old row  ', amount: 99.99 }).key).toBe('old row');
  });
});
