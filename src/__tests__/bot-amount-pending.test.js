// A $0 wallet tap (gas pump, EV charger) is parked as amount_pending: and the
// user replies on Telegram with the final amount. These cover that reply path,
// the "don't log" button and CANCEL ALL, end to end through handleTextReply.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_ALLOWED_USERS', '123456789');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');
vi.stubEnv('GROQ_API_KEY', ''); // no LLM: category comes from rules / history / extractor

const mockStore = {
  data: new Map(),
  get(key) { return Promise.resolve(this.data.has(key) ? structuredClone(this.data.get(key)) : null); },
  setJSON(key, value) { this.data.set(key, structuredClone(value)); return Promise.resolve(); },
  delete(key) { this.data.delete(key); return Promise.resolve(); },
  list({ prefix }) {
    return Promise.resolve({ blobs: [...this.data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) });
  },
  claimOnce() { return Promise.resolve(true); },
  incrementIfBelow() { return Promise.resolve({ allowed: true, count: 1 }); },
};

const appendExpense = vi.fn();
const getRecentExpenses = vi.fn();
const getUserSettingsByEmail = vi.fn();
const reportError = vi.fn();

vi.mock('../../functions/lib/_error-log.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, reportError: (...a) => reportError(...a) };
});
vi.mock('../../functions/lib/firestore.mjs', () => ({ getDb: () => ({}) }));
vi.mock('../../functions/lib/bot-store.mjs', () => ({ createBotStore: () => mockStore }));
vi.mock('../../functions/lib/_sheets.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getCurrentMonthSheetId: vi.fn(async () => 'sheet-oct'),
    appendExpense: (...a) => appendExpense(...a),
    getRecentExpenses: (...a) => getRecentExpenses(...a),
    getUserSettingsByEmail: (...a) => getUserSettingsByEmail(...a),
  };
});
globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });

const { handleTextReply } = await import('../../functions/lib/_bot-core.mjs');
const { parseReplyAmount, isZeroHold } = await import('../../functions/lib/_amount-pending.mjs');

const USER = '123456789';
function makeCtx() {
  const sent = [];
  return {
    store: mockStore, userId: USER, channel: 'telegram', sent,
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve(undefined); },
  };
}
const hold = (id, over = {}) => {
  const b = {
    id, vendor: 'Costco Gas', txDate: '2026-11-17', monthName: 'November 2026', sheetId: 'sheet-nov',
    paymentMethod: 'Chase Freedom Unlimited', extractedCategory: null,
    email: 'nair.sabarish97@gmail.com', source: 'ios-wallet-tap', createdAt: '2026-11-18T00:56:22.000Z', ...over,
  };
  mockStore.data.set(`amount_pending:${USER}:${id}`, b);
  return b;
};

beforeEach(() => {
  mockStore.data.clear();
  vi.clearAllMocks();
  appendExpense.mockResolvedValue({ uuid: 'tx_1' });
  getRecentExpenses.mockResolvedValue([]);
  getUserSettingsByEmail.mockResolvedValue({});
});

describe('parseReplyAmount', () => {
  it.each([
    ['52.18', 52.18], ['$52.18', 52.18], [' 52 ', 52], ['$ 7.5', 7.5], ['1,234.56', 1234.56],
  ])('reads %j', (text, n) => expect(parseReplyAmount(text)).toBe(n));

  it.each(['0', '0.00', 'abc', '52.18 gas', 'spent 40', '-5', '52.181', '', '12/5'])('ignores %j', (text) => {
    expect(parseReplyAmount(text)).toBeNull();
  });
});

describe('isZeroHold', () => {
  it('a $0 amount from any source is a hold', () => {
    expect(isZeroHold({ amount: 0, amountRaw: '$0.00', fromRawText: false })).toBe(true);
    expect(isZeroHold({ amount: 0, amountRaw: 0, fromRawText: true })).toBe(true);
  });
  it('a blank amount is a hold only on a structured tap', () => {
    expect(isZeroHold({ amount: NaN, amountRaw: '', fromRawText: false })).toBe(true);
    expect(isZeroHold({ amount: NaN, amountRaw: undefined, fromRawText: true })).toBe(false);
  });
  it('a real, negative or garbled amount is not', () => {
    expect(isZeroHold({ amount: 12.5, amountRaw: '12.50', fromRawText: false })).toBe(false);
    expect(isZeroHold({ amount: -5, amountRaw: '-5', fromRawText: false })).toBe(false);
    expect(isZeroHold({ amount: NaN, amountRaw: 'abc', fromRawText: false })).toBe(false);
  });
});

