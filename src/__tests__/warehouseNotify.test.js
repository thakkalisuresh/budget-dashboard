import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../functions/lib/secrets.mjs', () => ({
  SHEETS_DRIVE_SECRETS: [], WAREHOUSE_SECRETS: [],
}));

const { buildRows, MAX_EVENTS_PER_REQUEST, RATE_LIMIT_PER_HOUR } =
  await import('../../functions/warehouse-notify.mjs');
const {
  notifyWarehouse, transactionWriteEvent, transactionDeleteEvent, budgetWriteEvent, MAX_BATCH,
} = await import('../warehouseNotify.js');

const MONTHS = { 'SHEET_JUN': { monthName: 'June 2026', sheetId: 'SHEET_JUN' } };
const monthFor = (id) => MONTHS[id] || null;
const RECEIVED = '2026-06-10T17:30:00.000Z';
const build = (events) => buildRows(events, { actorEmail: 'me@example.com', receivedAt: RECEIVED, monthFor });

describe('warehouse-notify — what it accepts', () => {
  it('maps a transaction write into a transaction_versions row', () => {
    const { rows, rejected } = build([{
      eventType: 'transaction_write', spreadsheetId: 'SHEET_JUN', category: 'Grocery',
      uuid: 'tx_4125_a1b2c3d4', budgetDate: '2026-06-03', vendor: 'Safeway', amount: 41.25,
      paymentMethod: 'Amex Gold', sourceAction: 'addOrUpdateExpense',
    }]);
    expect(rejected).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].table).toBe('transaction_versions');
    expect(rows[0].row).toMatchObject({
      row_state: 'valid', amount_cents: 4125, category: 'Grocery',
      ingest_source: 'notify', channel: 'web',
    });
  });

  it('maps a delete into a NEW version with row_state deleted, never a removal', () => {
    const { rows } = build([{
      eventType: 'transaction_delete', spreadsheetId: 'SHEET_JUN',
      category: 'Grocery', uuid: 'tx_4125_a1b2c3d4',
    }]);
    expect(rows[0].row.row_state).toBe('deleted');
    expect(rows[0].row.state_reason).toBe('deleted_in_sheet');
  });

  it('maps a budget write, keeping the formula so the literal survives', () => {
    const { rows } = build([{
      eventType: 'budget_write', spreadsheetId: 'SHEET_JUN',
      category: 'Grocery', formulaRaw: '=600-B2', totalsRowNum: 2,
    }]);
    expect(rows[0].table).toBe('budget_versions');
    expect(rows[0].row).toMatchObject({ budget_cents: 60000, derivation: 'formula_literal' });
  });
});

