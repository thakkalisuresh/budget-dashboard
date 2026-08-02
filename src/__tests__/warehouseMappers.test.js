import { describe, it, expect } from 'vitest';
import {
  toCents, normalizeCategory, normalizeVendor, idempotencyKey, centsFromUUID,
  parseBudgetCell, mapTransactionEvent, mapBudgetEvent, mapMonthDim,
  prepareBatches, UUID_SHAPE,
} from '../../functions/lib/_warehouse.mjs';
import {
  TABLES, IDEMPOTENCY_FIELDS, encodeRow, encodeDate, encodeTimestamp,
  validateRow, setupDDL, viewDefinitions, BUDGET_DERIVATIONS, ROW_STATES,
} from '../../functions/lib/_warehouse-schema.mjs';

const CTX = { ingestId: 'ing-1', validFrom: '2026-06-10T17:30:00.000Z', ingestSource: 'hook' };

describe('money is integer cents, always', () => {
  it('converts without float drift', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(41.25)).toBe(4125);
    expect(toCents(1234.56)).toBe(123456);
  });

  it('accepts the formatted strings that arrive from Sheets and wallet payloads', () => {
    expect(toCents('$1,234.56')).toBe(123456);
    expect(toCents(' 12.50 ')).toBe(1250);
  });

  it('returns null for junk rather than a plausible zero', () => {
    // A silent 0 is a wrong number that passes every type check. null is
    // visibly absent, and the REQUIRED-column guard catches it downstream.
    expect(toCents('abc')).toBeNull();
    expect(toCents(null)).toBeNull();
    expect(toCents('')).toBeNull();
    expect(toCents(undefined)).toBeNull();
  });
});

describe('category normalization', () => {
  it("maps the deliberately misspelled 'Utilties' alias onto the Utilities tab", () => {
    // src/sheetHelpers.js keeps this alias on purpose; the backend SHEET_MAP has
    // no such entry. Without normalizing you get two warehouse categories for
    // one budget line, and every per-category gate fails for a reason that
    // looks like a data problem.
    expect(normalizeCategory('Utilties')).toBe('Utilities');
    expect(normalizeCategory('Utilities')).toBe('Utilities');
  });

  it('normalizes Wi-Fi spellings', () => {
    expect(normalizeCategory('wifi')).toBe('Wi-Fi');
    expect(normalizeCategory('Wi-Fi')).toBe('Wi-Fi');
  });

  it('passes an unknown category through rather than dropping it', () => {
    expect(normalizeCategory('Pets')).toBe('Pets');
    expect(normalizeCategory('  Grocery ')).toBe('Grocery');
  });

  it('returns null for nothing', () => {
    expect(normalizeCategory('')).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
  });
});

describe('vendor normalization', () => {
  it('flattens the cosmetic differences between how each channel spells a shop', () => {
    expect(normalizeVendor("Trader Joe's #182")).toBe('trader joe s 182');
    expect(normalizeVendor('  AMAZON.COM*A1B2  ')).toBe('amazon com a1b2');
  });
});

describe('uuid helpers', () => {
  it('reads the cents baked into the uuid at mint time', () => {
    expect(centsFromUUID('tx_4125_a1b2c3d4')).toBe(4125);
    expect(centsFromUUID('tx_0_00000000')).toBe(0);
  });

  it('returns null for anything that is not the minted shape', () => {
    expect(centsFromUUID('tx_abc_a1b2c3d4')).toBeNull();
    expect(centsFromUUID('')).toBeNull();
    expect(centsFromUUID(null)).toBeNull();
  });

  it('UUID_SHAPE matches the generator and rejects near-misses', () => {
    expect(UUID_SHAPE.test('tx_4125_a1b2c3d4')).toBe(true);
    expect(UUID_SHAPE.test('tx_4125_A1B2C3D4')).toBe(false);   // uppercase hex
    expect(UUID_SHAPE.test('tx_4125_a1b2c3d')).toBe(false);    // 7 chars
  });
});

