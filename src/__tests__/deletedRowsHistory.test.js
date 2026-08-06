// Deleted expenses must stop showing up in getRecentExpenses.
//
// History is append-only and a delete used to leave no trace carrying the uuid,
// so the original row stayed the newest entry for that expense forever. The row
// was gone from its category tab but still visible to everything that reads
// History: duplicate detection, vendor history, card inference.
//
// Concretely: delete a mis-logged $50 Costco, re-add it correctly, and the bot
// warned "Possible duplicate" against the row you had just deleted.
//
// This only became reachable once duplicate detection started working at all —
// before the Sheets-serial date fix it matched nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'template-id');
vi.stubEnv('ALLOWED_EMAILS', 'nair.sabarish97@gmail.com');

vi.mock('../../functions/lib/_drive.mjs', () => ({
  getAccessToken: async () => 'test-token',
  copyFile: vi.fn(),
  shareWithEmails: vi.fn(),
}));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const { getRecentExpenses, deleteExpenseByUUID, DELETED_ACTION } =
  await import('../../functions/lib/_sheets.mjs');

const ok = (payload) => ({ ok: true, json: () => Promise.resolve(payload) });

/** One History row in the bot layout: uuid@6, txDate@9. */
const hist = (action, category, vendor, amount, uuid, txDate) =>
  [new Date().toISOString(), action, category, vendor, amount, 'details', uuid, 'telegram-bot', '', txDate];

const HEADER = ['Timestamp', 'Action', 'Category', 'Vendor', 'Amount', 'Details', 'UUID', 'User', '', 'TxDate'];

function historyReturns(rows) {
  mockFetch.mockImplementation((url) => {
    if (String(url).includes('History')) return Promise.resolve(ok({ values: [HEADER, ...rows] }));
    return Promise.resolve(ok({ values: [] }));
  });
}

beforeEach(() => { mockFetch.mockReset(); });

describe('getRecentExpenses and deleted rows', () => {
  it('drops an expense whose newest History entry is a delete', async () => {
    historyReturns([
      hist('Telegram Receipt', 'Health', 'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
      hist(DELETED_ACTION,     'Health', 'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
    ]);

    const rows = await getRecentExpenses('sheet-1', 50);
    expect(rows).toHaveLength(0);
  });

  it('keeps expenses that were never deleted', async () => {
    historyReturns([
      hist('Telegram Receipt', 'Health',  'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
      hist('Telegram Receipt', 'Grocery', 'Safeway',  25.34, 'tx_2534_bbb', '2026-08-03'),
      hist(DELETED_ACTION,     'Health',  'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
    ]);

    const rows = await getRecentExpenses('sheet-1', 50);
    expect(rows.map(r => r.vendor)).toEqual(['Safeway']);
  });

  it('does not let an older entry resurrect a deleted expense', async () => {
    // An edit rewrites the same uuid, so a deleted expense can have several
    // earlier entries. The uuid is claimed on its NEWEST entry, which is the
    // delete — the earlier ones must not put it back.
    historyReturns([
      hist('Telegram Receipt', 'Misc',   'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
      hist('Edited',           'Health', 'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
      hist(DELETED_ACTION,     'Health', 'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
    ]);

    const rows = await getRecentExpenses('sheet-1', 50);
    expect(rows).toHaveLength(0);
  });

  it('keeps a delete marker that carries no amount', async () => {
    // The marker is written even when the row could not be re-read first, so it
    // may have amount 0 — it must still survive the "real expense" filter, or
    // the delete goes unrecorded and the expense comes back.
    historyReturns([
      hist('Telegram Receipt', 'Health', 'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
      hist(DELETED_ACTION,     'Health', '',          0,    'tx_123_aaa', ''),
    ]);

    const rows = await getRecentExpenses('sheet-1', 50);
    expect(rows).toHaveLength(0);
  });

  it('still ignores admin actions, which carry no uuid', async () => {
    historyReturns([
      hist('Budget Changed', 'Health', '', 60, '', ''),
      hist('Telegram Receipt', 'Health', 'Walgreens', 1.23, 'tx_123_aaa', '2026-08-05'),
    ]);

    const rows = await getRecentExpenses('sheet-1', 50);
    expect(rows.map(r => r.vendor)).toEqual(['Walgreens']);
  });
});

describe('deleteExpenseByUUID writes the marker', () => {
  it('appends a Deleted History row carrying the uuid', async () => {
    const appended = [];
    mockFetch.mockImplementation((url, opts) => {
      const u = String(url);
      if (u.includes('History') && u.includes(':append')) {
        appended.push(JSON.parse(opts.body).values[0]);
        return Promise.resolve(ok({}));
      }
      if (u.includes('fields=sheets.properties')) {
        return Promise.resolve(ok({ sheets: [{ properties: { title: 'Health', sheetId: 7 } }] }));
      }
      if (u.includes(':batchUpdate')) return Promise.resolve(ok({}));
      // findRowByUUID scans F:H, so it sees only those three columns.
      if (u.includes('F%3AH')) {
        return Promise.resolve(ok({ values: [
          ['Card', 'UUID', ''],                  // header
          ['', 'tx_123_aaa', ''],                // the row to delete → index 1
        ] }));
      }
      // The pre-delete read of that row, A:H.
      if (u.includes('A2%3AH2')) {
        return Promise.resolve(ok({ values: [
          ['Aug', 2026, '2026-08-05', 'Walgreens', 1.23, '', 'tx_123_aaa'],
        ] }));
      }
      return Promise.resolve(ok({ values: [] }));
    });

    await deleteExpenseByUUID({ category: 'Health', uuid: 'tx_123_aaa', sheetId: 'sheet-1' });

    expect(appended).toHaveLength(1);
    const [row] = appended;
    expect(row[1]).toBe(DELETED_ACTION);
    expect(row[6]).toBe('tx_123_aaa');     // uuid where getRecentExpenses reads it
    expect(row[3]).toBe('Walgreens');      // carries what was removed
    expect(row[4]).toBe(1.23);
  });
});