describe('warehouse-notify — what it refuses', () => {
  it('refuses a spreadsheet id that is not in the month registry', () => {
    // A client can assert anything. Validating against the registry is what
    // keeps the blast radius to "warehouse pollution the reconciler retracts".
    const { rows, rejected } = build([{ eventType: 'transaction_write', spreadsheetId: 'SOMEONE_ELSES' }]);
    expect(rows).toEqual([]);
    expect(rejected).toEqual([{ reason: 'unknown_spreadsheet', spreadsheetId: 'SOMEONE_ELSES' }]);
  });

  it('refuses an event with no spreadsheet id at all', () => {
    const { rejected } = build([{ eventType: 'transaction_write' }]);
    expect(rejected[0]).toMatchObject({ reason: 'unknown_spreadsheet' });
  });

  it('refuses an unknown event type rather than guessing at it', () => {
    const { rows, rejected } = build([{ eventType: 'drop_table', spreadsheetId: 'SHEET_JUN' }]);
    expect(rows).toEqual([]);
    expect(rejected[0]).toMatchObject({ reason: 'unknown_event_type', eventType: 'drop_table' });
  });

  it('keeps the good events in a batch that also contains bad ones', () => {
    const { rows, rejected } = build([
      { eventType: 'transaction_write', spreadsheetId: 'SHEET_JUN', category: 'Grocery', uuid: 'tx_100_aaaaaaaa', amount: 1 },
      { eventType: 'nonsense', spreadsheetId: 'SHEET_JUN' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe('warehouse-notify — what it refuses to take from the client', () => {
  it('uses the VERIFIED email, never one claimed in the body', () => {
    const { rows } = buildRows(
      [{
        eventType: 'transaction_write', spreadsheetId: 'SHEET_JUN', category: 'Grocery',
        uuid: 'tx_100_aaaaaaaa', amount: 1,
        actorEmail: 'attacker@evil.test', actor_email: 'attacker@evil.test',
      }],
      { actorEmail: 'me@example.com', receivedAt: RECEIVED, monthFor },
    );
    expect(rows[0].row.actor_email).toBe('me@example.com');
  });

  it('orders versions by the SERVER clock, whatever the phone says', () => {
    // A skewed client clock would otherwise make its write look like the newest
    // version of a transaction someone else edited afterwards — and "current
    // state" would be wrong in a way no query could detect.
    const { rows } = build([{
      eventType: 'transaction_write', spreadsheetId: 'SHEET_JUN', category: 'Grocery',
      uuid: 'tx_100_aaaaaaaa', amount: 1,
      clientReportedAt: '2035-01-01T00:00:00.000Z',
      validFrom: '2035-01-01T00:00:00.000Z',   // even if it tries to set it directly
    }]);
    expect(rows[0].row.valid_from).toBe(RECEIVED);
    expect(rows[0].row.client_reported_at).toBe('2035-01-01T00:00:00.000Z');
  });

  it('takes the month name from the registry, not from the client', () => {
    const { rows } = build([{
      eventType: 'transaction_write', spreadsheetId: 'SHEET_JUN', budgetMonth: 'December 1999',
      category: 'Grocery', uuid: 'tx_100_aaaaaaaa', amount: 1,
    }]);
    expect(rows[0].row.budget_month).toBe('June 2026');
    expect(rows[0].row.month_start).toBe('2026-06-01');
  });

  it('marks everything as client-asserted, so the reconciler can retract it', () => {
    const { rows } = build([{
      eventType: 'transaction_write', spreadsheetId: 'SHEET_JUN', category: 'Grocery',
      uuid: 'tx_100_aaaaaaaa', amount: 1, ingestSource: 'hook',
    }]);
    expect(rows[0].row.ingest_source).toBe('notify');
  });
});

describe('the browser-side sender', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('posts to the endpoint with keepalive, so closing the tab does not cancel it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await notifyWarehouse(transactionWriteEvent({
      spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery',
      uuid: 'tx_100_aaaaaaaa', budgetDate: '2026-06-01', vendor: 'A', amount: 1,
    }), 'token-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/warehouse-notify');
    expect(init.keepalive).toBe(true);
    expect(init.headers.Authorization).toBe('Bearer token-123');
    expect(JSON.parse(init.body).events).toHaveLength(1);
  });

  it('NEVER rejects, whatever the network does', async () => {
    // Every call site is un-awaited. A rejection here would surface as an
    // unhandled rejection and, worse, WEB-002 noise for a successful write.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(notifyWarehouse(
      transactionDeleteEvent({ spreadsheetId: 'S', category: 'Grocery', uuid: 'tx_1_aaaaaaaa' }),
      'tok',
    )).resolves.toBeUndefined();
  });

  it('sends nothing without a token or without events', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await notifyWarehouse([], 'tok');
    await notifyWarehouse(budgetWriteEvent({ spreadsheetId: 'S', category: 'Grocery' }), null);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits a large batch to stay under the endpoint cap', async () => {
    // A statement import writes dozens of rows at once.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const events = Array.from({ length: MAX_BATCH + 5 }, (_, i) =>
      transactionWriteEvent({ spreadsheetId: 'S', category: 'Misc', uuid: `tx_1_0000000${i % 10}`, amount: 1 }));

    await notifyWarehouse(events, 'tok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).events).toHaveLength(MAX_BATCH);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).events).toHaveLength(5);
    expect(MAX_BATCH).toBe(MAX_EVENTS_PER_REQUEST);
  });

  it('drops null events rather than posting them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await notifyWarehouse([null, undefined], 'tok');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the rate limit is sized for real use, not for a round number', () => {
  it('allows far more events per hour than any real session, and far fewer than a runaway', () => {
    expect(RATE_LIMIT_PER_HOUR).toBeGreaterThan(1000);
    expect(RATE_LIMIT_PER_HOUR).toBeLessThan(100_000);
  });
});