describe('idempotency key', () => {
  const base = () => ({
    spreadsheet_id: 'SHEET', event_type: 'transaction_write', uuid: 'tx_100_aaaaaaaa',
    budget_date: '2026-06-01', category: 'Grocery', vendor_normalized: 'safeway',
    amount_cents: 100, payment_method: 'Amex', booking_method: '', row_state: 'valid',
  });

  it('is stable for identical mirrored fields', () => {
    expect(idempotencyKey(base())).toBe(idempotencyKey(base()));
  });

  it('changes when ANY mirrored field changes', () => {
    for (const field of IDEMPOTENCY_FIELDS) {
      const mutated = { ...base(), [field]: 'MUTATED' };
      expect(idempotencyKey(mutated), `${field} must affect the key`).not.toBe(idempotencyKey(base()));
    }
  });

  it('does NOT change when a derived field changes', () => {
    // This is the rule the whole design rests on. Put llm_model in the key and
    // a Groq version bump mints a spurious new version of every transaction —
    // exactly the history rewrite the archive exists to prevent.
    const withDerived = {
      ...base(),
      llm_model: 'llama-3.3-70b', llm_confidence: 0.91, card_owner: 'Sabarish',
      fx_rate: 1.0, dup_suspect: true, ingest_source: 'notify', actor_email: 'a@b.c',
      valid_from: '2026-06-10T00:00:00Z', ingest_id: 'whatever',
    };
    expect(idempotencyKey(withDerived)).toBe(idempotencyKey(base()));
  });

  it('distinguishes a write from a delete of the same row', () => {
    const del = { ...base(), event_type: 'transaction_delete', row_state: 'deleted' };
    expect(idempotencyKey(del)).not.toBe(idempotencyKey(base()));
  });

  it('cannot be collided by moving a separator between fields', () => {
    // Joined with \0 rather than a printable character, so "a|b" + "c" and
    // "a" + "b|c" cannot hash the same.
    const a = { ...base(), vendor_normalized: 'ab', payment_method: 'c' };
    const b = { ...base(), vendor_normalized: 'a', payment_method: 'bc' };
    expect(idempotencyKey(a)).not.toBe(idempotencyKey(b));
  });
});

describe('parseBudgetCell', () => {
  it('reads the literal out of the formula — the authoritative case', () => {
    // The budget number exists ONLY inside this string. Reading col C at
    // UNFORMATTED_VALUE gives the evaluated remainder and loses it entirely.
    expect(parseBudgetCell('=1200-B4')).toEqual({
      budgetCents: 120000, derivation: 'formula_literal', formulaRaw: '=1200-B4',
    });
    expect(parseBudgetCell('= 80.5 - B7 ').budgetCents).toBe(8050);
  });

  it('flags a bare number as raw_number — the NewMonthDialog bug', () => {
    // remaining stops shrinking, so the derived budget GROWS as you spend.
    // Recorded so the month can be flagged, never trusted.
    expect(parseBudgetCell('1200')).toEqual({
      budgetCents: 120000, derivation: 'raw_number', formulaRaw: '1200',
    });
  });

  it('falls back to spent + remaining when there is no formula to read', () => {
    expect(parseBudgetCell('', { spentCents: 4125, remainingCents: 75875 })).toEqual({
      budgetCents: 80000, derivation: 'spent_plus_remaining', formulaRaw: null,
    });
  });

  it('returns nulls rather than guessing when it has nothing to work with', () => {
    expect(parseBudgetCell('=SUMIF(A:A,"x",B:B)')).toEqual({
      budgetCents: null, derivation: null, formulaRaw: '=SUMIF(A:A,"x",B:B)',
    });
  });

  it('every derivation it can emit is a declared one', () => {
    for (const raw of ['=1200-B4', '1200', '']) {
      const { derivation } = parseBudgetCell(raw, { spentCents: 1, remainingCents: 1 });
      expect(BUDGET_DERIVATIONS).toContain(derivation);
    }
  });
});

