// End-to-end multi-expense flow, plus the intelligence layer (§9).
//
// The hazard this suite exists for: appendExpense is a read-then-write with no
// locking — it reads A:H, computes nextRow from the last row with data, and PUTs
// to exactly that range. Multi-expense is the first feature that appends several
// rows in one turn, so two concurrent appends would compute the SAME row and one
// would silently overwrite the other. The writes must be sequential.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-05-15T12:00:00Z')); });
afterAll(() => { vi.useRealTimers(); });

vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-bot-token');
vi.stubEnv('TELEGRAM_ALLOWED_USERS', '123456789');
vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');

const mockStore = {
  data: new Map(),
  get(key) { return Promise.resolve(this.data.get(key) || null); },
  setJSON(key, value) { this.data.set(key, structuredClone(value)); return Promise.resolve(); },
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

const appendExpense       = vi.fn();
const deleteExpenseByUUID = vi.fn();
const getUserSettings     = vi.fn();
const getRecentExpenses   = vi.fn();
const getTotals           = vi.fn();
const addSmartRule        = vi.fn();
const reportError         = vi.fn();

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
    getCurrentMonthSheetId: vi.fn(async () => 'sheet-123'),
    appendExpense:         (...a) => appendExpense(...a),
    deleteExpenseByUUID:   (...a) => deleteExpenseByUUID(...a),
    getUserSettings:       (...a) => getUserSettings(...a),
    getRecentExpenses:     (...a) => getRecentExpenses(...a),
    getTotals:             (...a) => getTotals(...a),
    addSmartRule:          (...a) => addSmartRule(...a),
  };
});

globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ ok: true }) });

const { handleTextReply } = await import('../../functions/lib/_bot-core.mjs');

const USER = '123456789';

function makeCtx() {
  const sent = [];
  return {
    store: mockStore, userId: USER, channel: 'telegram', sent,
    send: (text, keyboard) => { sent.push({ text, keyboard }); return Promise.resolve({ ok: true }); },
  };
}
const flatButtons = (kb) => (kb || []).flat().map(b => b.callback_data);
const lastSent    = (ctx) => ctx.sent[ctx.sent.length - 1];
const allText     = (ctx) => ctx.sent.map(s => s.text).join('\n');

/**
 * Models the real append: read the sheet, find the last used row, write there.
 * Rows are keyed by category tab, exactly as the sheet is.
 */
let sheet;
function installSequentialAppend() {
  appendExpense.mockImplementation(async ({ category, vendor, amount }) => {
    const tab = sheet[category] || (sheet[category] = []);
    const targetRow = tab.length + 2;          // computed from what is there NOW
    await new Promise(r => setTimeout(r, 0));  // a real network gap
    tab[targetRow - 2] = { vendor, amount, row: targetRow };
    return { uuid: `tx_${Math.round(amount * 100)}_${vendor}`, row: [] };
  });
}

beforeEach(() => {
  mockStore.data.clear();
  sheet = {};
  appendExpense.mockReset();
  installSequentialAppend();
  deleteExpenseByUUID.mockReset();
  deleteExpenseByUUID.mockResolvedValue({ ok: true });
  getUserSettings.mockReset();
  getUserSettings.mockResolvedValue({ cards: [], cardRules: [], smartRules: [] });
  getRecentExpenses.mockReset();
  getRecentExpenses.mockResolvedValue([]);
  getTotals.mockReset();
  getTotals.mockResolvedValue({ salary: 5000, categories: [] });
  addSmartRule.mockReset();
  addSmartRule.mockResolvedValue('added');
  reportError.mockReset();
  reportError.mockResolvedValue(undefined);
});

describe('multi-expense: the clean path', () => {
  it('writes every complete item and summarises once', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell 40');

    expect(appendExpense).toHaveBeenCalledTimes(2);
    expect(allText(ctx)).toContain('walgreens');
    expect(allText(ctx)).toContain('shell');
    expect(lastSent(ctx).text).toContain('2 logged');
  });

  it('gives each row its own line in the sheet (writes are sequential)', async () => {
    // Both land in Misc, so a parallel write would compute row 2 twice and the
    // second would overwrite the first.
    const ctx = makeCtx();
    await handleTextReply(ctx, 'shell 40 and chipotle 25');

    const rows = sheet['Misc'].map(r => r.row);
    expect(rows).toEqual([2, 3]);
    expect(new Set(rows).size).toBe(2);
    expect(sheet['Misc'].map(r => r.vendor)).toEqual(['shell', 'chipotle']);
  });
});

