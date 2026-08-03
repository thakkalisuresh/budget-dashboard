import { describe, it, expect } from 'vitest';
import { diffMonth, flattenSnapshot, GRACE_MS } from '../../functions/lib/_warehouse-reconcile.mjs';
import {
  parseV2Row, parseTotals, readMonth, uuidColumnFor, NON_TRANSACTIONAL_TABS,
} from '../../functions/lib/_warehouse-reader.mjs';

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const OLD = new Date(NOW - 60 * 60 * 1000).toISOString();   // an hour ago
const NEW = new Date(NOW - 60 * 1000).toISOString();        // a minute ago

const sheetRow = (over = {}) => ({
  category: 'Grocery', uuid: 'tx_100_aaaaaaaa', amountCents: 100,
  vendor: 'Safeway', budgetDate: '2026-06-01', paymentMethod: '', bookingMethod: '',
  rowIndex: 2, ...over,
});

const whRow = (over = {}) => ({
  uuid: 'tx_100_aaaaaaaa', category: 'Grocery', amount_cents: 100,
  row_state: 'valid', ingest_source: 'hook', valid_from: OLD, ...over,
});

describe('diffMonth — in the sheet, missing from the warehouse', () => {
  it('flags a row the warehouse has never seen as missed_notify', () => {
    // This is the safety net that means no write path can permanently escape
    // the archive: a feature that bypasses both chokepoints is picked up here.
    const res = diffMonth({ sheetRows: [sheetRow()], warehouseRows: [], now: NOW });
    expect(res.missing).toHaveLength(1);
    expect(res.missing[0].stateReason).toBe('missed_notify');
    expect(res.deleted).toEqual([]);
    expect(res.erroneous).toEqual([]);
  });

  it('flags a hand-edited amount as sheet_drift', () => {
    // Editing a cell directly in Google Sheets produces no event anywhere.
    const res = diffMonth({
      sheetRows: [sheetRow({ amountCents: 250 })],
      warehouseRows: [whRow({ amount_cents: 100 })],
      now: NOW,
    });
    expect(res.missing).toHaveLength(1);
    expect(res.missing[0].stateReason).toBe('sheet_drift');
    expect(res.missing[0].amountCents).toBe(250);
  });

  it('flags a hand-moved row as drift, since category is which tab it lives on', () => {
    const res = diffMonth({
      sheetRows: [sheetRow({ category: 'Eating Out' })],
      warehouseRows: [whRow({ category: 'Grocery' })],
      now: NOW,
    });
    expect(res.missing[0].stateReason).toBe('sheet_drift');
    expect(res.missing[0].category).toBe('Eating Out');
  });

  it('re-asserts a row the warehouse believes is deleted but the sheet still has', () => {
    const res = diffMonth({
      sheetRows: [sheetRow()],
      warehouseRows: [whRow({ row_state: 'deleted' })],
      now: NOW,
    });
    expect(res.missing[0].stateReason).toBe('sheet_drift');
  });

  it('says nothing at all when the two agree', () => {
    const res = diffMonth({ sheetRows: [sheetRow()], warehouseRows: [whRow()], now: NOW });
    expect(res).toEqual({ missing: [], deleted: [], erroneous: [] });
  });
});

describe('diffMonth — gone from the sheet', () => {
  it('records a deletion for a settled row that has vanished', () => {
    // The one thing the warehouse holds that Sheets cannot: deleteDimension is
    // physical, so after the fact there is no record the row ever existed.
    const res = diffMonth({ sheetRows: [], warehouseRows: [whRow()], now: NOW });
    expect(res.deleted).toHaveLength(1);
    expect(res.deleted[0].stateReason).toBe('absent_from_sheet');
  });

  it('will NOT bury a row younger than the grace window', () => {
    // It may be mid-flight, or sitting in the outbox waiting for the next
    // drain. Marking it deleted would be permanent and wrong.
    const res = diffMonth({ sheetRows: [], warehouseRows: [whRow({ valid_from: NEW })], now: NOW });
    expect(res.deleted).toEqual([]);
    expect(res.erroneous).toEqual([]);
  });

  it('acts the moment the grace window has elapsed', () => {
    const justOld = new Date(NOW - GRACE_MS - 1000).toISOString();
    const res = diffMonth({ sheetRows: [], warehouseRows: [whRow({ valid_from: justOld })], now: NOW });
    expect(res.deleted).toHaveLength(1);
  });

  it('leaves an already-deleted row alone rather than re-deleting it every tick', () => {
    const res = diffMonth({ sheetRows: [], warehouseRows: [whRow({ row_state: 'deleted' })], now: NOW });
    expect(res.deleted).toEqual([]);
  });

  it('ignores a row whose valid_from is unparseable rather than guessing', () => {
    const res = diffMonth({ sheetRows: [], warehouseRows: [whRow({ valid_from: 'nonsense' })], now: NOW });
    expect(res.deleted).toEqual([]);
  });
});

