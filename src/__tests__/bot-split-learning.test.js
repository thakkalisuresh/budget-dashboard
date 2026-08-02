// The Telegram bot's side of split-receipt item learning.
//
// Before this, the bot split receipts with the keyword tables alone: it never
// read what the household had already filed, never wrote anything back, and
// left no note — so a Costco run through Telegram taught nothing and showed up
// in the dashboard as a bare "Costco $84.12".
//
// These cover the two halves that matter: the three-layer decision at the start
// of a split, and the memory + note write at the end of one.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { MEMORY_HEADER } from '../../functions/lib/_item-memory.mjs';

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
vi.stubEnv('ALLOWED_EMAILS', 'me@x.com');

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
  claimOnce() { return Promise.resolve(true); },
  incrementIfBelow() { return Promise.resolve({ allowed: true, count: 1 }); },
};

// Sheets is fully mocked: these tests are about what the bot decides and what
// it hands to the store, not about Google's API.
const sheets = {
  memoryRows: [MEMORY_HEADER],
  appended: [],
  notes: {},
  expenses: [],
};

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => mockStore }));
vi.mock('../../functions/lib/_drive.mjs', () => ({
  getAccessToken: async () => 'token',
  uploadReceiptImage: async () => ({}),
  moveFile: async () => ({}),
  buildFolderPath: async () => ({ folderId: 'f' }),
  copyFile: async () => ({ id: 'x' }),
  shareWithEmails: async () => ({}),
}));
vi.mock('../../functions/lib/_sheets.mjs', async () => {
  const { reduceMemoryRows } = await import('../../functions/lib/_item-memory.mjs');
  return {
    getCurrentMonthSheetId: async () => 'sheet-may',
    appendExpense: async (e) => { sheets.expenses.push(e); return { uuid: `uuid-${sheets.expenses.length}` }; },
    deleteExpenseByUUID: async () => ({}),
    getTotals: async () => ({ salary: 0, categories: {} }),
    getRecentExpenses: async () => [],
    writeSalaryAmount: async () => ({}),
    writeBudgetAmount: async () => ({}),
    addCategory: async () => ({}),
    checkMonthExists: async () => true,
    getLatestMonthData: async () => ({}),
    getUserSettings: async () => ({}),
    createMonth: async () => ({}),
    getItemMemory: async () => reduceMemoryRows(sheets.memoryRows, 'me@x.com'),
    appendItemMemory: async (rows) => { sheets.appended.push(...rows); return true; },
    mergeTransactionNotes: async (n) => { Object.assign(sheets.notes, n); return true; },
    memoryUserId: () => 'me@x.com',
  };
});

const llm = { results: null, calls: 0 };
vi.mock('../../functions/lib/_item-llm.mjs', () => ({
  categorizeItemsBatch: async ({ items }) => {
    llm.calls++;
    return { results: llm.results ?? items.map(() => null) };
  },
}));

const { resolveSplitItems, handleTextReply } = await import('../../functions/lib/_bot-core.mjs');

const USER = '123456789';
const learnedRow = (item, category, at = '2026-01-01') => ['me@x.com', 'Costco', item, category, at, 'sp-old'];

function makeCtx() {
  const sent = [];
  return {
    store: mockStore, userId: USER, sent, channel: 'telegram',
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve({ ok: true }); },
  };
}

beforeEach(() => {
  mockStore.data.clear();
  sheets.memoryRows = [MEMORY_HEADER];
  sheets.appended = [];
  sheets.notes = {};
  sheets.expenses = [];
  llm.results = null;
  llm.calls = 0;
});

