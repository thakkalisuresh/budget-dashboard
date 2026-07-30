// Batch queue controls: SKIP one item of a multi-transaction screenshot without
// destroying the rest, and offer Edit on a single receipt.
//
// The bug these cover: CANCEL used to list every `confirm:<user>:` blob and
// delete all of them, so cancelling transaction 2 of 5 threw away 3, 4 and 5.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-05-15T12:00:00Z')); });
afterAll(() => { vi.useRealTimers(); });

vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'test-webhook-secret');
vi.stubEnv('TELEGRAM_ALLOWED_USERS', '123456789');
vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
vi.stubEnv('GOOGLE_DRIVE_REFRESH_TOKEN', 'test-refresh');
vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');
vi.stubEnv('SITE_URL', 'https://test-dashboard.netlify.app');

const mockStore = {
  data: new Map(),
  get(key) { return Promise.resolve(this.data.get(key) || null); },
  setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
  delete(key) { this.data.delete(key); return Promise.resolve(); },
  list({ prefix, limit }) {
    const blobs = [];
    for (const key of this.data.keys()) if (key.startsWith(prefix)) blobs.push({ key });
    // Deliberately reverse-sorted: store.list ordering isn't guaranteed in
    // Firestore, so the code must not depend on insertion order.
    blobs.sort((a, b) => b.key.localeCompare(a.key));
    return Promise.resolve({ blobs: limit != null ? blobs.slice(0, limit) : blobs });
  },
  claimOnce(key) {
    if (this.data.has(key)) return Promise.resolve(false);
    this.data.set(key, { ts: Date.now() });
    return Promise.resolve(true);
  },
  incrementIfBelow(key, limit) {
    const count = (this.data.get(key)?.count) || 0;
    if (count >= limit) return Promise.resolve({ allowed: false, count });
    this.data.set(key, { count: count + 1 });
    return Promise.resolve({ allowed: true, count: count + 1 });
  },
};

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => mockStore }));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { handleTextReply } = await import('../../functions/lib/_bot-core.mjs');

const USER = '123456789';

/** Records everything the bot sends back, with its inline keyboard. */
function makeCtx() {
  const sent = [];
  return {
    store: mockStore,
    userId: USER,
    sent,
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve({ ok: true }); },
  };
}

function queueBatch(total, { user = USER } = {}) {
  for (let i = 0; i < total; i++) {
    mockStore.data.set(`confirm:${user}:base_${String(i).padStart(3, '0')}`, {
      id: `base_${String(i).padStart(3, '0')}`,
      phone: user,
      extraction: { store_name: `Vendor ${i + 1}`, total_amount: 10 + i, reward_category: 'Misc' },
      conversionInfo: null,
      year: 2026, month: 'May',
      status: 'awaiting_confirmation',
      batchIndex: i + 1,
      batchTotal: total,
    });
  }
}

const confirmKeys = () => [...mockStore.data.keys()].filter(k => k.startsWith(`confirm:${USER}:`));
const flatButtons = (kb) => (kb || []).flat().map(b => b.callback_data);

beforeEach(() => {
  mockStore.data.clear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
});

describe('SKIP on a batch', () => {
  it('drops only the current item and leaves the rest queued', async () => {
    queueBatch(5);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'SKIP');

    expect(confirmKeys()).toHaveLength(4);
    expect(confirmKeys()).not.toContain(`confirm:${USER}:base_000`);
    // The four survivors are the whole point — this is the reported bug.
    expect(confirmKeys().sort()).toEqual([
      `confirm:${USER}:base_001`, `confirm:${USER}:base_002`,
      `confirm:${USER}:base_003`, `confirm:${USER}:base_004`,
    ]);
  });

  it('reports the skip and prompts for the next item', async () => {
    queueBatch(5);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'SKIP');

    const [msg] = ctx.sent;
    expect(msg.text).toContain('1/5 skipped');
    expect(msg.text).toContain('Vendor 1');
    expect(msg.text).toContain('Vendor 2');       // the next prompt follows
    expect(flatButtons(msg.keyboard)).toContain('SKIP');
  });

  it('picks the lowest-sorting key regardless of list order', async () => {
    // The mock deliberately returns blobs in reverse order; without the sort the
    // bot would skip the LAST item and mislabel it.
    queueBatch(3);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'SKIP');

    expect(confirmKeys()).not.toContain(`confirm:${USER}:base_000`);
    expect(ctx.sent[0].text).toContain('1/3 skipped');
  });

  it('closes the batch out when the last item is skipped', async () => {
    queueBatch(1);
    mockStore.data.get(`confirm:${USER}:base_000`).batchTotal = 1;
    const ctx = makeCtx();

    await handleTextReply(ctx, 'SKIP');

    expect(confirmKeys()).toHaveLength(0);
    expect(ctx.sent[0].text).toContain('skipped');
  });

  it('counts skips so the closing message does not claim everything was logged', async () => {
    queueBatch(3);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'SKIP');
    await handleTextReply(ctx, 'SKIP');
    await handleTextReply(ctx, 'SKIP');

    const final = ctx.sent[ctx.sent.length - 1].text;
    expect(final).toContain('0 logged');
    expect(final).toContain('3 skipped');
    expect(final).not.toContain('All 3 transactions logged');
  });

  it('clears the skip counter once the batch is done', async () => {
    queueBatch(1);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'SKIP');
    expect(mockStore.data.has(`batch_skipped:${USER}`)).toBe(false);
  });
});