describe('mapTransactionEvent', () => {
  const event = () => ({
    spreadsheetId: 'SHEET_JUN', budgetMonth: 'June 2026', category: 'Grocery',
    uuid: 'tx_4125_a1b2c3d4', budgetDate: '2026-06-03', vendor: 'Safeway',
    amount: 41.25, paymentMethod: 'Amex Gold', sheetRowIndex: 7, channel: 'web',
  });

  it('derives month_start from the budget month', () => {
    expect(mapTransactionEvent(event(), CTX).month_start).toBe('2026-06-01');
  });

  it('falls back to the transaction date when no month name was supplied', () => {
    const row = mapTransactionEvent({ ...event(), budgetMonth: null }, CTX);
    expect(row.budget_month).toBe('June 2026');
    expect(row.month_start).toBe('2026-06-01');
  });

  it('uses the SERVER clock for valid_from and keeps the client clock separate', () => {
    // A phone five minutes fast would otherwise look like the newest version of
    // a transaction someone else edited afterwards, and "current state" would
    // be wrong in a way no query could detect.
    const row = mapTransactionEvent(
      { ...event(), clientReportedAt: '2030-01-01T00:00:00.000Z' },
      CTX,
    );
    expect(row.valid_from).toBe(CTX.validFrom);
    expect(row.client_reported_at).toBe('2030-01-01T00:00:00.000Z');
  });

  it('converts the amount to integer cents', () => {
    expect(mapTransactionEvent(event(), CTX).amount_cents).toBe(4125);
  });

  it('flags an amount/uuid mismatch without refusing the row', () => {
    const row = mapTransactionEvent({ ...event(), amount: 42 }, CTX);
    expect(row.amount_cents).toBe(4200);
    expect(row.amount_uuid_mismatch).toBe(true);
  });

  it('leaves the mismatch flag null when there is nothing to compare', () => {
    expect(mapTransactionEvent({ ...event(), uuid: null }, CTX).amount_uuid_mismatch).toBeNull();
  });

  it('defaults transaction_key to the uuid, so uuid-preserving paths get lineage free', () => {
    // moveTransactionCategory, updatePaymentMethod and friends keep the uuid,
    // so the lineage is intact with nobody declaring anything.
    expect(mapTransactionEvent(event(), CTX).transaction_key).toBe('tx_4125_a1b2c3d4');
  });

  it('honours an EXPLICITLY declared prior key — lineage is never inferred', () => {
    const row = mapTransactionEvent(
      { ...event(), uuid: 'tx_4125_ffffffff', priorUuid: 'tx_4125_a1b2c3d4', priorTransactionKey: 'tx_4125_a1b2c3d4' },
      CTX,
    );
    expect(row.transaction_key).toBe('tx_4125_a1b2c3d4');
    expect(row.prior_uuid).toBe('tx_4125_a1b2c3d4');
  });

  it('defaults date_precision to day and row_state to valid', () => {
    const row = mapTransactionEvent(event(), CTX);
    expect(row.date_precision).toBe('day');
    expect(row.row_state).toBe('valid');
    expect(ROW_STATES).toContain(row.row_state);
  });

  it('normalizes the category to the tab name', () => {
    expect(mapTransactionEvent({ ...event(), category: 'Utilties' }, CTX).category).toBe('Utilities');
  });

  it('never carries a valid_to column — that would require an UPDATE later', () => {
    expect(mapTransactionEvent(event(), CTX)).not.toHaveProperty('valid_to');
  });

  it('produces a row that satisfies the table contract', () => {
    expect(validateRow(TABLES.transaction_versions, mapTransactionEvent(event(), CTX))).toEqual([]);
  });
});

