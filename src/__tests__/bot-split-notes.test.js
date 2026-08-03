// The Telegram bot splits receipts too, and it used to log the resulting
// transactions with no note at all — the dashboard scanner recorded which line
// items went into each category, the bot threw them away at categorizeItems()
// and never wrote settings.transactionNotes.
//
// These cover the seam, not the helpers: that finalizeSplit writes a note under
// the SAME key the ledger rebuilds from the sheet row. A note under an unread
// key is invisible rather than broken, so a helper-only test would have passed
// throughout the entire period the feature did nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_ALLOWED_USERS', '123456789');
vi.stubEnv('TELEGRAM_EMAIL_MAP', 'sabarish@example.com:123456789,anu@example.com:987654321');
vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client-id');
vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret');
vi.stubEnv('GOOGLE_DRIVE_REFRESH_TOKEN', 'test-refresh');
vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
vi.stubEnv('ALLOWED_EMAILS', 'sabarish@example.com');

const mockStore = {
  data: new Map(),
  get(key) { return Promise.resolve(this.data.get(key) || null); },
  setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
  delete(key) { this.data.delete(key); return Promise.resolve(); },
  list({ prefix }) {
    const blobs = [];
    for (const key of this.data.keys()) if (key.startsWith(prefix)) blobs.push({ key });
    return Promise.resolve({ blobs });
  },
  incrementIfBelow() { return Promise.resolve({ allowed: true, count: 1 }); },
};

const appendExpense = vi.fn();
const saveTransactionNotes = vi.fn();

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => mockStore }));
vi.mock('../../functions/lib/_sheets.mjs', () => ({
  getCurrentMonthSheetId: vi.fn(() => Promise.resolve('sheet-jul-2026')),
  appendExpense: (...a) => appendExpense(...a),
  saveTransactionNotes: (...a) => saveTransactionNotes(...a),
  deleteExpenseByUUID: vi.fn(),
  getTotals: vi.fn(() => Promise.resolve({})),
  getRecentExpenses: vi.fn(() => Promise.resolve([])),
  writeSalaryAmount: vi.fn(),
  writeBudgetAmount: vi.fn(),
  addCategory: vi.fn(),
  checkMonthExists: vi.fn(() => Promise.resolve(true)),
  getLatestMonthData: vi.fn(() => Promise.resolve({})),
  // Costco must be a configured split vendor or the receipt path never reaches
  // the split flow at all — mirrors DEFAULT_SPLIT_VENDORS.
  getUserSettings: vi.fn(() => Promise.resolve({
    splitReceiptVendors: [{ name: 'Costco', patterns: ['costco'] }],
  })),
  createMonth: vi.fn(),
}));
vi.mock('../../functions/lib/_drive.mjs', () => ({
  uploadReceiptImage: vi.fn(() => Promise.resolve({ fileId: 'file-1', folderId: 'folder-1', shareLink: null })),
  moveFile: vi.fn(),
  buildFolderPath: vi.fn(() => Promise.resolve({ folderId: 'folder-1' })),
  getAccessToken: vi.fn(() => Promise.resolve('token')),
  copyFile: vi.fn(),
  shareWithEmails: vi.fn(),
}));

const extractReceiptBatch = vi.fn();
vi.mock('../../functions/lib/_extraction.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  extractReceipt: vi.fn(),
  extractTransactionText: vi.fn(),
  extractReceiptBatch: (...a) => extractReceiptBatch(...a),
}));

globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }));

const { handleTextReply, handleMediaMessage } = await import('../../functions/lib/_bot-core.mjs');
const { txNoteKey } = await import('../../functions/lib/_transaction-notes.mjs');

const USER = '123456789';
const SHEET = 'sheet-jul-2026';

function makeCtx(userId = USER) {
  const sent = [];
  return {
    store: mockStore, userId, sent, channel: 'telegram',
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve({ ok: true }); },
  };
}

