// Typed expense commands: "Add walgreen $53.11".
//
// Two behaviours under test. First, ROUTING — these messages used to be caught by
// looksLikeTransactionText (≥15 chars containing a "$") and handed to the
// *bank-SMS* extractor, so a plain instruction went through a
// Gemini→Gemini→Claude chain built for payment notifications. Second, WRITE-FIRST
// — with a vendor and an amount the row goes to the sheet immediately, and
// whatever the bot had to guess is offered back afterwards rather than gated
// behind a YES.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-05-15T12:00:00Z')); });
afterAll(() => { vi.useRealTimers(); });

vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_ALLOWED_USERS', '123456789');
vi.stubEnv('GEMINI_API_KEY', 'test-gemini-key');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');
vi.stubEnv('SITE_URL', 'https://test-dashboard.netlify.app');
// Deliberately no GROQ_API_KEY: resolveCategory then falls back to the extractor
// layer, which keeps every assertion here deterministic.

const mockStore = {
  data: new Map(),
  get(key) { return Promise.resolve(this.data.get(key) || null); },
  setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
  delete(key) { this.data.delete(key); return Promise.resolve(); },
  list({ prefix, limit }) {
    const blobs = [];
    for (const key of this.data.keys()) if (key.startsWith(prefix)) blobs.push({ key });
    blobs.sort((a, b) => b.key.localeCompare(a.key));
    return Promise.resolve({ blobs: limit != null ? blobs.slice(0, limit) : blobs });
  },
  claimOnce() { return Promise.resolve(true); },
  incrementIfBelow() { return Promise.resolve({ allowed: true, count: 1 }); },
};

const appendExpense        = vi.fn();
const deleteExpenseByUUID  = vi.fn();
const getUserSettings      = vi.fn();
const getRecentExpenses    = vi.fn();
const extractTransactionText = vi.fn();

vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => mockStore }));

vi.mock('../../functions/lib/_sheets.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCurrentMonthSheetId: vi.fn(async () => 'sheet-123'),
    appendExpense:          (...a) => appendExpense(...a),
    deleteExpenseByUUID:    (...a) => deleteExpenseByUUID(...a),
    getUserSettings:        (...a) => getUserSettings(...a),
    getRecentExpenses:      (...a) => getRecentExpenses(...a),
    getTotals:              vi.fn(async () => ({ salary: 5000, categories: [] })),
  };
});

vi.mock('../../functions/lib/_extraction.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, extractTransactionText: (...a) => extractTransactionText(...a) };
});

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { handleTextReply, looksLikeExpenseCommand, parseExpenseCommand } =
  await import('../../functions/lib/_bot-core.mjs');

const USER = '123456789';

function makeCtx() {
  const sent = [];
  return {
    store: mockStore,
    userId: USER,
    channel: 'telegram',
    sent,
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve({ ok: true }); },
  };
}

const flatButtons = (kb) => (kb || []).flat().map(b => b.callback_data);
const lastSent    = (ctx) => ctx.sent[ctx.sent.length - 1];

beforeEach(() => {
  mockStore.data.clear();
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });
  appendExpense.mockReset();
  appendExpense.mockResolvedValue({ uuid: 'tx_5311_abcd1234', row: [] });
  deleteExpenseByUUID.mockReset();
  deleteExpenseByUUID.mockResolvedValue({ ok: true });
  getUserSettings.mockReset();
  getUserSettings.mockResolvedValue({ cards: ['Amex BCP', 'Chase Freedom'], cardRules: [], smartRules: [] });
  getRecentExpenses.mockReset();
  getRecentExpenses.mockResolvedValue([]);
  extractTransactionText.mockReset();
  extractTransactionText.mockResolvedValue({ ok: false, error: 'illegible' });
});

describe('looksLikeExpenseCommand', () => {
  it('accepts imperative commands with an amount', () => {
    for (const t of ['Add walgreen $53.11', 'log starbucks 6.50', 'spent 40 at shell',
                     'paid $120 to comcast', 'bought coffee $4']) {
      expect(looksLikeExpenseCommand(t), t).toBe(true);
    }
  });

  it('accepts a bare "<vendor> <amount>" pair', () => {
    expect(looksLikeExpenseCommand('walgreens 53.11')).toBe(true);
    expect(looksLikeExpenseCommand('shell $40')).toBe(true);
  });

  it('accepts a verb with no amount, so the bot can ask for it', () => {
    expect(looksLikeExpenseCommand('add walgreens')).toBe(true);
  });

  it('leaves genuine bank SMS to the transaction extractor', () => {
    // This is the routing bug: every one of these contains a "$" or a decimal and
    // would otherwise be claimed by the command parser.
    for (const t of [
      'Your card ending in 1234 was charged $53.11 at WALGREENS',
      'INR 2,500.00 debited from a/c XX4567 on 12-05-26',
      'Transaction of $89.20 on your account. Available balance $1,204.55',
      'Chase: $45.00 transaction with SHELL OIL. Ref no 88213',
    ]) {
      expect(looksLikeExpenseCommand(t), t).toBe(false);
    }
  });

  it('leaves questions and the three-part manual form alone', () => {
    expect(looksLikeExpenseCommand('how much on groceries')).toBe(false);
    expect(looksLikeExpenseCommand('what did I spend at shell')).toBe(false);
    expect(looksLikeExpenseCommand('Walmart 45.23 Grocery')).toBe(false);   // manual form owns this
  });

  it('does not treat bare conversation as an expense', () => {
    expect(looksLikeExpenseCommand('thanks')).toBe(false);
    expect(looksLikeExpenseCommand('walgreens')).toBe(false);
    expect(looksLikeExpenseCommand('remind me to check the budget tomorrow please')).toBe(false);
  });
});