describe('diffMonth — client-asserted rows the sheet never confirmed', () => {
  it('retracts an unconfirmed notify as erroneous, not as deleted', () => {
    // A browser said it wrote this and the sheet has never agreed. It did not
    // happen — recording a *deletion* would claim it once did.
    const res = diffMonth({
      sheetRows: [],
      warehouseRows: [whRow({ ingest_source: 'notify' })],
      now: NOW,
    });
    expect(res.erroneous).toHaveLength(1);
    expect(res.erroneous[0].stateReason).toBe('unconfirmed_notify');
    expect(res.deleted).toEqual([]);
  });

  it('treats a vanished hook-written row as a genuine deletion', () => {
    // A hook row is written strictly AFTER a successful Sheets write, so it
    // definitely existed. Its absence is a deletion, not a phantom.
    const res = diffMonth({ sheetRows: [], warehouseRows: [whRow({ ingest_source: 'hook' })], now: NOW });
    expect(res.deleted).toHaveLength(1);
    expect(res.erroneous).toEqual([]);
  });

  it('respects the grace window for notify rows too', () => {
    const res = diffMonth({
      sheetRows: [],
      warehouseRows: [whRow({ ingest_source: 'notify', valid_from: NEW })],
      now: NOW,
    });
    expect(res.erroneous).toEqual([]);
  });
});

describe('flattenSnapshot', () => {
  it('tags each row with its tab and drops skipped tabs entirely', () => {
    const rows = flattenSnapshot({
      categories: [
        { category: 'Grocery', skipped: false, rows: [{ uuid: 'a' }, { uuid: 'b' }] },
        { category: 'Pets',    skipped: true,  rows: [{ uuid: 'c' }] },
      ],
    });
    expect(rows.map(r => [r.category, r.uuid])).toEqual([['Grocery', 'a'], ['Grocery', 'b']]);
  });
});

describe('parseV2Row', () => {
  it('reads a normal row, with the uuid in col G', () => {
    expect(parseV2Row(['Jun', 2026, '2026-06-03', 'Safeway', 41.25, 'Amex Gold', 'tx_4125_a1b2c3d4'], 'Grocery', 4))
      .toEqual({
        rowIndex: 4, budgetDate: '2026-06-03', vendor: 'Safeway', amountCents: 4125,
        paymentMethod: 'Amex Gold', bookingMethod: '', uuid: 'tx_4125_a1b2c3d4',
      });
  });

  it('reads Travel rows, where Booking Method pushes the uuid to col H', () => {
    const row = parseV2Row(
      ['Jun', 2026, '2026-06-03', 'Alaska', 400, 'Amex', 'Points', 'tx_40000_a1b2c3d4'],
      'Travel', 2,
    );
    expect(row.bookingMethod).toBe('Points');
    expect(row.uuid).toBe('tx_40000_a1b2c3d4');
    expect(uuidColumnFor('Travel')).toBe(7);
    expect(uuidColumnFor('Grocery')).toBe(6);
  });

  it('returns null for a row with neither vendor nor amount', () => {
    // The FORMULA render returns formula-only rows (a =SUM() totals row) that
    // look populated but are not.
    expect(parseV2Row(['Jun', 2026, '', '', ''], 'Grocery', 9)).toBeNull();
    expect(parseV2Row([], 'Grocery', 9)).toBeNull();
  });

  it('refuses a date that is not a plain ISO day rather than coercing it', () => {
    // A serial number or a formula in the date cell is not a date we can trust;
    // null is honest and the reconciler will flag the drift.
    expect(parseV2Row(['Jun', 2026, 46174, 'X', 1, '', 'tx_100_aaaaaaaa'], 'Grocery', 2).budgetDate).toBeNull();
  });
});