describe('CANCEL on a batch', () => {
  it('behaves as SKIP rather than wiping the queue', async () => {
    queueBatch(5);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'CANCEL');

    expect(confirmKeys()).toHaveLength(4);
    expect(ctx.sent[0].text).toContain('1/5 skipped');
  });
});

describe('CANCEL ALL', () => {
  it('clears the whole queue', async () => {
    queueBatch(5);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'CANCEL ALL');

    expect(confirmKeys()).toHaveLength(0);
    expect(ctx.sent[0].text).toBe('Cancelled.');
  });

  it('clears the skip counter too', async () => {
    queueBatch(3);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'SKIP');
    expect(mockStore.data.has(`batch_skipped:${USER}`)).toBe(true);

    await handleTextReply(ctx, 'CANCEL ALL');
    expect(mockStore.data.has(`batch_skipped:${USER}`)).toBe(false);
  });
});

describe('CANCEL outside a batch (regression)', () => {
  it('still cancels a single pending receipt outright', async () => {
    // No batchTotal — cancelling one of one is the wholesale path, unchanged.
    mockStore.data.set(`confirm:${USER}:solo`, {
      id: 'solo', phone: USER,
      extraction: { store_name: 'Solo', total_amount: 12 },
      status: 'awaiting_confirmation',
    });
    const ctx = makeCtx();

    await handleTextReply(ctx, 'CANCEL');

    expect(confirmKeys()).toHaveLength(0);
    expect(ctx.sent[0].text).toBe('Cancelled.');
  });

  it('still cancels a pending salary update', async () => {
    // CANCEL is load-bearing in the salary/budget/wizard flows; making it
    // batch-aware must not disturb them.
    mockStore.data.set(`salary_pending:${USER}`, { amount: 5500 });
    const ctx = makeCtx();

    await handleTextReply(ctx, 'CANCEL');

    expect(mockStore.data.has(`salary_pending:${USER}`)).toBe(false);
    expect(ctx.sent[0].text).toBe('Cancelled.');
  });

  it('reports nothing to cancel when there is nothing pending', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'CANCEL');
    expect(ctx.sent[0].text).toBe('Nothing to cancel.');
  });

  it('an abandoned skip counter alone does not count as something to cancel', async () => {
    mockStore.data.set(`batch_skipped:${USER}`, { count: 2 });
    const ctx = makeCtx();

    await handleTextReply(ctx, 'CANCEL');

    expect(ctx.sent[0].text).toBe('Nothing to cancel.');
    expect(mockStore.data.has(`batch_skipped:${USER}`)).toBe(false);
  });
});

describe('Edit is offered on a single receipt', () => {
  // The edit handlers already worked; the Edit button was simply never attached
  // to the single-receipt prompt, only to batch items. So a lone receipt could
  // be logged or thrown away, nothing else.
  it('keeps Edit on the keyboard after editing a single pending receipt', async () => {
    mockStore.data.set(`confirm:${USER}:solo`, {
      id: 'solo', phone: USER,
      extraction: { store_name: 'Solo', total_amount: 12, reward_category: 'Misc' },
      year: 2026, month: 'May',
      status: 'awaiting_confirmation',
    });
    const ctx = makeCtx();

    await handleTextReply(ctx, 'category: Travel');

    const buttons = flatButtons(ctx.sent[0].keyboard);
    expect(buttons).toContain('edit:menu');
    expect(buttons).toContain('YES');
    // A single receipt has no queue to skip within.
    expect(buttons).not.toContain('SKIP');
  });

  it('keeps SKIP on the keyboard after editing a batch item', async () => {
    // Redrawing a batch prompt with the single-receipt keyboard would strand the
    // user with only YES and a CANCEL that no longer wipes the queue.
    queueBatch(3);
    const ctx = makeCtx();

    await handleTextReply(ctx, 'category: Travel');

    const buttons = flatButtons(ctx.sent[0].keyboard);
    expect(buttons).toContain('SKIP');
    expect(buttons).toContain('edit:menu');
    expect(buttons).toContain('CANCEL ALL');
  });
});

describe('SKIP outside a batch (regression)', () => {
  it('leaves a single non-batch pending receipt alone', async () => {
    mockStore.data.set(`confirm:${USER}:solo`, {
      id: 'solo', phone: USER,
      extraction: { store_name: 'Solo', total_amount: 12 },
      status: 'awaiting_confirmation',
    });
    const ctx = makeCtx();

    await handleTextReply(ctx, 'SKIP');

    // Falls through to the normal router rather than deleting the receipt.
    expect(confirmKeys()).toHaveLength(1);
  });
});
