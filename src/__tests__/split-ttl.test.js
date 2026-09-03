// Bug: a half-finished Costco/Amazon split (split_confirm blob) could wedge the
// bot — every later YES/SPLITCAT resumed the stale split. getActiveSplit expires
// abandoned splits and keeps the freshest one authoritative.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// _bot-core pulls in the Cloud Functions import chain; stub the env it reads at load.
vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'test-webhook-secret');
vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
vi.stubEnv('GOOGLE_DRIVE_REFRESH_TOKEN', 'test-refresh');
vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));

const { getActiveSplit } = await import('../../functions/lib/_bot-core.mjs');

function makeStore() {
  return {
    data: new Map(),
    get(key) { return Promise.resolve(this.data.get(key) || null); },
    setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
    delete(key) { this.data.delete(key); return Promise.resolve(); },
    list({ prefix }) {
      const blobs = [];
      for (const key of this.data.keys()) if (key.startsWith(prefix)) blobs.push({ key });
      blobs.sort((a, b) => b.key.localeCompare(a.key)); // order not guaranteed in Firestore
      return Promise.resolve({ blobs });
    },
  };
}

const U = '123';
const NOW = new Date('2026-05-15T12:00:00Z');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe('getActiveSplit', () => {
  it('returns null when there is no split', async () => {
    expect(await getActiveSplit(makeStore(), U)).toBeNull();
  });

  it('returns a fresh split', async () => {
    const store = makeStore();
    await store.setJSON(`split_confirm:${U}:a`, { vendor: 'Costco', receivedAt: NOW.toISOString() });
    const active = await getActiveSplit(store, U);
    expect(active?.state.vendor).toBe('Costco');
    expect(active?.key).toBe(`split_confirm:${U}:a`);
  });

  it('expires and deletes an abandoned split (older than the TTL)', async () => {
    const store = makeStore();
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();
    await store.setJSON(`split_confirm:${U}:old`, { vendor: 'Costco', receivedAt: twoHoursAgo });
    expect(await getActiveSplit(store, U)).toBeNull();
    expect(store.data.has(`split_confirm:${U}:old`)).toBe(false); // swept
  });

  it('keeps the freshest split when more than one exists, deleting the stale one', async () => {
    const store = makeStore();
    const stale = new Date(NOW.getTime() - 90 * 60 * 1000).toISOString();
    const fresh = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    await store.setJSON(`split_confirm:${U}:stale`, { vendor: 'Old', receivedAt: stale });
    await store.setJSON(`split_confirm:${U}:fresh`, { vendor: 'New', receivedAt: fresh });
    const active = await getActiveSplit(store, U);
    expect(active?.state.vendor).toBe('New');
    expect(store.data.has(`split_confirm:${U}:stale`)).toBe(false);
  });
});
