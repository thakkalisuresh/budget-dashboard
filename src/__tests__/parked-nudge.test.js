import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock, settingsMock, store } = vi.hoisted(() => ({
  sendMock: vi.fn(async () => ({ ok: true })),
  settingsMock: vi.fn(async () => ({})),
  // Mirrors the real store: list() returns keys in doc-id (sorted) order.
  store: {
    data: new Map(),
    get(k) { return Promise.resolve(this.data.has(k) ? structuredClone(this.data.get(k)) : null); },
    setJSON(k, v) { this.data.set(k, structuredClone(v)); return Promise.resolve(); },
    delete(k) { this.data.delete(k); return Promise.resolve(); },
    list({ prefix = '' } = {}) {
      return Promise.resolve({ blobs: [...this.data.keys()].filter(k => k.startsWith(prefix)).sort().map(key => ({ key })) });
    },
  },
}));

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => store }));
vi.mock('../../functions/lib/_extraction.mjs', () => ({ CATEGORIES: ['Grocery', 'Eating Out', 'Misc'] }));
vi.mock('../../functions/lib/_sheets.mjs', () => ({ getUserSettingsByEmail: (...a) => settingsMock(...a) }));
vi.mock('../../functions/lib/_telegram.mjs', async () => {
  const actual = await vi.importActual('../../functions/lib/_telegram.mjs');
  return { ...actual, sendMessage: sendMock };
});
const webhookPost = vi.fn();
vi.mock('../../functions/wallet-webhook.mjs', () => ({ walletWebhook: webhookPost }));

const { runParkedNudge } = await import('../../functions/lib/_parked-nudge.mjs');
const { kbCategoryConfirm } = await import('../../functions/lib/_telegram.mjs');