describe('a deletion must never be dropped for want of a month', () => {
  // month_start is a REQUIRED column, so an unresolvable month makes the row
  // fail validation and vanish — losing exactly the fact the archive exists to
  // keep, since deleteDimension leaves no trace in the sheet either.
  const del = (over) => mapTransactionEvent(
    { spreadsheetId: 'S', category: 'Grocery', uuid: 'tx_4125_a1b2c3d4', rowState: 'deleted', ...over },
    CTX,
  );

  it('validates when the month name is supplied', () => {
    expect(validateRow(TABLES.transaction_versions, del({ budgetMonth: 'June 2026' }))).toEqual([]);
  });

  it('recovers the month from the transaction date alone', () => {
    const row = del({ budgetDate: '2026-06-03' });
    expect(row.month_start).toBe('2026-06-01');
    expect(validateRow(TABLES.transaction_versions, row)).toEqual([]);
  });

  it('is REJECTED, loudly, when neither is available — never written half-formed', () => {
    // Rejection is the correct outcome here, not a silent default month: the
    // caller gets WHS-003 and the reconciler re-derives the deletion from the
    // sheet. Guessing a partition would bury the row somewhere plausible.
    expect(validateRow(TABLES.transaction_versions, del({})))
      .toContain('month_start is required');
  });
});