describe('resolveSplitItems — the bot decides like the dashboard does', () => {
  it('prefers what the household filed last time over the keyword table', async () => {
    // "chicken" is a keyword-table Grocery hit, but this household files the
    // Costco rotisserie chicken under Eating Out.
    sheets.memoryRows.push(learnedRow('ROTISSERIE CHICKEN', 'Eating Out'));
    const { groups, autoItems, toAsk } = await resolveSplitItems(
      [{ name: 'ROTISSERIE CHICKEN', amount: 4.99 }], 'Costco'
    );
    expect(groups).toEqual({ 'Eating Out': 4.99 });
    expect(autoItems[0].source).toBe('learned');
    expect(toAsk).toEqual([]);
  });

  it('matches a remembered item through abbreviation differences', async () => {
    sheets.memoryRows.push(learnedRow('KS ORG PNT BTR', 'Grocery'));
    const { autoItems } = await resolveSplitItems([{ name: '9988776 ORG PNT BTR 16 oz', amount: 8 }], 'COSTCO');
    expect(autoItems[0]).toMatchObject({ category: 'Grocery', source: 'learned' });
  });

  it('does not reuse another vendor\'s memory', async () => {
    sheets.memoryRows.push(learnedRow('ZX9 WIDGET', 'Furniture'));
    const { toAsk } = await resolveSplitItems([{ name: 'ZX9 WIDGET', amount: 12 }], "Sam's Club");
    expect(toAsk).toHaveLength(1);
  });

  it('falls back to keywords, then asks about the rest', async () => {
    const { groups, toAsk } = await resolveSplitItems(
      [{ name: 'BANANAS', amount: 2 }, { name: 'ZX9 WIDGET', amount: 12 }], 'Costco'
    );
    expect(groups).toEqual({ Grocery: 2 });
    expect(toAsk.map(i => i.name)).toEqual(['ZX9 WIDGET']);
  });

  it('auto-files a confident LLM answer but still asks about an unsure one', async () => {
    llm.results = [
      { category: 'Furniture', confidence: 0.95 },
      { category: 'Misc', confidence: 0.4 },
    ];
    const { groups, autoItems, toAsk } = await resolveSplitItems(
      [{ name: 'ZX9 WIDGET', amount: 12 }, { name: 'QQ THING', amount: 5 }], 'Costco'
    );
    expect(groups).toEqual({ Furniture: 12 });
    expect(autoItems[0].source).toBe('llm');
    // Unsure: asked, with the guess offered as the pre-highlighted button.
    expect(toAsk).toHaveLength(1);
    expect(toAsk[0].suggestion).toBe('Misc');
  });

  it('asks only once for the whole receipt, not once per item', async () => {
    await resolveSplitItems(
      Array.from({ length: 30 }, (_, i) => ({ name: `ZX${i}`, amount: 1 })), 'Costco'
    );
    expect(llm.calls).toBe(1);
  });

  it('skips the LLM entirely when memory and keywords covered everything', async () => {
    sheets.memoryRows.push(learnedRow('ZX9 WIDGET', 'Furniture'));
    await resolveSplitItems([{ name: 'BANANAS', amount: 2 }, { name: 'ZX9 WIDGET', amount: 12 }], 'Costco');
    expect(llm.calls).toBe(0);
  });

  it('ignores a remembered category that no longer has a sheet tab', async () => {
    sheets.memoryRows.push(learnedRow('ZX9 WIDGET', 'DeletedCategory'));
    const { toAsk } = await resolveSplitItems([{ name: 'ZX9 WIDGET', amount: 12 }], 'Costco');
    // Writing to a missing tab would fail — ask instead.
    expect(toAsk).toHaveLength(1);
  });

  it('drops lines with no usable amount', async () => {
    const { groups, toAsk } = await resolveSplitItems(
      [{ name: 'SUBTOTAL' }, { name: 'BANANAS', amount: 2 }], 'Costco'
    );
    expect(groups).toEqual({ Grocery: 2 });
    expect(toAsk).toEqual([]);
  });
});

