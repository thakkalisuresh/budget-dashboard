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
    // Mirrors production EXACTLY: telegram-webhook's ctx.send awaits sendMessage
    // and returns undefined. A mock that resolves to a truthy value hid a real
    // bug — the router treated send's return as "handled", so a typed add fell
    // through to the SMS extractor and sent a second, phantom confirmation.
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve(undefined); },
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

describe('confirm-first add', () => {
  it('proposes rather than writing, and waits for the tick', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');

    // Nothing in the sheet yet — the category and amount are the two things
    // worth a glance BEFORE the row exists, because fixing a category
    // afterwards means a cross-tab delete and re-append.
    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('Category:');
    expect(lastSent(ctx).text).toContain('Total: $53.11');
    expect(flatButtons(lastSent(ctx).keyboard)).toEqual(expect.arrayContaining(['YES', 'CANCEL', 'edit:menu']));
    expect([...mockStore.data.keys()].some(k => k.startsWith(`confirm:${USER}:`))).toBe(true);
  });

  it('writes once the user confirms', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'YES');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(appendExpense.mock.calls[0][0]).toMatchObject({
      vendor: 'walgreen', amount: 53.11, txDate: '2026-05-15', sheetId: 'sheet-123',
    });
    expect(mockStore.data.get(`lastlog:${USER}`)).toMatchObject({ vendor: 'walgreen', amount: 53.11 });
  });

  it('writes nothing if the user cancels', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'CANCEL');

    expect(appendExpense).not.toHaveBeenCalled();
    expect([...mockStore.data.keys()].some(k => k.startsWith(`confirm:${USER}:`))).toBe(false);
  });

  it('never reaches the bank-SMS extractor', async () => {
    await handleTextReply(makeCtx(), 'Add walgreen $53.11');
    expect(extractTransactionText).not.toHaveBeenCalled();
  });

  it("applies the user's own smart rule to the proposed category", async () => {
    getUserSettings.mockResolvedValue({
      cards: [], cardRules: [],
      smartRules: [{ id: 'r1', pattern: 'walgreen', category: 'Health' }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');

    expect(lastSent(ctx).text).toContain('Category: Health');
    expect(lastSent(ctx).text).not.toContain('a guess');
  });

  it('flags a low-confidence category on the confirmation', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    // No smart rule and no Groq key, so the category is the fallback — the point
    // is the user sees it before it is committed.
    expect(lastSent(ctx).text).toMatch(/Category: \w/);
  });

  it('applies a card rule to the proposal', async () => {
    getUserSettings.mockResolvedValue({
      cards: ['Amex BCP'],
      cardRules: [{ vendorPattern: 'walgreen', card: 'Amex BCP' }],
      smartRules: [{ id: 'r1', pattern: 'walgreen', category: 'Health' }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    expect(lastSent(ctx).text).toContain('Card: Amex BCP');
  });

  it('shows the date it will use', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    // Defaulted, never "Unknown".
    expect(lastSent(ctx).text).toContain('Date: 2026-05-15');
  });

  it('warns about a suspected duplicate before writing, not after', async () => {
    getRecentExpenses.mockResolvedValue([
      { vendor: 'Walgreens', amount: 53.11, txDate: '2026-05-14', category: 'Health' },
    ]);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreens $53.11');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('Possible duplicate');
    // The affirmative is relabelled so it cannot be a reflex tap.
    expect((lastSent(ctx).keyboard || []).flat().map(b => b.text).join(' ')).toContain('Log anyway');
  });
});

describe('exactly one reply per message', () => {
  /*
   * Live bug, seen on the first real Telegram test: one "Add walgreens 1.23"
   * produced TWO replies — the proposal, and then a second "Transaction found…
   * Reply YES to log" from the bank-SMS extractor. Two pending confirms meant
   * two YES taps could write the expense twice.
   *
   * Cause: the router used ctx.send's return value as the "handled" signal, and
   * telegram-webhook's send returns UNDEFINED, so the check never fired and the
   * message fell through the rest of the router.
   */
  it('does not also run the SMS extractor', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreens 1.23');

    expect(extractTransactionText).not.toHaveBeenCalled();
    expect(ctx.sent).toHaveLength(1);
    // Exactly one pending confirm — two would mean two writes.
    expect([...mockStore.data.keys()].filter(k => k.startsWith(`confirm:${USER}:`))).toHaveLength(1);
  });

  it('sends one reply when asking for a missing amount', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');

    expect(ctx.sent).toHaveLength(1);
    expect(extractTransactionText).not.toHaveBeenCalled();
  });
});

