import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression cover for the two bugs Phase 0.5 fixed.
 *
 * Both were silent: neither threw, neither failed a build, and both produced
 * data that looks entirely plausible. In an append-only warehouse that is the
 * expensive kind of bug — the wrong value is recorded permanently and reads
 * back as fact.
 */

const store = {};
vi.stubGlobal('localStorage', {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
});
vi.stubGlobal('navigator', { onLine: true });

const { getQueue, enqueue, clearQueue, updateRetries, MAX_RETRIES } = await import('../offlineQueue.js');
const { drainQueue } = await import('../offlineReplay.js');

beforeEach(() => { clearQueue(); });

/** Positional signature of addOrUpdateExpense, named for readable assertions. */
function argsOf(call) {
  const [categoryName, vendorName, amount, accessToken, sheetId, monthName,
         source, txDate, paymentMethod, bookingMethod, opts] = call;
  return { categoryName, vendorName, amount, accessToken, sheetId, monthName,
           source, txDate, paymentMethod, bookingMethod, opts };
}

describe('offline replay carries every captured field', () => {
  it('replays txDate, paymentMethod and bookingMethod — not just the first five fields', async () => {
    enqueue({
      type: 'add_expense',
      payload: {
        categoryName: 'Travel', vendorName: 'Alaska Air', amount: 412.5,
        monthName: 'June 2026', source: 'manual',
        txDate: '2026-06-03', paymentMethod: 'Amex Gold', bookingMethod: 'Points',
        enteredAt: '2026-06-03T18:04:00.000Z',
      },
    });

    const addExpense = vi.fn().mockResolvedValue({ uuid: 'tx_41250_abcd1234' });
    const res = await drainQueue({
      items: getQueue(), accessToken: 'tok', sheetId: 'SHEET_1', addExpense,
    });

    expect(res).toEqual({ synced: 1, stuck: 0 });
    const a = argsOf(addExpense.mock.calls[0]);
    // The bug: these three arrived as undefined/'' and the row was written with
    // today's date and no card.
    expect(a.txDate).toBe('2026-06-03');
    expect(a.paymentMethod).toBe('Amex Gold');
    expect(a.bookingMethod).toBe('Points');
    // …and the rest still round-trips.
    expect(a.categoryName).toBe('Travel');
    expect(a.vendorName).toBe('Alaska Air');
    expect(a.amount).toBe(412.5);
    expect(a.monthName).toBe('June 2026');
    expect(a.sheetId).toBe('SHEET_1');
  });

  it('passes entered_at so the warehouse can tell "typed then" from "synced now"', async () => {
    enqueue({
      type: 'add_expense',
      payload: {
        categoryName: 'Grocery', vendorName: 'Safeway', amount: 20,
        monthName: 'June 2026', enteredAt: '2026-06-01T09:00:00.000Z',
      },
    });
    const addExpense = vi.fn().mockResolvedValue({});
    await drainQueue({ items: getQueue(), accessToken: 't', sheetId: 's', addExpense });
    expect(argsOf(addExpense.mock.calls[0]).opts.enteredAt).toBe('2026-06-01T09:00:00.000Z');
  });

  it('falls back to queuedAt when the item predates the enteredAt field', async () => {
    const item = {
      id: 'x', type: 'add_expense', retries: 0,
      queuedAt: Date.parse('2026-05-20T12:00:00.000Z'),
      payload: { categoryName: 'Misc', vendorName: 'Old', amount: 1 },
    };
    const addExpense = vi.fn().mockResolvedValue({});
    await drainQueue({ items: [item], accessToken: 't', sheetId: 's', addExpense });
    expect(argsOf(addExpense.mock.calls[0]).opts.enteredAt).toBe('2026-05-20T12:00:00.000Z');
  });

  it('dequeues on success and leaves the item on failure', async () => {
    enqueue({ type: 'add_expense', payload: { categoryName: 'Misc', vendorName: 'A', amount: 1 } });
    const addExpense = vi.fn().mockRejectedValue(new Error('offline again'));
    const res = await drainQueue({ items: getQueue(), accessToken: 't', sheetId: 's', addExpense });
    expect(res.synced).toBe(0);
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0].retries).toBe(1);
  });
});

describe('offline replay gives up rather than duplicating forever', () => {
  it('stops retrying at MAX_RETRIES and reports the item as stuck', async () => {
    enqueue({ type: 'add_expense', payload: { categoryName: 'Misc', vendorName: 'A', amount: 1 } });
    const id = getQueue()[0].id;
    updateRetries(id, MAX_RETRIES);

    const addExpense = vi.fn().mockResolvedValue({});
    const res = await drainQueue({ items: getQueue(), accessToken: 't', sheetId: 's', addExpense });

    // The point of the cap: no further attempt is made at all. Each attempt
    // mints a fresh uuid, so a half-succeeded write duplicates the sheet row
    // every single time it is retried.
    expect(addExpense).not.toHaveBeenCalled();
    expect(res).toEqual({ synced: 0, stuck: 1 });
    // Kept, not dropped — the user is told, and can re-enter it by hand.
    expect(getQueue()).toHaveLength(1);
  });

  it('counts an item as stuck on the attempt that exhausts the budget', async () => {
    enqueue({ type: 'add_expense', payload: { categoryName: 'Misc', vendorName: 'A', amount: 1 } });
    updateRetries(getQueue()[0].id, MAX_RETRIES - 1);
    const addExpense = vi.fn().mockRejectedValue(new Error('nope'));
    const res = await drainQueue({ items: getQueue(), accessToken: 't', sheetId: 's', addExpense });
    expect(addExpense).toHaveBeenCalledTimes(1);
    expect(res.stuck).toBe(1);
  });

  it('ignores queue items that are not expenses', async () => {
    const addExpense = vi.fn();
    const res = await drainQueue({
      items: [{ id: 'q', type: 'something_else', payload: {} }],
      accessToken: 't', sheetId: 's', addExpense,
    });
    expect(addExpense).not.toHaveBeenCalled();
    expect(res).toEqual({ synced: 0, stuck: 0 });
  });
});