describe('finalizeSplit — the bot teaches what the receipt decided', () => {
  /** Seed a split that is fully answered and waiting on the YES confirmation. */
  function seedFinishedSplit() {
    mockStore.data.set(`split_confirm:${USER}:base_1`, {
      id: 'base_1', phone: USER, vendor: 'Costco',
      totalAmount: 30, txDate: null, year: 2026, month: 'May',
      paymentMethod: '', conversionInfo: null,
      driveFileId: null, driveFolderId: null, driveShareLink: null,
      groups: { Grocery: 10, Misc: 15 },
      autoItems: [
        { name: 'BANANAS', amount: 10, category: 'Grocery', source: 'keyword' },
        { name: 'PAPER TOWELS', amount: 5, category: 'Misc', source: 'learned' },
      ],
      items: [{ name: 'ZX9 WIDGET', amount: 10, suggestion: null, category: 'Misc' }],
      currentIndex: 1,
      receivedAt: new Date().toISOString(),
    });
  }

  it('records every item, including the ones it never asked about', async () => {
    seedFinishedSplit();
    await handleTextReply(makeCtx(), 'YES');

    const byName = Object.fromEntries(sheets.appended.map(r => [r[2], r[3]]));
    expect(byName).toEqual({ 'BANANAS': 'Grocery', 'PAPER TOWELS': 'Misc', 'ZX9 WIDGET': 'Misc' });
    // Keyed to the household user, so the dashboard reads the same lessons.
    expect(sheets.appended.every(r => r[0] === 'me@x.com')).toBe(true);
    expect(sheets.appended.every(r => r[1] === 'Costco')).toBe(true);
  });

  it('stamps one splitId across the whole receipt so a later move can undo it', async () => {
    seedFinishedSplit();
    await handleTextReply(makeCtx(), 'YES');

    const splitIds = new Set(sheets.appended.map(r => r[5]));
    expect(splitIds.size).toBe(1);
    const [splitId] = [...splitIds];
    expect(splitId).toBeTruthy();
    // The same id rides on every note, which is how a dashboard category move
    // finds the items behind the transaction.
    for (const note of Object.values(sheets.notes)) expect(note.splitId).toBe(splitId);
  });

  it('writes a note per category listing what went into it', async () => {
    seedFinishedSplit();
    await handleTextReply(makeCtx(), 'YES');

    const keys = Object.keys(sheets.notes);
    expect(keys).toHaveLength(2);
    // Keys must match what the dashboard builds: sheetId_category_vendor_amount.
    expect(keys).toContain('sheet-may_Grocery_costco_10.00');
    expect(sheets.notes['sheet-may_Grocery_costco_10.00'].note).toContain('BANANAS');
    expect(sheets.notes['sheet-may_Misc_costco_20.00'].note).toContain('PAPER TOWELS');
  });

  it('labels the tax/fees remainder against the group that absorbed it', async () => {
    seedFinishedSplit();
    // Items sum to 25; the card was charged 30.
    const state = mockStore.data.get(`split_confirm:${USER}:base_1`);
    state.groups = { Grocery: 10, Misc: 15 };
    await handleTextReply(makeCtx(), 'YES');

    // Misc is largest, so it absorbs the $5 and its note says so.
    const miscNote = Object.entries(sheets.notes).find(([k]) => k.includes('_Misc_'))[1];
    expect(miscNote.note).toContain('Tax/fees +$5.00');
  });

  it('still logs the expenses when the memory write fails', async () => {
    seedFinishedSplit();
    const sheetsMod = await import('../../functions/lib/_sheets.mjs');
    vi.spyOn(sheetsMod, 'appendItemMemory').mockRejectedValueOnce(new Error('sheets down'));

    const ctx = makeCtx();
    await handleTextReply(ctx, 'YES');

    // A lost lesson costs one tap next time; a lost expense costs the user money.
    expect(sheets.expenses).toHaveLength(2);
    expect(ctx.sent.some(m => /fail/i.test(m.text))).toBe(false);
  });
});
