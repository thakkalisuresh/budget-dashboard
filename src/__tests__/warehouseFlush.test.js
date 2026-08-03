import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The failure path, end to end: a write that fails lands in the outbox, drains
 * on the next tick, and dead-letters when it has had enough.
 *
 * This is the half nobody exercises by using the app, and the half that decides
 * whether "the archive is behind" is something you find out about.
 */

const { appendRows, docs, ctl } = vi.hoisted(() => ({
  appendRows: vi.fn(),
  docs: [],
  ctl: { readFails: false, batchFails: false },
}));

vi.mock('../../functions/lib/_warehouse-client.mjs', () => ({
  appendRows: (...a) => appendRows(...a),
  projectId: () => 'test-project',
  runQuery: vi.fn(),
  runStatement: vi.fn(),
  datasetMetadata: vi.fn(),
}));

const reported = [];
vi.mock('../../functions/lib/_error-log.mjs', () => ({
  reportError: async (code, err, ctx) => { reported.push({ code, message: err?.message, ctx }); },
}));

/** A Firestore stand-in with just the surface the outbox uses. */
function makeDoc(data) {
  const doc = {
    id: `doc-${docs.length}`,
    data: () => doc._data,
    _data: data,
    _deleted: false,
    ref: {
      delete: async () => { doc._deleted = true; },
      update: async (patch) => { Object.assign(doc._data, patch); },
    },
  };
  return doc;
}

vi.mock('../../functions/lib/firestore.mjs', () => ({
  getDb: () => ({
    batch: () => {
      const writes = [];
      return {
        set: (ref, value) => writes.push({ ref, value }),
        commit: async () => {
          if (ctl.batchFails) throw new Error('firestore down');
          for (const w of writes) docs.push(makeDoc(w.value));
        },
      };
    },
    collection: () => ({
      doc: () => ({}),
      where: () => ({
        limit: () => ({
          get: async () => {
            if (ctl.readFails) throw new Error('firestore read down');
            const live = docs.filter(d => !d._data.dead && !d._deleted);
            return { empty: live.length === 0, docs: live };
          },
        }),
      }),
    }),
  }),
}));

const wh = await import('../../functions/lib/_warehouse.mjs');
const { drainOutbox } = await import('../../functions/lib/_warehouse-drain.mjs');
const { MAX_OUTBOX_ATTEMPTS, OUTBOX_COLLECTION } = wh;

const CTX = { ingestId: 'i', validFrom: '2026-06-10T00:00:00.000Z' };
const goodRow = () => ({
  table: 'transaction_versions',
  row: wh.mapTransactionEvent({
    spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery',
    uuid: 'tx_4125_a1b2c3d4', budgetDate: '2026-06-01', vendor: 'Safeway', amount: 41.25,
  }, CTX),
});

beforeEach(() => {
  appendRows.mockReset().mockResolvedValue({ appended: 1 });
  docs.length = 0;
  reported.length = 0;
  ctl.readFails = false;
  ctl.batchFails = false;
  vi.stubEnv('WAREHOUSE_ENABLED', 'true');
});

describe('the master switch', () => {
  it('is off by default, so all of this deploys before the dataset exists', async () => {
    vi.stubEnv('WAREHOUSE_ENABLED', '');
    expect(wh.warehouseEnabled()).toBe(false);
    const res = await wh.flushRows([goodRow()]);
    expect(appendRows).not.toHaveBeenCalled();
    expect(res).toEqual({ written: 0, queued: 0, rejected: 0 });
  });

  it('only "true" counts — not "1", not "yes"', () => {
    for (const v of ['1', 'yes', 'false', 'on', '']) {
      vi.stubEnv('WAREHOUSE_ENABLED', v);
      expect(wh.warehouseEnabled(), JSON.stringify(v)).toBe(false);
    }
  });

  it('tolerates the stray whitespace a pasted secret value picks up', () => {
    // A trailing newline in Secret Manager would otherwise disable the entire
    // archive, silently, with nothing to see anywhere.
    for (const v of ['true', ' true', 'true\n', 'TRUE']) {
      vi.stubEnv('WAREHOUSE_ENABLED', v);
      expect(wh.warehouseEnabled(), JSON.stringify(v)).toBe(true);
    }
  });
});