/** A Costco split mid-flight: two auto-grouped categories, one hand-sorted item. */
function queueSplit(overrides = {}) {
  mockStore.data.set(`split_confirm:${USER}:base_001`, {
    id: 'base_001',
    phone: USER,
    vendor: 'COSTCO WHOLESALE',
    totalAmount: 102.54,
    txDate: '2026-07-31',
    year: 2026, month: 'Jul',
    paymentMethod: 'Chase Sapphire Reserve',
    autoGroups: [
      { category: 'Grocery', items: [{ name: 'Organic Bananas', amount: 2.99 }, { name: 'Chicken Breast', amount: 55.62 }] },
      { category: 'Misc', items: [{ name: 'Paper Towels', amount: 12.99 }] },
    ],
    groups: { Grocery: 58.61, Misc: 12.99, Thakkali: 25.94 },
    items: [{ name: 'Toor Dal', amount: 25.94, suggestion: null, category: 'Thakkali' }],
    currentIndex: 1,
    ...overrides,
  });
}

beforeEach(() => {
  mockStore.data.clear();
  appendExpense.mockReset();
  // The sheet echoes back the amount it wrote — the ledger later rebuilds the
  // note key from exactly this value.
  appendExpense.mockImplementation(({ amount }) =>
    Promise.resolve({ uuid: `uuid-${amount}`, amount }));
  saveTransactionNotes.mockReset();
  saveTransactionNotes.mockResolvedValue({ saved: true });
});

describe('finalizeSplit writes transaction notes', () => {
  it('records each category\'s own line items', async () => {
    queueSplit();
    await handleTextReply(makeCtx(), 'YES');

    expect(saveTransactionNotes).toHaveBeenCalledTimes(1);
    const [notes] = saveTransactionNotes.mock.calls[0];

    // Grocery is the largest group, so it absorbs the $5.00 tax remainder:
    // 58.61 + 5.00 = 63.61.
    expect(notes[txNoteKey(SHEET, 'Grocery', 'COSTCO WHOLESALE', 63.61)].note)
      .toBe('2 items: Organic Bananas $2.99, Chicken Breast $55.62 · Tax/fees +$5.00');
    expect(notes[txNoteKey(SHEET, 'Misc', 'COSTCO WHOLESALE', 12.99)].note)
      .toBe('1 item: Paper Towels $12.99');
  });

  it('includes items the user sorted by hand in Telegram', async () => {
    queueSplit();
    await handleTextReply(makeCtx(), 'YES');

    const [notes] = saveTransactionNotes.mock.calls[0];
    expect(notes[txNoteKey(SHEET, 'Thakkali', 'COSTCO WHOLESALE', 25.94)].note)
      .toBe('1 item: Toor Dal $25.94');
  });

  it('tags every split transaction so the ledger can filter them', async () => {
    queueSplit();
    await handleTextReply(makeCtx(), 'YES');

    const [notes] = saveTransactionNotes.mock.calls[0];
    for (const data of Object.values(notes)) expect(data.tags).toEqual(['split']);
  });

  it('keys notes to the amount actually written, not the pre-tax subtotal', async () => {
    queueSplit();
    await handleTextReply(makeCtx(), 'YES');

    const [notes] = saveTransactionNotes.mock.calls[0];
    const written = appendExpense.mock.calls.map(([a]) => a);

    // This is the whole ballgame: every key must be rebuildable from what the
    // sheet holds. 58.61 (the subtotal) would be a key nothing ever reads.
    for (const { category, amount } of written) {
      expect(notes).toHaveProperty(txNoteKey(SHEET, category, 'COSTCO WHOLESALE', amount));
    }
    expect(notes).not.toHaveProperty(txNoteKey(SHEET, 'Grocery', 'COSTCO WHOLESALE', 58.61));
  });

  it('writes to the settings row of whoever sent the receipt', async () => {
    queueSplit();
    await handleTextReply(makeCtx(), 'YES');
    expect(saveTransactionNotes.mock.calls[0][1]).toBe('sabarish@example.com');
  });

  it('falls back to the household default for an unmapped sender', async () => {
    queueSplit();
    mockStore.data.set(`split_confirm:555:base_002`, mockStore.data.get(`split_confirm:${USER}:base_001`));
    mockStore.data.delete(`split_confirm:${USER}:base_001`);

    await handleTextReply(makeCtx('555'), 'YES');
    expect(saveTransactionNotes.mock.calls[0][1]).toBe(null);
  });
});