describe('multi-expense: ambiguity blocks only what it touches', () => {
  it('logs the complete items, then asks about the incomplete one', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell, plus 25 at chipotle');

    // Two written immediately — the missing amount on Shell holds up only Shell.
    expect(appendExpense).toHaveBeenCalledTimes(2);
    expect(appendExpense.mock.calls.map(c => c[0].vendor)).toEqual(['walgreens', 'chipotle']);
    expect(lastSent(ctx).text).toContain('shell — how much?');
  });

  it('completes the held item from a typed answer', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell');
    await handleTextReply(ctx, '40');

    expect(appendExpense).toHaveBeenCalledTimes(2);
    expect(appendExpense.mock.calls[1][0]).toMatchObject({ vendor: 'shell', amount: 40 });
    expect(lastSent(ctx).text).toContain('2 logged');
  });

  it('can skip a held item without losing the rest', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell');
    await handleTextReply(ctx, 'mx:skip');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(lastSent(ctx).text).toContain('1 logged');
    expect(lastSent(ctx).text).toContain('1 skipped');
  });
});

describe('multi-expense: D2, one amount and several vendors', () => {
  it('asks rather than guessing, and writes nothing yet', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens and shell 93');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('$93');
    expect(flatButtons(lastSent(ctx).keyboard)).toEqual(
      expect.arrayContaining(['mx:d2:last', 'mx:d2:split', 'mx:d2:each'])
    );
  });

  it('"just the last one" writes a single row', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens and shell 93');
    await handleTextReply(ctx, 'mx:d2:last');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(appendExpense.mock.calls[0][0]).toMatchObject({ vendor: 'shell', amount: 93 });
  });

  it('"split evenly" divides it and the parts re-sum exactly', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens and shell 93');
    await handleTextReply(ctx, 'mx:d2:split');

    const amounts = appendExpense.mock.calls.map(c => c[0].amount);
    expect(amounts).toHaveLength(2);
    expect(Math.round(amounts.reduce((a, b) => a + b, 0) * 100) / 100).toBe(93);
  });

  it('"enter each" turns it into one question per vendor', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens and shell 93');
    await handleTextReply(ctx, 'mx:d2:each');
    expect(lastSent(ctx).text).toContain('walgreens — how much?');

    await handleTextReply(ctx, '53');
    expect(lastSent(ctx).text).toContain('shell — how much?');

    await handleTextReply(ctx, '40');
    expect(appendExpense.mock.calls.map(c => c[0].amount)).toEqual([53, 40]);
  });
});

describe('multi-expense: D3, a total that disagrees', () => {
  it('offers to spread the gap, and the result matches the stated total', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'spent 100 on: walgreens 53, shell 40');

    expect(appendExpense).not.toHaveBeenCalled();
    expect(lastSent(ctx).text).toContain('$7.00');

    await handleTextReply(ctx, 'mx:d3:dist');
    const total = appendExpense.mock.calls.reduce((s, c) => s + c[0].amount, 0);
    expect(Math.round(total * 100) / 100).toBe(100);
  });

  it('can book the gap as Misc instead', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'spent 100 on: walgreens 53, shell 40');
    await handleTextReply(ctx, 'mx:d3:misc');

    expect(appendExpense).toHaveBeenCalledTimes(3);
    expect(appendExpense.mock.calls[2][0]).toMatchObject({ vendor: 'Unaccounted', amount: 7 });
  });

  it('can leave the items as stated', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'spent 100 on: walgreens 53, shell 40');
    await handleTextReply(ctx, 'mx:d3:keep');

    expect(appendExpense.mock.calls.map(c => c[0].amount)).toEqual([53, 40]);
  });
});

describe('multi-expense: D4, the same charge twice', () => {
  it('writes one, asks about the twin, and can add it', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'shell 40 and shell 40');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(lastSent(ctx).text).toContain('two visits');

    await handleTextReply(ctx, 'mx:d4:both');
    expect(appendExpense).toHaveBeenCalledTimes(2);
  });

  it('or drop it', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'shell 40 and shell 40');
    await handleTextReply(ctx, 'mx:d4:one');

    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(lastSent(ctx).text).toContain('1 skipped');
  });
});