describe('the one blocking question', () => {
  it('asks how much when only the vendor is known, and proposes nothing', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('How much at walgreens?');
    expect(mockStore.data.get(`awaiting_add:${USER}`)).toMatchObject({ vendor: 'walgreens', missing: 'amount' });
  });

  it('asks where when only the amount is known', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'spent $40');

    expect(lastSent(ctx).text).toContain('$40 — where?');
    expect(mockStore.data.get(`awaiting_add:${USER}`)).toMatchObject({ amount: 40, missing: 'vendor' });
  });

  it('proposes the expense once the answer arrives', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');
    await handleTextReply(ctx, '53.11');

    expect(lastSent(ctx).text).toContain('Total: $53.11');
    expect(appendExpense).not.toHaveBeenCalled();     // still waiting for the tick
    await handleTextReply(ctx, 'YES');
    expect(appendExpense.mock.calls[0][0]).toMatchObject({ vendor: 'walgreens', amount: 53.11 });
  });

  it('re-prompts on an unusable answer rather than proposing junk', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens');
    await handleTextReply(ctx, 'not a number');

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

describe('dates use the household timezone, not the server clock', () => {
  /*
   * Cloud Functions runs in UTC. At 8pm Pacific it is already TOMORROW in UTC,
   * so `new Date().toISOString()` dated every evening expense a day late — and
   * one logged late on the 31st landed in the NEXT month's sheet entirely.
   * Seen live: a 10:30pm test logged against the following day.
   */
  it('dates an evening expense to the local day, not the UTC one', async () => {
    vi.setSystemTime(new Date('2026-05-16T03:00:00Z'));   // 8pm May 15 in Los Angeles
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    expect(lastSent(ctx).text).toContain('Date: 2026-05-15');

    await handleTextReply(ctx, 'YES');
    expect(appendExpense.mock.calls[0][0].txDate).toBe('2026-05-15');
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
  });

  it('keeps an evening expense in the right month at a month boundary', async () => {
    vi.setSystemTime(new Date('2026-06-01T03:00:00Z'));   // 8pm May 31 in Los Angeles
    const ctx = makeCtx();
    await handleTextReply(ctx, 'Add walgreen $53.11');
    await handleTextReply(ctx, 'YES');

    // The UTC date would have filed this under June.
    expect(appendExpense.mock.calls[0][0].monthName).toBe('May 2026');
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'));
  });
});

describe('logged-expense edits', () => {
  const logIt = async (ctx, text = 'Add walgreen $53.11') => {
    await handleTextReply(ctx, text);
    await handleTextReply(ctx, 'YES');
  };

  it('can change the card on an already-logged row', async () => {
    const ctx = makeCtx();
    await logIt(ctx);
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
    await logIt(ctx);
    await handleTextReply(ctx, 'edit:last');
    await handleTextReply(ctx, 'edit:lastcard:-1');          // None

    expect(appendExpense.mock.calls[1][0].paymentMethod).toBe('');
  });

  it('can rename the vendor on an already-logged row', async () => {
    const ctx = makeCtx();
    await logIt(ctx);
    await handleTextReply(ctx, 'edit:lf:store');
    await handleTextReply(ctx, 'Walgreens #4412');

    expect(appendExpense.mock.calls[1][0].vendor).toBe('Walgreens #4412');
  });

  it('refuses a date change that would cross into another month', async () => {
    const ctx = makeCtx();
    await logIt(ctx);
    await handleTextReply(ctx, 'edit:lf:date');
    await handleTextReply(ctx, '2026-04-30');

    // The re-append only targets lastlog.sheetId, so crossing months would
    // silently write an April row into May's sheet.
    expect(deleteExpenseByUUID).not.toHaveBeenCalled();
    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(lastSent(ctx).text).toContain('April 2026');
  });
});