describe('mapBudgetEvent', () => {
  it('parses the formula and lands on formula_literal', () => {
    const row = mapBudgetEvent(
      { spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery', formulaRaw: '=600-B2', totalsRowNum: 2 },
      CTX,
    );
    expect(row.budget_cents).toBe(60000);
    expect(row.derivation).toBe('formula_literal');
    expect(row.month_start).toBe('2026-06-01');
    expect(validateRow(TABLES.budget_versions, row)).toEqual([]);
  });

  it('keeps __salary__ as a reserved category rather than normalizing it', () => {
    const row = mapBudgetEvent(
      { spreadsheetId: 'S', budgetMonth: 'June 2026', category: '__salary__', budgetCents: 500000, derivation: 'salary_literal' },
      CTX,
    );
    expect(row.category).toBe('__salary__');
    expect(row.derivation).toBe('salary_literal');
  });
});

describe('mapMonthDim', () => {
  it('records the spreadsheet id against the month, so a rotated id stays resolvable', () => {
    const row = mapMonthDim({ budgetMonth: 'June 2026', spreadsheetId: 'S1', schemaVersion: 'v2' }, CTX);
    expect(row).toMatchObject({ budget_month: 'June 2026', month_start: '2026-06-01', spreadsheet_id: 'S1' });
    expect(validateRow(TABLES.month_dim, row)).toEqual([]);
  });
});

describe('encoding for the Storage Write API', () => {
  it('encodes DATE as days since epoch', () => {
    // Passing an ISO string does not throw — it writes a wrong instant, which
    // in an append-only store cannot be corrected. Hence the table-driven
    // encoder and this test.
    expect(encodeDate('1970-01-01')).toBe(0);
    expect(encodeDate('2026-06-01')).toBe(Math.floor(Date.UTC(2026, 5, 1) / 86400000));
    expect(encodeDate('2026-06-01T12:00:00Z')).toBe(encodeDate('2026-06-01'));
  });

  it('encodes TIMESTAMP as epoch MICROseconds', () => {
    expect(encodeTimestamp('1970-01-01T00:00:01.000Z')).toBe(1_000_000);
    expect(encodeTimestamp(new Date(1_700_000_000_000))).toBe(1_700_000_000_000_000);
  });

  it('returns null for unparseable dates instead of an epoch-adjacent guess', () => {
    expect(encodeDate('not a date')).toBeNull();
    expect(encodeTimestamp('nonsense')).toBeNull();
  });

  it('encodes each column by its declared type and drops unknown keys', () => {
    // A stray field is rejected by the writer and takes the whole batch with it.
    const encoded = encodeRow(TABLES.transaction_versions, {
      ingest_id: 'i', idempotency_key: 'k', valid_from: '2026-06-10T00:00:00.000Z',
      row_state: 'valid', spreadsheet_id: 'S', month_start: '2026-06-01',
      amount_cents: 4125.7, llm_confidence: '0.91', dup_suspect: 1,
      totally_made_up: 'x',
    });
    expect(encoded.month_start).toBe(encodeDate('2026-06-01'));
    expect(encoded.valid_from).toBe(encodeTimestamp('2026-06-10T00:00:00.000Z'));
    expect(encoded.amount_cents).toBe(4125);      // INT64 truncates
    expect(encoded.llm_confidence).toBe(0.91);
    expect(encoded.dup_suspect).toBe(true);
    expect(encoded).not.toHaveProperty('totally_made_up');
  });
});

describe('row validation', () => {
  it('names every missing REQUIRED column', () => {
    const problems = validateRow(TABLES.transaction_versions, { ingest_id: 'i' });
    expect(problems).toContain('idempotency_key is required');
    expect(problems).toContain('valid_from is required');
    expect(problems).toContain('month_start is required');
  });

  it('rejects a column the table does not have', () => {
    expect(validateRow(TABLES.month_dim, {
      budget_month: 'June 2026', month_start: '2026-06-01', spreadsheet_id: 'S',
      captured_at: '2026-06-01T00:00:00Z', surprise: 1,
    })).toEqual(['unknown column surprise']);
  });
});

describe('prepareBatches', () => {
  it('groups by table and rejects the bad rows without losing the good ones', () => {
    const good = mapTransactionEvent({
      spreadsheetId: 'S', budgetMonth: 'June 2026', category: 'Grocery',
      uuid: 'tx_100_aaaaaaaa', amount: 1,
    }, CTX);
    const { batches, rejected } = prepareBatches([
      { table: 'transaction_versions', row: good },
      { table: 'transaction_versions', row: { ingest_id: 'x' } },   // missing REQUIREDs
      { table: 'no_such_table', row: {} },
    ]);
    expect(batches.get('transaction_versions')).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    expect(rejected[1].problems[0]).toContain('unknown table');
  });
});

describe('schema DDL', () => {
  const ddl = setupDDL('proj').join('\n');

  it('creates both datasets with NO default expiration', () => {
    // Either expiration setting silently deletes the archive on a timer, with
    // no error anywhere. They must be absent from the DDL, not set to zero.
    expect(ddl).toContain('CREATE SCHEMA IF NOT EXISTS `proj.fundient_warehouse`');
    expect(ddl).toContain('CREATE SCHEMA IF NOT EXISTS `proj.fundient_staging`');
    expect(ddl).not.toMatch(/default_table_expiration/i);
    expect(ddl).not.toMatch(/default_partition_expiration/i);
  });

  it('partitions and clusters the fact tables', () => {
    expect(ddl).toContain('PARTITION BY month_start');
    expect(ddl).toContain('CLUSTER BY row_state, category, transaction_key');
  });

  it('stages into the separate staging dataset, never the archive', () => {
    // The archive dataset must never need to grant delete rights; the backfill
    // truncates staging tables and must not be able to truncate the archive.
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS `proj\.fundient_staging\.transaction_versions`/);
    expect(ddl).toMatch(/CREATE TABLE IF NOT EXISTS `proj\.fundient_staging\.budget_versions`/);
  });

  it('declares no valid_to column anywhere', () => {
    expect(ddl).not.toMatch(/^\s+valid_to /m);
  });
});

describe('views', () => {
  const views = Object.fromEntries(viewDefinitions('proj').map(v => [v.name, v.sql]));

  it('derives valid_to with LEAD rather than storing it', () => {
    expect(views.v_transaction_versions).toContain('LEAD(valid_from)');
  });

  it('dedupes duplicate DELIVERIES at read time, on idempotency_key', () => {
    expect(views.v_transaction_versions).toContain('PARTITION BY idempotency_key');
    expect(views.v_transaction_versions).toContain('ROW_NUMBER()');
  });

  it('keeps deletions in the "current" view — a deletion IS the current state', () => {
    expect(views.v_transaction_current).not.toContain("row_state");
    expect(views.v_transaction_current).toContain('valid_to IS NULL');
  });

  it('excludes only `erroneous` from the analytics surface', () => {
    expect(views.v_transactions).toContain("row_state != 'erroneous'");
  });

  it('never uses MERGE, UPDATE or DELETE', () => {
    for (const [name, sql] of Object.entries(views)) {
      expect(sql, `${name} must be read-only`).not.toMatch(/\b(MERGE|UPDATE|DELETE)\b/);
    }
  });
});