describe('replying with the amount', () => {
  it('logs the hold at the typed amount when history settles the category', async () => {
    hold('aaaa1111');
    getRecentExpenses.mockResolvedValue([
      { vendor: 'COSTCO GAS #0117', category: 'Car Payments' },
      { vendor: 'Costco Gas', category: 'Car Payments' },
      { vendor: 'Costco', category: 'Grocery' }, // warehouse rows don't count
    ]);
    getUserSettingsByEmail.mockResolvedValue({ customCategories: ['Car Payments'] });
    const ctx = makeCtx();
    await handleTextReply(ctx, '$52.18');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(appendExpense.mock.calls[0][0]).toMatchObject({
      vendor: 'Costco Gas', amount: 52.18, category: 'Car Payments', txDate: '2026-11-17',
      sheetId: 'sheet-nov', monthName: 'November 2026', paymentMethod: 'Chase Freedom Unlimited', channel: 'wallet',
    });
    expect(mockStore.data.has(`amount_pending:${USER}:aaaa1111`)).toBe(false);
    expect(ctx.sent.at(-1).text).toBe('Logged Costco Gas · $52.18 as Car Payments.');
    expect(mockStore.data.get(`lastlog:${USER}`)).toMatchObject({ uuid: 'tx_1', amount: 52.18 });
  });

  it('hands an unsettled category to the usual CATFIX prompt, with the amount filled in', async () => {
    hold('bbbb2222', { vendor: 'ChargePoint' });
    // A smart rule is the only non-LLM path that needs no history; without one,
    // and with Groq off, resolveCategory falls back without asking — so force the
    // ask with a split history.
    getRecentExpenses.mockResolvedValue([
      { vendor: 'ChargePoint', category: 'Travel' }, { vendor: 'ChargePoint', category: 'Utilities' },
    ]);
    vi.stubEnv('GROQ_API_KEY', 'gk-test');
    globalThis.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: '{"category":"Travel","confidence":0.6}' } }] }),
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, '18.40');
    vi.stubEnv('GROQ_API_KEY', '');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(mockStore.data.has(`amount_pending:${USER}:bbbb2222`)).toBe(false);
    expect(mockStore.data.get(`category_pending:${USER}:bbbb2222`)).toMatchObject({ vendor: 'ChargePoint', amount: 18.4 });
    const prompt = ctx.sent.at(-1);
    expect(prompt.text).toMatch(/Categorize this charge\nChargePoint · \$18\.40/);
    expect(prompt.keyboard.flat().some(b => b.callback_data.startsWith('CATFIX:bbbb2222:'))).toBe(true);
  });

  it('answers the oldest hold first, then asks about the next', async () => {
    hold('new00001', { vendor: 'Shell', createdAt: '2026-11-18T10:00:00.000Z', txDate: '2026-11-18' });
    hold('old00001', { createdAt: '2026-11-17T10:00:00.000Z' });
    const ctx = makeCtx();
    await handleTextReply(ctx, '40');

    expect(appendExpense.mock.calls[0][0]).toMatchObject({ vendor: 'Costco Gas', amount: 40 });
    expect(mockStore.data.has(`amount_pending:${USER}:new00001`)).toBe(true);
    expect(ctx.sent.at(-1).text).toMatch(/^Next: Shell · Chase Freedom Unlimited on 2026-11-18 also came through as \$0/);
  });

  it('keeps the hold when the write fails, so another reply retries', async () => {
    hold('cccc3333');
    appendExpense.mockRejectedValueOnce(new Error('Sheets 503'));
    const ctx = makeCtx();
    await handleTextReply(ctx, '30');
    expect(mockStore.data.has(`amount_pending:${USER}:cccc3333`)).toBe(true);
    expect(reportError).toHaveBeenCalledWith('BOT-007', expect.any(Error), expect.objectContaining({ flow: 'amount-reply' }));
    expect(ctx.sent.at(-1).text).toMatch(/Reply with the amount again/);
  });

  it('a bare number with no hold waiting is not treated as an amount reply', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, '40').catch(() => {});
    expect(appendExpense).not.toHaveBeenCalled();
  });
});

describe("don't log / cancel", () => {
  it('AMTSKIP drops the hold without logging', async () => {
    hold('dddd4444');
    const ctx = makeCtx();
    await handleTextReply(ctx, 'AMTSKIP:dddd4444');
    expect(mockStore.data.has(`amount_pending:${USER}:dddd4444`)).toBe(false);
    expect(appendExpense).not.toHaveBeenCalled();
    expect(ctx.sent.at(-1).text).toBe("OK — Costco Gas won't be logged.");
  });

  it('CANCEL ALL clears waiting holds too', async () => {
    hold('eeee5555');
    const ctx = makeCtx();
    await handleTextReply(ctx, 'CANCEL ALL');
    expect(mockStore.data.has(`amount_pending:${USER}:eeee5555`)).toBe(false);
    expect(ctx.sent.at(-1).text).toBe('Cancelled.');
  });
});