describe('finalizeSplit note failures never cost the user a logged split', () => {
  it('still confirms the split when the note write throws', async () => {
    queueSplit();
    saveTransactionNotes.mockRejectedValue(new Error('Sheets 503'));
    const ctx = makeCtx();

    await handleTextReply(ctx, 'YES');

    expect(appendExpense).toHaveBeenCalledTimes(3);
    expect(ctx.sent.at(-1).text).toContain('Logged COSTCO WHOLESALE split');
  });

  it('skips only the categories that failed to log', async () => {
    queueSplit();
    appendExpense.mockImplementation(({ category, amount }) => {
      if (category === 'Misc') return Promise.reject(new Error('row write failed'));
      return Promise.resolve({ uuid: `uuid-${amount}`, amount });
    });

    await handleTextReply(makeCtx(), 'YES');

    const [notes] = saveTransactionNotes.mock.calls[0];
    // A note for a transaction that isn't in the sheet is a permanent orphan —
    // nothing will ever read it, and nothing will ever clean it up.
    expect(Object.keys(notes)).toHaveLength(2);
    expect(notes).not.toHaveProperty(txNoteKey(SHEET, 'Misc', 'COSTCO WHOLESALE', 12.99));
  });
});

// Everything above starts from a hand-built split state, which would keep
// passing even if the receipt path stopped storing the item lists — the exact
// regression this feature fixes. This drives the real entry point instead.
describe('the receipt path keeps the auto-grouped item lists', () => {
  beforeEach(() => {
    extractReceiptBatch.mockResolvedValue({
      ok: true,
      transactions: [{
        store_name: 'Costco',
        total_amount: 33.48,
        purchase_date: '2026-07-31',
        reward_category: 'Grocery',
        payment_method: 'Chase Sapphire Reserve',
        items: [
          { name: 'Organic Bananas', amount: 2.99 },
          { name: 'Chicken Breast', amount: 15.5 },
          { name: 'Paper Towels', amount: 12.99 },
          { name: 'Denim Jacket', amount: 2.0, item_category: 'Misc' }, // ambiguous → asked
        ],
      }],
    });
  });

  it('stores the items behind each auto group, not just the subtotal', async () => {
    await handleMediaMessage(makeCtx(), 'base64data', 'image/jpeg');

    const state = [...mockStore.data.entries()]
      .find(([k]) => k.startsWith(`split_confirm:${USER}:`))?.[1];

    expect(state).toBeDefined();
    expect(state.autoGroups.length).toBeGreaterThan(0);
    for (const group of state.autoGroups) {
      expect(group.items.length).toBeGreaterThan(0);
      for (const item of group.items) {
        expect(item).toHaveProperty('name');
        expect(item).toHaveProperty('amount');
      }
    }

    // The real categorizer, not a fixture: the grocery items must be there by
    // name, which is what ends up in the note the user reads.
    const grocery = state.autoGroups.find(g => g.category === 'Grocery');
    expect(grocery.items.map(i => i.name)).toContain('Organic Bananas');
  });
});

describe('splits already in flight when this deployed', () => {
  it('still notes the hand-sorted items when autoGroups is missing', async () => {
    // State saved by the previous version: no autoGroups field at all.
    queueSplit({ autoGroups: undefined });

    await handleTextReply(makeCtx(), 'YES');

    const [notes] = saveTransactionNotes.mock.calls[0];
    expect(notes[txNoteKey(SHEET, 'Thakkali', 'COSTCO WHOLESALE', 25.94)].note)
      .toBe('1 item: Toor Dal $25.94');
    // Auto-grouped items are unrecoverable, so those categories get only the
    // tax line if they earned one — never a fabricated item list.
    expect(notes[txNoteKey(SHEET, 'Misc', 'COSTCO WHOLESALE', 12.99)]).toBeUndefined();
  });

  it('logs the split normally even when no note can be built', async () => {
    queueSplit({ autoGroups: undefined, items: [] });
    const ctx = makeCtx();

    await handleTextReply(ctx, 'YES');

    expect(appendExpense).toHaveBeenCalledTimes(3);
    expect(ctx.sent.at(-1).text).toContain('Logged COSTCO WHOLESALE split');
  });
});
