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
  deleted: [],
  updated: [],
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
    deleteExpenseByUUID: async ({ category, uuid }) => { sheets.deleted.push({ category, uuid }); return {}; },
    updateExpenseAmountByUUID: async ({ category, uuid, amount }) => { sheets.updated.push({ category, uuid, amount }); return { sheetTab: category, rowIndex: 0 }; },
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
    mergeTransactionNotes: async (n) => {
      // Mirror the real null-delete semantics so tests see stale keys removed.
      for (const [k, v] of Object.entries(n)) {
        if (v === null) delete sheets.notes[k];
        else sheets.notes[k] = v;
      }
      return true;
    },
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

const { resolveSplitItems, handleTextReply, buildSplitResultLines } = await import('../../functions/lib/_bot-core.mjs');

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
  sheets.deleted = [];
  sheets.updated = [];
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

describe('buildSplitResultLines — per-item confirmation breakdown', () => {
  it('lists each item under the category it landed in, with its amount', () => {
    const lines = buildSplitResultLines({
      vendor: 'Costco',
      entries: [{ category: 'Grocery', amount: 10.49 }, { category: 'Health', amount: 12.5 }],
      allItems: [
        { name: 'EGGS', amount: 5.99, category: 'Grocery', source: 'learned' },
        { name: 'MILK', amount: 4.5, category: 'Grocery', source: 'keyword' },
        { name: 'VITAMINS', amount: 12.5, category: 'Health', source: 'keyword' },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('Grocery — $10.49');
    expect(text).toContain('   • EGGS $5.99');
    expect(text).toContain('   • MILK $4.50');
    expect(text).toContain('Health — $12.50');
    expect(text).toContain('   • VITAMINS $12.50');
  });

  it('renders a netted/discounted item with its original price and coupon', () => {
    const lines = buildSplitResultLines({
      vendor: 'Costco',
      entries: [{ category: 'Misc', amount: 13.99 }],
      allItems: [{ name: 'SCOTCHNSODA', amount: 13.99, category: 'Misc', discount: 4, source: 'keyword' }],
    });
    expect(lines.join('\n')).toContain('   • SCOTCHNSODA $13.99 (was $17.99, -$4.00 coupon)');
  });

  it('flags only LLM-guessed items with ⚠️ and shows the legend once', () => {
    const lines = buildSplitResultLines({
      vendor: 'Costco',
      entries: [{ category: 'Grocery', amount: 30.98 }],
      allItems: [
        { name: 'BLULANDDISH', amount: 24.99, category: 'Grocery', source: 'llm' },
        { name: 'EGGS', amount: 5.99, category: 'Grocery', source: 'learned' },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('BLULANDDISH $24.99 ⚠️');
    expect(text).toContain('EGGS $5.99');
    expect(text).not.toContain('EGGS $5.99 ⚠️');
    expect(text.match(/⚠️ = auto-sorted/g)).toHaveLength(1);
  });

  it('omits the legend when nothing was LLM-guessed', () => {
    const lines = buildSplitResultLines({
      vendor: 'Costco',
      entries: [{ category: 'Grocery', amount: 5.99 }],
      allItems: [{ name: 'EGGS', amount: 5.99, category: 'Grocery', source: 'keyword' }],
    });
    expect(lines.join('\n')).not.toContain('auto-sorted by AI');
  });

  it('shows the tax/fees remainder against the category that absorbed it so items reconcile', () => {
    const lines = buildSplitResultLines({
      vendor: 'Costco',
      entries: [{ category: 'Grocery', amount: 8.29 }, { category: 'Health', amount: 12.5 }],
      allItems: [
        { name: 'EGGS', amount: 5.99, category: 'Grocery', source: 'keyword' },
        { name: 'VITAMINS', amount: 12.5, category: 'Health', source: 'keyword' },
      ],
      remainder: 2.3,
      remainderCategory: 'Grocery',
    });
    const text = lines.join('\n');
    expect(text).toContain('   • Tax/fees +$2.30');
    // The remainder line sits under Grocery, not Health.
    const groceryIdx = text.indexOf('Grocery — $8.29');
    const healthIdx = text.indexOf('Health — $12.50');
    const taxIdx = text.indexOf('Tax/fees +$2.30');
    expect(taxIdx).toBeGreaterThan(groceryIdx);
    expect(taxIdx).toBeLessThan(healthIdx);
  });

  it('skips a category that is not in entries (e.g. its row write failed)', () => {
    const lines = buildSplitResultLines({
      vendor: 'Costco',
      entries: [{ category: 'Grocery', amount: 5.99 }],
      allItems: [
        { name: 'EGGS', amount: 5.99, category: 'Grocery', source: 'keyword' },
        { name: 'ORPHAN', amount: 9.99, category: 'Health', source: 'keyword' },
      ],
    });
    expect(lines.join('\n')).not.toContain('ORPHAN');
  });
});

describe('split correction — "✏️ Fix a category" moves one item between rows', () => {
  // A finished 2-category split: Grocery $10 (BANANAS), Misc $20 (PAPER TOWELS
  // $5 + ZX9 $10 + $5 folded tax). receiptTotal 30; Misc is the remainder cat.
  function seedTwoCat() {
    mockStore.data.set(`split_confirm:${USER}:base_1`, {
      id: 'base_1', phone: USER, vendor: 'Costco',
      totalAmount: 30, txDate: '2026-05-10', year: 2026, month: 'May',
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

  // A clean 3-category split, no remainder: Grocery 10, Misc 8, Health 12 = 30.
  function seedThreeCat() {
    mockStore.data.set(`split_confirm:${USER}:base_1`, {
      id: 'base_1', phone: USER, vendor: 'Costco',
      totalAmount: 30, txDate: '2026-05-10', year: 2026, month: 'May',
      paymentMethod: '', conversionInfo: null,
      driveFileId: null, driveFolderId: null, driveShareLink: null,
      groups: { Grocery: 10, Misc: 8, Health: 12 },
      autoItems: [
        { name: 'BANANAS', amount: 10, category: 'Grocery', source: 'keyword' },
        { name: 'SOAP', amount: 8, category: 'Misc', source: 'llm' },
        { name: 'VITAMINS', amount: 12, category: 'Health', source: 'keyword' },
      ],
      items: [],
      currentIndex: 0,
      receivedAt: new Date().toISOString(),
    });
  }

  async function finalize(seed) {
    seed();
    await handleTextReply(makeCtx(), 'YES');
    return mockStore.data.get(`lastlog:${USER}`);
  }

  const sumRows = (log) => Math.round(log.entries.reduce((s, e) => s + e.amount, 0) * 100) / 100;

  it('tapping Fix lists the split items as buttons', async () => {
    const log = await finalize(seedTwoCat);
    const ctx = makeCtx();
    await handleTextReply(ctx, `SPLITFIX:${log.splitId}`);
    const msg = ctx.sent.at(-1);
    expect(msg.text).toMatch(/which item/i);
    const labels = msg.keyboard.flat().map(b => b.text).join(' | ');
    expect(labels).toContain('BANANAS');
    expect(labels).toContain('PAPER TOWELS');
  });

  it('A→B move adjusts both rows, reconciles to the receipt total, and re-teaches', async () => {
    const log = await finalize(seedTwoCat);
    const before = sheets.appended.length;
    const ctx = makeCtx();
    // Move PAPER TOWELS (idx 1) from Misc to Grocery.
    await handleTextReply(ctx, `SPLITFIXCAT:${log.splitId}:1:Grocery`);

    const after = mockStore.data.get(`lastlog:${USER}`);
    // Both rows updated in place (no delete, no append).
    expect(sheets.updated).toEqual(expect.arrayContaining([
      { category: 'Misc', uuid: 'uuid-2', amount: 15 },
      { category: 'Grocery', uuid: 'uuid-1', amount: 15 },
    ]));
    expect(sheets.deleted).toHaveLength(0);
    // RECONCILIATION INVARIANT: rows still sum to the receipt total.
    expect(sumRows(after)).toBe(30);
    expect(after.receiptTotal).toBe(30);
    // The item moved in state and is now user-confirmed (loses the ⚠️ flag).
    expect(after.allItems[1]).toMatchObject({ name: 'PAPER TOWELS', category: 'Grocery', source: 'corrected' });
    // Exactly one re-teach row, item → new category, same splitId.
    expect(sheets.appended).toHaveLength(before + 1);
    const taught = sheets.appended.at(-1);
    expect(taught[3]).toBe('Grocery');
    expect(taught[5]).toBe(log.splitId);
    expect(ctx.sent.at(-1).text).toMatch(/Moved .*Grocery/);
  });

  it('moving the only item out of a category deletes that row and still reconciles', async () => {
    const log = await finalize(seedTwoCat);
    const ctx = makeCtx();
    // BANANAS (idx 0) is all of Grocery → Grocery row should be removed.
    await handleTextReply(ctx, `SPLITFIXCAT:${log.splitId}:0:Misc`);

    const after = mockStore.data.get(`lastlog:${USER}`);
    expect(sheets.deleted).toEqual([{ category: 'Grocery', uuid: 'uuid-1' }]);
    expect(sheets.updated).toEqual(expect.arrayContaining([{ category: 'Misc', uuid: 'uuid-2', amount: 30 }]));
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({ category: 'Misc', uuid: 'uuid-2', amount: 30 });
    expect(sumRows(after)).toBe(30);
    // The emptied category's stale note key is gone (null-delete).
    expect(Object.keys(sheets.notes).some(k => k.includes('_Grocery_'))).toBe(false);
  });

  it('moving to a category with no row yet creates that row and reconciles', async () => {
    const log = await finalize(seedTwoCat);
    const expensesBefore = sheets.expenses.length;
    const ctx = makeCtx();
    // ZX9 (idx 2) Misc → Furniture (not in the split).
    await handleTextReply(ctx, `SPLITFIXCAT:${log.splitId}:2:Furniture`);

    const after = mockStore.data.get(`lastlog:${USER}`);
    expect(sheets.expenses).toHaveLength(expensesBefore + 1);
    expect(sheets.expenses.at(-1)).toMatchObject({ category: 'Furniture', amount: 10 });
    expect(sheets.updated).toEqual(expect.arrayContaining([{ category: 'Misc', uuid: 'uuid-2', amount: 10 }]));
    expect(after.entries.find(e => e.category === 'Furniture')).toMatchObject({ amount: 10, uuid: 'uuid-3' });
    expect(sumRows(after)).toBe(30);
  });

  it('UNDO after a correction removes the CORRECTED rows, not the originals', async () => {
    const log = await finalize(seedTwoCat);
    await handleTextReply(makeCtx(), `SPLITFIXCAT:${log.splitId}:0:Misc`); // deletes Grocery, Misc→30
    sheets.deleted = []; // isolate the UNDO deletes
    await handleTextReply(makeCtx(), 'UNDO');
    // Only the surviving (merged) Misc row remains to delete — the original
    // Grocery uuid-1 is already gone, so UNDO must not try to re-delete it.
    expect(sheets.deleted).toEqual([{ category: 'Misc', uuid: 'uuid-2' }]);
    expect(mockStore.data.get(`lastlog:${USER}`)).toBeFalsy();
  });

  it('leaves unrelated categories in the same split untouched', async () => {
    const log = await finalize(seedThreeCat); // Grocery 10, Misc 8, Health 12
    const ctx = makeCtx();
    // Move SOAP (idx 1) Misc → Grocery; Health must not be touched.
    await handleTextReply(ctx, `SPLITFIXCAT:${log.splitId}:1:Grocery`);

    const after = mockStore.data.get(`lastlog:${USER}`);
    const touched = [...sheets.updated, ...sheets.deleted].map(x => x.category);
    expect(touched).not.toContain('Health');
    expect(after.entries.find(e => e.category === 'Health')).toMatchObject({ uuid: 'uuid-3', amount: 12 });
    expect(sumRows(after)).toBe(30);
  });

  it('refuses to correct a split that is no longer the most recent', async () => {
    await finalize(seedTwoCat);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'SPLITFIX:sp-some-other-split');
    expect(ctx.sent.at(-1).text).toMatch(/no longer the most recent/i);
    expect(sheets.updated).toHaveLength(0);
    expect(sheets.deleted).toHaveLength(0);
  });
});