describe('flushRows — the happy path', () => {
  it('writes through the Storage Write API and queues nothing', async () => {
    const res = await wh.flushRows([goodRow()]);
    expect(res).toEqual({ written: 1, queued: 0, rejected: 0 });
    expect(appendRows).toHaveBeenCalledOnce();
    const [dataset, table, rows] = appendRows.mock.calls[0];
    expect(dataset).toBe('fundient_warehouse');
    expect(table).toBe('transaction_versions');
    // Encoded, not raw: DATE as days since epoch, TIMESTAMP as micros.
    expect(typeof rows[0].month_start).toBe('number');
    expect(typeof rows[0].valid_from).toBe('number');
    expect(docs).toHaveLength(0);
  });

  it('groups a mixed batch into one append per table', async () => {
    await wh.flushRows([
      goodRow(),
      goodRow(),
      { table: 'budget_versions', row: wh.mapBudgetEvent({
        spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery', formulaRaw: '=600-B2',
      }, CTX) },
    ]);
    expect(appendRows).toHaveBeenCalledTimes(2);
    expect(appendRows.mock.calls.find(c => c[1] === 'transaction_versions')[2]).toHaveLength(2);
  });
});

describe('flushRows — when BigQuery is unreachable', () => {
  it('queues the rows and reports WHS-001 rather than losing them', async () => {
    appendRows.mockRejectedValue(new Error('DEADLINE_EXCEEDED'));
    const res = await wh.flushRows([goodRow()]);

    expect(res).toMatchObject({ written: 0, queued: 1 });
    expect(docs).toHaveLength(1);
    expect(docs[0]._data).toMatchObject({ table: 'transaction_versions', attempts: 0, dead: false });
    expect(reported.map(r => r.code)).toContain('WHS-001');
    // Stored UNENCODED, so a schema change between the failure and the drain
    // cannot make the queued payload unwritable.
    expect(typeof docs[0]._data.rows[0].month_start).toBe('string');
  });

  it('gives up on the hot-path timeout rather than holding the wallet path', async () => {
    appendRows.mockImplementation(() => new Promise(r => setTimeout(r, 5000)));
    const res = await wh.flushRows([goodRow()], { timeoutMs: 20 });
    expect(res.queued).toBe(1);
    expect(reported.find(r => r.code === 'WHS-001').message).toMatch(/exceeded 20ms/);
  });

  it('reports WHS-002 when BOTH BigQuery and the outbox fail', async () => {
    // The one path where a row is genuinely lost. The reconciler is the
    // backstop: it diffs the actual sheet and re-emits on the next pass.
    appendRows.mockRejectedValue(new Error('bq down'));
    ctl.batchFails = true;
    const res = await wh.flushRows([goodRow()]);
    expect(res.queued).toBe(0);
    expect(reported.map(r => r.code)).toContain('WHS-002');
  });
});

describe('flushRows — malformed events', () => {
  it('rejects a bad row, keeps the good ones, and does NOT queue the bad one', async () => {
    // A missing REQUIRED column is a caller bug, not a transient failure —
    // queuing it would just retry the same broken shape eight times.
    const res = await wh.flushRows([goodRow(), { table: 'transaction_versions', row: { ingest_id: 'x' } }]);
    expect(res).toMatchObject({ written: 1, rejected: 1, queued: 0 });
    expect(reported.map(r => r.code)).toContain('WHS-003');
  });
});