describe('parseTotals', () => {
  it('keeps the col-C FORMULA verbatim so the budget literal survives', () => {
    const { spentCents, budgets } = parseTotals([
      ['Grocery', 41.25, '=600-B2'],
      ['Eating Out', 35.5, '=200-B3'],
      ['', '', ''],
    ]);
    expect(spentCents).toEqual({ 'Grocery': 4125, 'Eating Out': 3550 });
    expect(budgets[0]).toEqual({ category: 'Grocery', totalsRowNum: 2, formulaRaw: '=600-B2', spentCents: 4125 });
    expect(budgets[1].totalsRowNum).toBe(3);
  });

  it('treats a blank spend as zero, not as missing', () => {
    expect(parseTotals([['Rent', '', '=1000-B2']]).spentCents).toEqual({ Rent: 0 });
  });
});

describe('readMonth', () => {
  /** A fake Sheets client keyed on the request path. */
  function fakeSheets({ tabs, values, failOn = null }) {
    return async (path) => {
      if (failOn && path.includes(failOn)) throw new Error('Sheets API (500)');
      if (path.includes('fields=sheets.properties.title')) {
        return { sheets: tabs.map(t => ({ properties: { title: t } })) };
      }
      const tab = decodeURIComponent(path).match(/'([^']+)'!/)?.[1];
      return { values: values[tab] || [] };
    };
  }

  const V2 = ['Month', 'Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'UUID'];

  it('reads transactional tabs and skips the admin ones', async () => {
    const snap = await readMonth({
      spreadsheetId: 'S', budgetMonth: 'June 2026',
      fetchJson: fakeSheets({
        tabs: ['Grocery', 'Totals', 'History', 'By Person'],
        values: {
          Grocery: [V2, ['Jun', 2026, '2026-06-01', 'Safeway', 41.25, 'Amex', 'tx_4125_a1b2c3d4']],
          Totals: [['Grocery', 41.25, '=600-B2']],
        },
      }),
    });
    expect(snap.categories.map(c => c.category)).toEqual(['Grocery']);
    expect(snap.categories[0].rows).toHaveLength(1);
    expect(snap.totalsSpentCents).toEqual({ Grocery: 4125 });
    expect(snap.budgets[0].formulaRaw).toBe('=600-B2');
    for (const t of ['Totals', 'History', 'By Person']) expect(NON_TRANSACTIONAL_TABS.has(t)).toBe(true);
  });

  it('marks a tab whose header fails the V2 contract as skipped, not as empty', async () => {
    const snap = await readMonth({
      spreadsheetId: 'S', budgetMonth: 'June 2026',
      fetchJson: fakeSheets({
        tabs: ['Pets', 'Totals'],
        values: {
          // What addCategory writes: 5 columns, no Payment Method, no UUID.
          Pets: [['Month', 'Year', 'Date', 'Description', 'Amount'], ['Jun', 2026, '', 'Vet', 80]],
          Totals: [['Pets', 80, '=100-B2']],
        },
      }),
    });
    expect(snap.categories[0]).toMatchObject({ category: 'Pets', skipped: true, rows: [] });
  });

  it('ABORTS the whole month when any range fails to read', async () => {
    // The single most important behaviour in the reconciler. Handed a partial
    // snapshot it would conclude every unread row had been deleted, and write
    // that permanently into an append-only table.
    await expect(readMonth({
      spreadsheetId: 'S', budgetMonth: 'June 2026',
      fetchJson: fakeSheets({
        tabs: ['Grocery', 'Misc', 'Totals'],
        values: { Grocery: [V2], Totals: [] },
        failOn: 'Misc',
      }),
    })).rejects.toThrow(/Sheets API/);
  });

  it('aborts if Totals itself fails, rather than reporting every category as over', async () => {
    await expect(readMonth({
      spreadsheetId: 'S', budgetMonth: 'June 2026',
      fetchJson: fakeSheets({
        tabs: ['Grocery'],
        values: { Grocery: [V2] },
        failOn: 'Totals',
      }),
    })).rejects.toThrow(/Sheets API/);
  });
});