describe('parseExpenseCommand', () => {
  it('strips the verb and filler from the vendor', () => {
    expect(parseExpenseCommand('Add walgreen $53.11')).toMatchObject({ vendor: 'walgreen', amount: 53.11 });
    expect(parseExpenseCommand('spent 40 at shell')).toMatchObject({ vendor: 'shell', amount: 40 });
    expect(parseExpenseCommand('paid $120 to comcast')).toMatchObject({ vendor: 'comcast', amount: 120 });
  });

  it('prefers a currency-marked amount over a bare number', () => {
    expect(parseExpenseCommand('add 2 coffees $9').amount).toBe(9);
  });

  it('reads today/yesterday and marks the date as explicit', () => {
    expect(parseExpenseCommand('add shell $40 yesterday')).toMatchObject({ date: '2026-05-14', explicitDate: true });
    expect(parseExpenseCommand('add shell $40')).toMatchObject({ date: null, explicitDate: false });
  });

  it('returns a null amount rather than inventing one', () => {
    expect(parseExpenseCommand('add walgreens')).toMatchObject({ vendor: 'walgreens', amount: null });
  });
});

describe('write-first add', () => {
  it('writes immediately when vendor and amount are both present', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(appendExpense.mock.calls[0][0]).toMatchObject({
      vendor: 'walgreen', amount: 53.11, txDate: '2026-05-15', sheetId: 'sheet-123',
    });
    expect(lastSent(ctx).text).toContain('✅ Logged');
    // No confirmation was staged — that is the whole point of write-first.
    expect([...mockStore.data.keys()].some(k => k.startsWith(`confirm:${USER}:`))).toBe(false);
  });

  it('never reaches the bank-SMS extractor', async () => {
    await handleTextReply(makeCtx(), 'Add walgreen $53.11');
    expect(extractTransactionText).not.toHaveBeenCalled();
  });

  it('records the write in lastlog so UNDO and Edit work', async () => {
    await handleTextReply(makeCtx(), 'walgreens 53.11');
    expect(mockStore.data.get(`lastlog:${USER}`)).toMatchObject({
      uuid: 'tx_5311_abcd1234', vendor: 'walgreens', amount: 53.11,
    });
  });

  it("applies the user's own smart rule and does not ask about the category", async () => {
    getUserSettings.mockResolvedValue({
      cards: [], cardRules: [],
      smartRules: [{ id: 'r1', pattern: 'walgreen', category: 'Health' }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');

    expect(appendExpense.mock.calls[0][0].category).toBe('Health');
    expect(flatButtons(lastSent(ctx).keyboard)).not.toContain('enr:cat');
  });

  it('applies a card rule instead of asking for the card', async () => {
    getUserSettings.mockResolvedValue({
      cards: ['Amex BCP'],
      cardRules: [{ vendorPattern: 'walgreen', card: 'Amex BCP' }],
      smartRules: [{ id: 'r1', pattern: 'walgreen', category: 'Health' }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');

    expect(appendExpense.mock.calls[0][0].paymentMethod).toBe('Amex BCP');
    expect(flatButtons(lastSent(ctx).keyboard)).not.toContain('enr:card');
  });

  it('reports a suspected duplicate without blocking the write', async () => {
    getRecentExpenses.mockResolvedValue([
      { vendor: 'Walgreens', amount: 53.11, txDate: '2026-05-14', category: 'Health' },
    ]);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreens $53.11');

    expect(appendExpense).toHaveBeenCalledTimes(1);          // written anyway
    expect(lastSent(ctx).text).toContain('Possible duplicate');
  });
});

describe('the one blocking question', () => {
  it('asks how much when only the vendor is known, and writes nothing yet', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('How much at walgreens?');
    expect(mockStore.data.get(`awaiting_add:${USER}`)).toMatchObject({ vendor: 'walgreens', missing: 'amount' });
  });

  it('asks where when only the amount is known', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'spent $40');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('$40 — where?');
    expect(mockStore.data.get(`awaiting_add:${USER}`)).toMatchObject({ amount: 40, missing: 'vendor' });
  });

  it('completes the add from the reply', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');
    await handleTextReply(ctx, '53.11');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(appendExpense.mock.calls[0][0]).toMatchObject({ vendor: 'walgreens', amount: 53.11 });
    expect(mockStore.data.has(`awaiting_add:${USER}`)).toBe(false);
  });

  it('re-prompts on an unusable answer rather than writing junk', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');
    await handleTextReply(ctx, 'not a number');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('Send the amount');
    expect(mockStore.data.has(`awaiting_add:${USER}`)).toBe(true);
  });

  it('CANCEL clears a half-finished add', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');
    await handleTextReply(ctx, 'CANCEL');

    expect(mockStore.data.has(`awaiting_add:${USER}`)).toBe(false);
    expect(lastSent(ctx).text).toBe('Cancelled.');
  });
});