const HOUR = 3600e3, DAY = 24 * HOUR;
const NOW = new Date('2026-09-10T15:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const PRIMARY = 'p@example.com';
const opts = { now: NOW, primaryEmail: PRIMARY, primaryChatId: '111' };

const cat = (id, over = {}) => {
  const b = {
    id, vendor: 'Blue Bottle', amount: 12.5, txDate: '2026-09-09', monthName: 'September',
    sheetId: 'sheet-sep', paymentMethod: 'Sapphire', suggested: 'Eating Out',
    email: PRIMARY, source: 'android', createdAt: ago(20 * HOUR), ...over,
  };
  store.data.set(`category_pending:${over.chat || '111'}:${id}`, b);
  return b;
};
const split = (id, over = {}) => {
  store.data.set(`split_pending:${over.chat || '111'}:${id}`, {
    id, vendor: 'Costco', amount: 200, category: 'Grocery', txDate: '2026-09-09',
    email: PRIMARY, source: 'ios', createdAt: ago(20 * HOUR), ...over,
  });
};

beforeEach(() => {
  store.data.clear();
  vi.clearAllMocks();
  settingsMock.mockResolvedValue({});
  sendMock.mockResolvedValue({ ok: true });
});

describe('category nudge', () => {
  it('nudges only charges parked >= 12h', async () => {
    cat('old1', { createdAt: ago(12 * HOUR) });
    cat('new1', { createdAt: ago(12 * HOUR - 60e3) });
    const r = await runParkedNudge(opts);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(r.nudged).toBe(1);
    expect(sendMock.mock.calls[0][2][0][0].callback_data).toBe('CATFIX:old1:Eating Out');
  });

  it('sends the full kbCategoryConfirm keyboard and the drafted copy', async () => {
    cat('a1', { createdAt: ago(26.5 * HOUR) });
    await runParkedNudge(opts);
    const [chat, text, kb] = sendMock.mock.calls[0];
    expect(chat).toBe('111');
    expect(text).toBe(
      '⏰ Still waiting on a category\n' +
      'Blue Bottle · $12.50 · Sapphire · Sep 2026 · parked 26h\n' +
      'Best guess: Eating Out. Tap the right one:');
    expect(kb).toEqual(kbCategoryConfirm('a1', ['Grocery', 'Eating Out', 'Misc'], 'Eating Out'));
  });

  it("goes to the blob's own chat (the key), not the primary's", async () => {
    cat('c1', { chat: '999' });
    await runParkedNudge(opts);
    expect(sendMock.mock.calls[0][0]).toBe('999');
  });

  it('mentions the originating email only when it differs from the primary', async () => {
    cat('m1', { email: 'other@example.com' });
    cat('m2', { email: 'P@Example.com' });
    await runParkedNudge(opts);
    const texts = sendMock.mock.calls.map(c => c[1]);
    expect(texts.filter(t => t.includes('other@example.com'))).toHaveLength(1);
    expect(texts.filter(t => t.includes('P@Example.com'))).toHaveLength(0);
  });

  it('repeats the next day and never mutates or deletes the blob (never auto-logs)', async () => {
    const b = cat('r1');
    await runParkedNudge(opts);
    await runParkedNudge({ ...opts, now: new Date(NOW.getTime() + DAY) });
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(store.data.get('category_pending:111:r1')).toEqual(b);
  });

  it("builds the keyboard from the blob's own email's categories, then primary's, then built-ins", async () => {
    cat('k1', { email: 'other@example.com', suggested: 'Pets' });
    settingsMock.mockImplementation(async (e) => (e === 'other@example.com' ? { customCategories: ['Pets'] } : {}));
    await runParkedNudge(opts);
    expect(settingsMock).toHaveBeenCalledWith('other@example.com');
    expect(sendMock.mock.calls[0][2][0][0].callback_data).toBe('CATFIX:k1:Pets');

    sendMock.mockClear();
    settingsMock.mockImplementation(async (e) => {
      if (e === 'other@example.com') throw new Error('sheets down');
      return { customCategories: ['Pets'] };
    });
    await runParkedNudge(opts);
    expect(sendMock.mock.calls[0][2][0][0].callback_data).toBe('CATFIX:k1:Pets');

    sendMock.mockClear();
    settingsMock.mockRejectedValue(new Error('sheets down'));
    await runParkedNudge(opts);
    expect(sendMock).toHaveBeenCalledTimes(1); // still nudges, with built-ins
  });

  it('looks settings up once per email per run', async () => {
    cat('s1'); cat('s2'); cat('s3');
    await runParkedNudge(opts);
    expect(settingsMock).toHaveBeenCalledTimes(1);
  });

  it('caps the burst at 8 (oldest first) then sends one summary line for the rest', async () => {
    for (let i = 0; i < 11; i++) cat(`n${String(i).padStart(2, '0')}`, { createdAt: ago((13 + i) * HOUR) });
    const r = await runParkedNudge(opts);
    const nudges = sendMock.mock.calls.filter(c => Array.isArray(c[2]));
    expect(nudges).toHaveLength(8);
    expect(nudges[0][2][0][0].callback_data).toContain('n10'); // oldest first
    expect(r).toMatchObject({ nudged: 8, over: 3 });
    const summary = sendMock.mock.calls.at(-1);
    expect(summary[0]).toBe('111');
    expect(summary[1]).toContain('3 more');
  });

  it('gives up on blobs >= 30 days once: one line, no log, no delete, not nudged again', async () => {
    cat('g1', { createdAt: ago(31 * DAY) });
    cat('g2', { createdAt: ago(45 * DAY) });
    const r = await runParkedNudge(opts);
    expect(r.gaveUp).toBe(2);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][1]).toContain('Giving up on 2');
    expect(store.data.has('category_pending:111:g1')).toBe(true);
    expect(store.data.get('category_pending:111:g1').giveUpNotedAt).toBeTruthy();
    sendMock.mockClear();
    await runParkedNudge({ ...opts, now: new Date(NOW.getTime() + DAY) });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('skips blobs with a missing or unreadable createdAt', async () => {
    cat('bad1', { createdAt: undefined });
    cat('bad2', { createdAt: 'garbage' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await runParkedNudge(opts);
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.nudged).toBe(0);
    warn.mockRestore();
  });

  it('one failed send does not stop the others', async () => {
    cat('f1', { createdAt: ago(30 * HOUR) });
    cat('f2', { createdAt: ago(20 * HOUR) });
    sendMock.mockRejectedValueOnce(new Error('telegram 500'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runParkedNudge(opts);
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect(r.nudged).toBe(1);
    err.mockRestore();
  });

  it('re-sends from the blob data; never posts through the wallet webhook', async () => {
    cat('w1');
    await runParkedNudge(opts);
    expect(webhookPost).not.toHaveBeenCalled();
  });
});

describe('split nudge', () => {
  it('one parked split: text + SKIP button, to the blob chat', async () => {
    split('s1', { chat: '999', createdAt: ago(30 * HOUR) });
    await runParkedNudge(opts);
    const [chat, text, kb] = sendMock.mock.calls[0];
    expect(chat).toBe('999');
    expect(text).toBe(
      '⏰ Still waiting on a receipt\nCostco · $200.00 · parked 30h\n' +
      'Upload the receipt to split it, or tap SKIP to log it as one Grocery expense.');
    expect(kb).toEqual([[{ text: '⏭ SKIP (log as one expense)', callback_data: 'SKIP' }]]);
  });

  it('does not nudge a split parked < 12h', async () => {
    split('s1', { createdAt: ago(2 * HOUR) });
    await runParkedNudge(opts);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('several splits in one chat: ONE message listing all, in the order SKIP acts on (first key)', async () => {
    split('b', { vendor: 'Amazon', amount: 30, createdAt: ago(40 * HOUR) });
    split('a', { vendor: 'Costco', amount: 200, createdAt: ago(20 * HOUR) });
    await runParkedNudge(opts);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const text = sendMock.mock.calls[0][1];
    // key order: split_pending:111:a before :b → Costco first, exactly blobs[0]
    expect(text.indexOf('Costco')).toBeLessThan(text.indexOf('Amazon'));
    expect(text).toContain('SKIP logs the first listed');
  });

  it('counts a split message as one unit toward the cap', async () => {
    for (let i = 0; i < 7; i++) cat(`n${i}`);
    split('s1'); split('s2');
    const r = await runParkedNudge(opts);
    expect(r.nudged + r.splitNudged).toBe(8);
    expect(r.over).toBe(0);
  });
});

describe('empty / degraded', () => {
  it('does nothing when nothing is parked', async () => {
    const r = await runParkedNudge(opts);
    expect(sendMock).not.toHaveBeenCalled();
    expect(r).toMatchObject({ nudged: 0, splitNudged: 0 });
  });
});
