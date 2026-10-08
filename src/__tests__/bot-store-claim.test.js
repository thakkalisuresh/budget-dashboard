import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { vi } from 'vitest';
import { createBotStore } from '../../functions/lib/bot-store.mjs';
import { createFakeDb } from './helpers/fake-firestore.js';

// firebase-admin is only installed under functions/; the store just needs these two symbols.
vi.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: () => '__name__' },
  Timestamp: { fromMillis: (ms) => ({ ms }) },
}));

const OPTS = { windowMs: 120_000, takeoverMs: 30_000, vendor: 'YouTube' };
const KEY = 'wdup:abc:1146';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterAll(() => { vi.useRealTimers(); });

let db, store;
beforeEach(() => {
  vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));
  db = createFakeDb();
  store = createBotStore(db);
});
const advance = (ms) => vi.setSystemTime(Date.now() + ms);

describe('bot-store claimWindow / settleClaim / releaseClaim', () => {
  it('first claim wins, second is blocked and reports the first vendor', async () => {
    const a = await store.claimWindow(KEY, OPTS);
    const b = await store.claimWindow(KEY, { ...OPTS, vendor: 'GOOGLE*YOUTUBE' });
    expect(a.claimed).toBe(true);
    expect(typeof a.token).toBe('string');
    expect(b.claimed).toBe(false);
    expect(b.vendor).toBe('YouTube');
    expect(typeof b.ageMs).toBe('number');
  });

  it('a blocked claim never refreshes the window (measured from the first claim)', async () => {
    const a = await store.claimWindow(KEY, OPTS);
    await store.settleClaim(KEY, a.token);
    advance(90_000);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(false); // blocked at 90s
    advance(40_000); // 130s after the FIRST claim, only 40s after the blocked one
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(true);
  });

  it('a settled claim inside the window blocks; after the window it is claimable', async () => {
    const a = await store.claimWindow(KEY, OPTS);
    await store.settleClaim(KEY, a.token);
    advance(119_000);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(false);
    advance(2_000);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(true);
  });

  it('an unsettled (in-flight) claim blocks for <30s, then is taken over as abandoned', async () => {
    await store.claimWindow(KEY, OPTS);
    advance(29_000);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(false);
    advance(2_000);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(true);
  });

  it('release frees the claim immediately (write failed)', async () => {
    const a = await store.claimWindow(KEY, OPTS);
    await store.releaseClaim(KEY, a.token);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(true);
  });

  it('release/settle with a stale token is a no-op (cannot free a taker-over)', async () => {
    const a = await store.claimWindow(KEY, OPTS);
    advance(31_000);
    const b = await store.claimWindow(KEY, OPTS); // takeover
    expect(b.claimed).toBe(true);
    await store.releaseClaim(KEY, a.token);
    await store.settleClaim(KEY, a.token);
    expect((await store.claimWindow(KEY, OPTS)).claimed).toBe(false);
  });

  it('carries an expireAt so the TTL policy can purge it', async () => {
    await store.claimWindow(KEY, OPTS);
    expect(db.docs.get(KEY).expireAt).toBeDefined();
  });

  it('exactly one of many concurrent claims wins', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claimWindow(KEY, OPTS)));
    expect(results.filter(r => r.claimed)).toHaveLength(1);
  });

  it('setJSON with ttlMs stores an expireAt; without it stores none', async () => {
    await store.setJSON('dup_skipped:1:a', { x: 1 }, { ttlMs: 1000 });
    await store.setJSON('other:1', { x: 1 });
    expect(db.docs.get('dup_skipped:1:a').expireAt).toBeDefined();
    expect(db.docs.get('other:1').expireAt).toBeUndefined();
  });
});