describe('post-write enrichment', () => {
  it('offers only the fields it actually had to guess', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');

    const buttons = flatButtons(lastSent(ctx).keyboard);
    expect(buttons).toContain('enr:card');    // no card rule matched
    expect(buttons).toContain('enr:date');    // date was defaulted to today
    expect(buttons).toContain('enr:done');
    expect(buttons).toContain('UNDO');
    expect(buttons).not.toContain('enr:booking');   // not a Travel/Holiday expense
  });

  it('shows no menu at all when nothing was guessed', async () => {
    getUserSettings.mockResolvedValue({
      cards: ['Amex BCP'],
      cardRules: [{ vendorPattern: 'shell', card: 'Amex BCP' }],
      smartRules: [{ id: 'r1', pattern: 'shell', category: 'Misc' }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add shell $40 yesterday');

    expect(flatButtons(lastSent(ctx).keyboard)).toEqual(['edit:last', 'UNDO']);
    expect(mockStore.data.has(`enrich:${USER}`)).toBe(false);
  });

  it('stages answers without writing, then applies them in ONE re-append', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    expect(appendExpense).toHaveBeenCalledTimes(1);

    await handleTextReply(ctx, 'enr:card');
    await handleTextReply(ctx, 'enr:setcard:0');       // Amex BCP
    await handleTextReply(ctx, 'enr:date');
    await handleTextReply(ctx, '2026-05-12');

    // Still just the original write — answers are staged, not applied.
    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(deleteExpenseByUUID).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('Staged (not saved yet)');

    await handleTextReply(ctx, 'enr:done');

    // Exactly one delete + one re-append for BOTH fields, not one per field.
    expect(deleteExpenseByUUID).toHaveBeenCalledTimes(1);
    expect(appendExpense).toHaveBeenCalledTimes(2);
    expect(appendExpense.mock.calls[1][0]).toMatchObject({
      vendor: 'walgreen', amount: 53.11, paymentMethod: 'Amex BCP', txDate: '2026-05-12',
    });
  });

  it('"All good" with nothing staged touches the sheet not at all', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'enr:done');

    expect(deleteExpenseByUUID).not.toHaveBeenCalled();
    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(lastSent(ctx).text).toContain('Left as logged');
  });

  it('refuses a staged date that would land in another month', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'enr:date');
    await handleTextReply(ctx, '2026-04-30');
    await handleTextReply(ctx, 'enr:done');

    // The re-append only ever targets lastlog.sheetId, so crossing months would
    // silently write the row into May's sheet with an April date.
    expect(deleteExpenseByUUID).not.toHaveBeenCalled();
    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(lastSent(ctx).text).toContain('April 2026');
  });
});

describe('logged-expense edits', () => {
  it('can change the card on an already-logged row', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'enr:done');

    await handleTextReply(ctx, 'edit:last');
    expect(flatButtons(lastSent(ctx).keyboard)).toContain('edit:lf:card');

    await handleTextReply(ctx, 'edit:lf:card');
    await handleTextReply(ctx, 'edit:lastcard:1');           // Chase Freedom

    expect(appendExpense).toHaveBeenCalledTimes(2);
    expect(appendExpense.mock.calls[1][0].paymentMethod).toBe('Chase Freedom');
  });

  it('clearing the card writes an empty string, not the old value', async () => {
    getUserSettings.mockResolvedValue({
      cards: ['Amex BCP'],
      cardRules: [{ vendorPattern: 'walgreen', card: 'Amex BCP' }],
      smartRules: [],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'edit:last');
    await handleTextReply(ctx, 'edit:lastcard:-1');          // None

    expect(appendExpense.mock.calls[1][0].paymentMethod).toBe('');
  });

  it('can rename the vendor on an already-logged row', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'enr:done');
    await handleTextReply(ctx, 'edit:lf:store');
    await handleTextReply(ctx, 'Walgreens #4412');

    expect(appendExpense.mock.calls[1][0].vendor).toBe('Walgreens #4412');
  });
});