describe('the entry points never throw', () => {
  it('a failing write does not surface to the caller', async () => {
    appendRows.mockRejectedValue(new Error('boom'));
    // These run after the user's write has already succeeded. Turning a
    // bookkeeping problem into a failed expense entry would be backwards.
    await expect(wh.recordTransactionWrite({ spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery', uuid: 'tx_1_aaaaaaaa', amount: 1 })).resolves.toBeDefined();
    await expect(wh.recordTransactionDelete({ spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery', uuid: 'tx_1_aaaaaaaa' })).resolves.toBeDefined();
    await expect(wh.recordBudgetWrite({ spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery', formulaRaw: '=1-B2' })).resolves.toBeDefined();
    await expect(wh.recordMonthDim({ budgetMonth: 'June 2026', spreadsheetId: 'S' })).resolves.toBeDefined();
  });

  it('records a delete as a NEW version, never as a removal', async () => {
    await wh.recordTransactionDelete({
      spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery', uuid: 'tx_1_aaaaaaaa',
    });
    expect(appendRows).toHaveBeenCalledOnce();
    // row_state is encoded as a plain string.
    expect(appendRows.mock.calls[0][2][0].row_state).toBe('deleted');
  });
});

describe('drainOutbox', () => {
  const queueOne = async () => {
    appendRows.mockRejectedValueOnce(new Error('transient'));
    await wh.flushRows([goodRow()]);
    appendRows.mockReset().mockResolvedValue({ appended: 1 });
  };

  it('retries a queued entry and removes it once it lands', async () => {
    await queueOne();
    const res = await drainOutbox();
    expect(res).toMatchObject({ drained: 1, rows: 1, dead: 0 });
    expect(docs[0]._deleted).toBe(true);
    // Encoded at DRAIN time, not at enqueue time, so a schema change between
    // the failure and the retry can't make the queued payload unwritable.
    const write = appendRows.mock.calls.find(c => c[1] === 'transaction_versions');
    expect(typeof write[2][0].month_start).toBe('number');
    // …and the attempt is logged as applied.
    expect(appendRows.mock.calls.find(c => c[1] === 'ingest_attempts')[2][0].outcome).toBe('applied');
  });

  it('bumps the attempt count and keeps the entry when the retry also fails', async () => {
    await queueOne();
    appendRows.mockRejectedValue(new Error('still down'));
    const res = await drainOutbox();
    expect(res).toMatchObject({ drained: 0, dead: 0 });
    expect(docs[0]._data.attempts).toBe(1);
    expect(docs[0]._data.lastError).toMatch(/still down/);
  });

  it('dead-letters after MAX_OUTBOX_ATTEMPTS and reports WHS-004', async () => {
    // Retrying forever is not resilience; it is a queue that never empties and
    // a problem nobody hears about.
    await queueOne();
    appendRows.mockRejectedValue(new Error('permanently broken'));
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) await drainOutbox();

    expect(docs[0]._data.dead).toBe(true);
    expect(docs[0]._data.diedAt).toBeTruthy();
    expect(reported.map(r => r.code)).toContain('WHS-004');
    // And a dead entry stops consuming the tick.
    appendRows.mockClear();
    expect(await drainOutbox()).toMatchObject({ drained: 0, dead: 0 });
    expect(appendRows).not.toHaveBeenCalled();
  });

  it('dead-letters an unknown table immediately — a retry cannot fix a schema change', async () => {
    await queueOne();
    docs[0]._data.table = 'table_that_no_longer_exists';
    const res = await drainOutbox();
    expect(res.dead).toBe(1);
    expect(docs[0]._data.dead).toBe(true);
    expect(appendRows).not.toHaveBeenCalled();
  });

  it('is a no-op when the switch is off', async () => {
    vi.stubEnv('WAREHOUSE_ENABLED', '');
    expect(await drainOutbox()).toMatchObject({ reason: 'disabled' });
  });

  it('survives an unreadable outbox without throwing into the scheduler', async () => {
    // A throw inside onSchedule makes Cloud Scheduler retry the whole tick,
    // including the reconciler — the expensive half.
    ctl.readFails = true;
    await expect(drainOutbox()).resolves.toMatchObject({ reason: 'read_failed' });
  });

  it('names the collection the docs say it does', () => {
    expect(OUTBOX_COLLECTION).toBe('warehouse_outbox');
  });
});

describe('config snapshots', () => {
  beforeEach(() => { wh.__resetConfigSnapshots(); });

  it('hashes over a canonical rendering, so key order cannot mint a new snapshot', () => {
    // Settings objects are assembled differently on different paths, and JS
    // object key order is insertion order.
    expect(wh.configHash({ a: 1, b: 2 })).toBe(wh.configHash({ b: 2, a: 1 }));
    expect(wh.configHash({ a: 1 })).not.toBe(wh.configHash({ a: 2 }));
  });

  it('writes a snapshot once per distinct config, not once per transaction', async () => {
    const map = { 'Bilt Blue Card': 'wife' };
    const h1 = await wh.snapshotConfig('card_owners', map);
    const h2 = await wh.snapshotConfig('card_owners', { 'Bilt Blue Card': 'wife' });
    expect(h1).toBe(h2);
    expect(appendRows).toHaveBeenCalledOnce();
  });

  it('writes a new snapshot when the config actually changes', async () => {
    await wh.snapshotConfig('card_owners', { 'Bilt Blue Card': 'wife' });
    await wh.snapshotConfig('card_owners', { 'Bilt Blue Card': 'me' });
    expect(appendRows).toHaveBeenCalledTimes(2);
  });

  it('still returns the hash when the snapshot write fails', async () => {
    // The hash is correct either way; the row it points at just isn't there
    // yet, and the next changed write re-adds it.
    appendRows.mockRejectedValue(new Error('bq down'));
    await expect(wh.snapshotConfig('card_owners', { a: 'me' })).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});