describe('multi-expense: undoing a batch', () => {
  it('offers Undo all, and reverses every row', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell 40');
    expect(flatButtons(lastSent(ctx).keyboard)).toContain('mx:undoall');

    await handleTextReply(ctx, 'mx:undoall');
    // lastlog only ever holds ONE row, which is why the batch keeps its own record.
    expect(deleteExpenseByUUID).toHaveBeenCalledTimes(2);
    expect(lastSent(ctx).text).toContain('Removed 2');
  });
});

describe('multi-expense: partial failure is reported honestly', () => {
  it('does not claim rows that failed to write', async () => {
    appendExpense.mockImplementationOnce(async () => { throw new Error('Sheets 503'); });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell 40');

    const text = allText(ctx);
    expect(text).toContain('failed');
    expect(lastSent(ctx).text).toContain('1 logged');
  });
});

describe('§9.1 — learning from corrections', () => {
  it('says nothing the first time a vendor is re-filed', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');            // Health

    expect(allText(ctx)).not.toContain('Always put');
  });

  it('offers a rule on the second correction to the same category', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'add walgreens 21.00');
    await handleTextReply(ctx, 'edit:lastcat:10');

    expect(allText(ctx)).toContain('Always put walgreens in Health?');
  });

  it('does not offer when the corrections disagree with each other', async () => {
    // A genuinely mixed vendor: a rule would be wrong for half the charges.
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add amazon 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');            // Health
    await handleTextReply(ctx, 'add amazon 21.00');
    await handleTextReply(ctx, 'edit:lastcat:11');            // Furniture

    expect(allText(ctx)).not.toContain('Always put');
  });

  it('accepting writes the rule into settings.smartRules', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'add walgreens 21.00');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'lrn:yes');

    expect(addSmartRule).toHaveBeenCalledWith('walgreens', 'Health');
    expect(lastSent(ctx).text).toContain('from now on');
  });

  it('"Not again" stops the bot asking about that vendor', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'add walgreens 21.00');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'lrn:never');

    const before = ctx.sent.length;
    await handleTextReply(ctx, 'add walgreens 9.00');
    await handleTextReply(ctx, 'edit:lastcat:10');
    expect(ctx.sent.slice(before).map(s => s.text).join('\n')).not.toContain('Always put');
  });

  it('never offers a rule the user already has', async () => {
    getUserSettings.mockResolvedValue({
      cards: [], cardRules: [], smartRules: [{ id: 'r1', pattern: 'walgreens', category: 'Health' }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:11');
    await handleTextReply(ctx, 'add walgreens 21.00');
    await handleTextReply(ctx, 'edit:lastcat:11');

    expect(allText(ctx)).not.toContain('Always put');
  });
});

describe('§9.2/9.3 — history inferred from the fetch dedup already makes', () => {
  it('uses the card this vendor is always paid with', async () => {
    getUserSettings.mockResolvedValue({ cards: ['Amex BCP'], cardRules: [], smartRules: [] });
    getRecentExpenses.mockResolvedValue([
      { vendor: 'Walgreens', amount: 20, txDate: '2026-05-01', category: 'Health', paymentMethod: 'Amex BCP' },
      { vendor: 'Walgreens', amount: 22, txDate: '2026-05-05', category: 'Health', paymentMethod: 'Amex BCP' },
    ]);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 21.00');

    expect(appendExpense.mock.calls[0][0].paymentMethod).toBe('Amex BCP');
    expect(flatButtons(lastSent(ctx).keyboard)).not.toContain('enr:card');
  });

  it('refuses to guess a card when the history is split', async () => {
    getUserSettings.mockResolvedValue({ cards: ['Amex BCP', 'Chase'], cardRules: [], smartRules: [] });
    getRecentExpenses.mockResolvedValue([
      { vendor: 'Walgreens', amount: 20, txDate: '2026-05-01', category: 'Health', paymentMethod: 'Amex BCP' },
      { vendor: 'Walgreens', amount: 22, txDate: '2026-05-05', category: 'Health', paymentMethod: 'Chase' },
    ]);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 21.00');

    expect(appendExpense.mock.calls[0][0].paymentMethod).toBe('');
    expect(flatButtons(lastSent(ctx).keyboard)).toContain('enr:card');
  });

  it('flags an amount far outside the usual for that vendor', async () => {
    getRecentExpenses.mockResolvedValue([
      { vendor: 'Walgreens', amount: 20, txDate: '2026-05-01', category: 'Health' },
      { vendor: 'Walgreens', amount: 22, txDate: '2026-05-05', category: 'Health' },
      { vendor: 'Walgreens', amount: 18, txDate: '2026-05-09', category: 'Health' },
    ]);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 530.00');

    expect(appendExpense).toHaveBeenCalledTimes(1);          // reported, not blocked
    expect(allText(ctx)).toContain('check the amount');
  });

  it('stays quiet on an ordinary amount', async () => {
    getRecentExpenses.mockResolvedValue([
      { vendor: 'Walgreens', amount: 20, txDate: '2026-05-01', category: 'Health' },
      { vendor: 'Walgreens', amount: 22, txDate: '2026-05-05', category: 'Health' },
      { vendor: 'Walgreens', amount: 18, txDate: '2026-05-09', category: 'Health' },
    ]);
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 21.00');
    expect(allText(ctx)).not.toContain('check the amount');
  });
});

describe('error reporting reaches the logger', () => {
  // WAL-001 was marked fatal but every call site bypassed reportError, so it was
  // invisible to both alerts and the daily digest. These assert the wiring, not
  // just that a code exists in the registry.
  it('reports a half-undone batch, and names the survivors', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'walgreens 53.11 and shell 40');
    deleteExpenseByUUID.mockRejectedValueOnce(new Error('row moved'));
    await handleTextReply(ctx, 'mx:undoall');

    expect(reportError).toHaveBeenCalledWith('BOT-009', expect.any(Error), expect.anything());
    // The user is told which rows are still there — a silent partial undo leaves
    // phantom spending in the budget.
    expect(lastSent(ctx).text).toContain('Still in the sheet');
    expect(lastSent(ctx).text).toContain('BOT-009');
  });

  it('reports a lost learned rule', async () => {
    addSmartRule.mockResolvedValue('failed');
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'add walgreens 21.00');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'lrn:yes');

    expect(reportError).toHaveBeenCalledWith('BOT-010', expect.any(Error), expect.anything());
    expect(lastSent(ctx).text).toContain('BOT-010');
  });

  it('stays quiet when the rule was merely already there', async () => {
    addSmartRule.mockResolvedValue('exists');
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'add walgreens 21.00');
    await handleTextReply(ctx, 'edit:lastcat:10');
    await handleTextReply(ctx, 'lrn:yes');

    // A no-op must not cry wolf in the digest.
    expect(reportError).not.toHaveBeenCalledWith('BOT-010', expect.anything(), expect.anything());
  });

  it('reports when the lookup behind dedup and card inference fails', async () => {
    getRecentExpenses.mockRejectedValue(new Error('Sheets 500'));
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');

    // The write still happens — but silently losing duplicate detection is
    // exactly the kind of degradation that should not go unnoticed.
    expect(appendExpense).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith('BOT-011', expect.any(Error), expect.anything());
  });

  it('reports a failed expense write', async () => {
    appendExpense.mockRejectedValueOnce(new Error('Sheets 503'));
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add walgreens 53.11');

    expect(reportError).toHaveBeenCalledWith('SHT-009', expect.any(Error), expect.anything());
    expect(lastSent(ctx).text).toContain('SHT-009');
  });
});

describe('§9.4 — budget context', () => {
  it('reports where the category now stands', async () => {
    getTotals.mockResolvedValue({
      salary: 5000,
      categories: [{ name: 'Misc', budget: 200, spent: 180 }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add chipotle 25');

    expect(allText(ctx)).toContain('$180.00 of $200.00');
    expect(allText(ctx)).toContain('$20.00 left');
  });

  it('calls out an overspend', async () => {
    getTotals.mockResolvedValue({
      salary: 5000,
      categories: [{ name: 'Misc', budget: 200, spent: 240 }],
    });
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add chipotle 25');
    expect(allText(ctx)).toContain('$40.00 over');
  });

  it('says nothing when the category has no budget', async () => {
    const ctx = makeCtx();
    await handleTextReply(ctx, 'add chipotle 25');
    expect(allText(ctx)).not.toContain('of $');
  });
});
