import { describe, it, expect } from 'vitest';
import {
  verifyMonth, headerMatchesV2, checkNoExpiration,
  V2_HEADER, V2_TRAVEL_HEADER, NON_FATAL_CHECKS,
} from '../../functions/lib/_warehouse-verify.mjs';

/**
 * The deliberate-corruption suite.
 *
 * `verifyMonth` is pure precisely so this can exist. The pattern is: one golden
 * fixture that must pass, then a series of single mutations each of which must
 * fail — and fail with the SPECIFIC expected check_name, not just "something
 * went wrong". A gate that fires for the wrong reason is barely better than one
 * that doesn't fire at all, since the audit row is what you read at 8am when
 * the backfill refused to load.
 *
 * An integration-only version of these assertions is a gate that never actually
 * runs. That failure mode has already cost this project real time.
 */

/** June 2026 in miniature: two tabs, exact cents, all uuids well-formed. */
function golden() {
  return {
    budgetMonth: 'June 2026',
    categories: [
      {
        category: 'Grocery',
        skipped: false,
        dataRowCount: 3,
        rows: [
          { uuid: 'tx_4125_a1b2c3d4', amountCents: 4125, rowIndex: 2 },
          { uuid: 'tx_1099_00ff11ee', amountCents: 1099, rowIndex: 3 },
          { uuid: 'tx_250_deadbeef',  amountCents: 250,  rowIndex: 4 },
        ],
      },
      {
        category: 'Eating Out',
        skipped: false,
        dataRowCount: 2,
        rows: [
          { uuid: 'tx_2000_0123abcd', amountCents: 2000, rowIndex: 2 },
          { uuid: 'tx_1550_9876fedc', amountCents: 1550, rowIndex: 3 },
        ],
      },
    ],
    totalsSpentCents: { 'Grocery': 5474, 'Eating Out': 3550 },
  };
}

/** All audits for one check name. */
const checks = (res, name) => res.audits.filter(a => a.check === name);
const failed = (res) => res.audits.filter(a => !a.passed).map(a => a.check);

describe('verifyMonth — the golden case', () => {
  it('passes every gate on clean data', () => {
    const res = verifyMonth(golden());
    expect(failed(res)).toEqual([]);
    expect(res.passed).toBe(true);
  });

  it('records a row for every check, passing ones included', () => {
    // A gate that only records failures gives you no way to prove it ran.
    const res = verifyMonth(golden());
    expect(res.audits.length).toBeGreaterThan(10);
    expect(res.audits.every(a => typeof a.passed === 'boolean')).toBe(true);
    for (const name of ['category_sum', 'row_count', 'distinct_uuid', 'uuid_format', 'month_sum']) {
      expect(checks(res, name).length, `${name} recorded`).toBeGreaterThan(0);
    }
  });

  it('sums the month in exact integer cents', () => {
    const res = verifyMonth(golden());
    const monthSum = checks(res, 'month_sum')[0];
    expect(monthSum.expected).toBe(9024);
    expect(monthSum.actual).toBe(9024);
  });
});

describe('verifyMonth — one mutation at a time', () => {
  it('a dropped row fails row_count and category_sum, and nothing else', () => {
    const s = golden();
    s.categories[0].rows.pop();          // dataRowCount still says 3
    const res = verifyMonth(s);

    expect(res.passed).toBe(false);
    expect(new Set(failed(res))).toEqual(new Set(['row_count', 'category_sum', 'month_sum']));
    expect(checks(res, 'row_count').find(a => a.category === 'Grocery'))
      .toMatchObject({ expected: 3, actual: 2 });
  });

  it('an amount off by ONE CENT fails category_sum', () => {
    // The whole reason money is INT64 cents. A tolerance here would let this
    // through, and this is exactly the error the gate exists to catch.
    const s = golden();
    s.categories[0].rows[0].amountCents = 4126;
    const res = verifyMonth(s);

    expect(res.passed).toBe(false);
    const sum = checks(res, 'category_sum').find(a => a.category === 'Grocery');
    expect(sum.passed).toBe(false);
    expect(sum.detail).toContain('off by 1 cents');
  });

  it('a duplicated uuid fails distinct_uuid — it is alarmed, never deduped', () => {
    // A half-failed moveTransactionCategory leaves one uuid in two tabs. Picking
    // one silently would hide a real, ongoing data problem.
    const s = golden();
    s.categories[0].rows[1].uuid = s.categories[0].rows[0].uuid;
    const res = verifyMonth(s);

    expect(res.passed).toBe(false);
    expect(failed(res)).toContain('distinct_uuid');
    expect(checks(res, 'distinct_uuid').find(a => a.category === 'Grocery'))
      .toMatchObject({ expected: 3, actual: 2 });
    // The amounts are untouched, so the money gates must stay quiet.
    expect(failed(res)).not.toContain('category_sum');
    expect(failed(res)).not.toContain('month_sum');
  });

  it('a row in the wrong category fails both categories sum but not the month', () => {
    // Moving a row between tabs conserves the month total — so month_sum alone
    // would never notice, which is why the per-category gate exists.
    const s = golden();
    const moved = s.categories[0].rows.pop();
    s.categories[0].dataRowCount = 2;
    s.categories[1].rows.push(moved);
    s.categories[1].dataRowCount = 3;
    const res = verifyMonth(s);

    expect(res.passed).toBe(false);
    expect(failed(res)).toContain('category_sum');
    expect(checks(res, 'category_sum').filter(a => !a.passed)).toHaveLength(2);
    expect(checks(res, 'month_sum')[0].passed).toBe(true);
    expect(failed(res)).not.toContain('row_count');
  });

  it('a malformed uuid fails uuid_format', () => {
    const s = golden();
    s.categories[0].rows[0].uuid = 'not-a-uuid';
    const res = verifyMonth(s);
    expect(res.passed).toBe(false);
    expect(failed(res)).toContain('uuid_format');
  });

  it('a missing uuid fails both uuid_format and distinct_uuid', () => {
    const s = golden();
    s.categories[0].rows[0].uuid = null;
    const res = verifyMonth(s);
    expect(new Set(failed(res))).toEqual(new Set(['uuid_format', 'distinct_uuid']));
  });

  it('a category with no Totals row fails category_sum with a specific reason', () => {
    const s = golden();
    delete s.totalsSpentCents['Eating Out'];
    const res = verifyMonth(s);
    const audit = checks(res, 'category_sum').find(a => a.category === 'Eating Out');
    expect(audit.passed).toBe(false);
    expect(audit.detail).toMatch(/no Totals row/i);
  });
});

describe('verifyMonth — what is recorded but not fatal', () => {
  it('an amount/uuid mismatch is recorded and does NOT block the load', () => {
    // The uuid bakes in the cents at mint time, so an in-place amount edit
    // legitimately breaks this. Worth knowing; not worth refusing a month.
    const s = golden();
    s.categories[0].rows[0].amountCents = 4200;
    s.totalsSpentCents['Grocery'] = 5549;                     // keep the sums honest
    const res = verifyMonth(s);

    const audit = checks(res, 'amount_uuid_match').find(a => a.category === 'Grocery');
    expect(audit.passed).toBe(false);
    expect(res.passed).toBe(true);
    expect(NON_FATAL_CHECKS.has('amount_uuid_match')).toBe(true);
  });

  it('a skipped V1-shaped tab is excluded from BOTH sides of month_sum', () => {
    // addCategory writes a 5-column header with no uuid, so custom-category
    // tabs are structurally V1. Counting them on one side only would make an
    // otherwise-correct month permanently unloadable.
    const s = golden();
    s.categories.push({ category: 'Pets', skipped: true, dataRowCount: 0, rows: [] });
    s.totalsSpentCents['Pets'] = 9999;
    const res = verifyMonth(s);

    expect(res.passed).toBe(true);
    expect(res.skipped).toEqual(['Pets']);
    expect(checks(res, 'month_sum')[0]).toMatchObject({ expected: 9024, actual: 9024 });
    // The skip is still recorded — a silently ignored tab looks like an empty one.
    expect(checks(res, 'header_contract').find(a => a.category === 'Pets').passed).toBe(false);
  });
});

describe('the V2 header contract', () => {
  it('accepts the exact contract for normal and Travel tabs', () => {
    expect(headerMatchesV2(V2_HEADER)).toBe(true);
    expect(headerMatchesV2(V2_TRAVEL_HEADER, { travel: true })).toBe(true);
  });

  it('rejects the 5-column header addCategory writes', () => {
    expect(headerMatchesV2(['Month', 'Year', 'Date', 'Description', 'Amount'])).toBe(false);
  });

  it('rejects a V1 header, which has no Date column at all', () => {
    expect(headerMatchesV2(['Month', 'Year', 'Vendor', 'Amount'])).toBe(false);
  });

  it('rejects the Travel shape on a non-Travel tab and vice versa', () => {
    expect(headerMatchesV2(V2_TRAVEL_HEADER)).toBe(false);
    expect(headerMatchesV2(V2_HEADER, { travel: true })).toBe(false);
  });

  it('tolerates surrounding whitespace but not a different word', () => {
    expect(headerMatchesV2(['Month ', ' Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'UUID'])).toBe(true);
    expect(headerMatchesV2(['Month', 'Year', 'Date', 'Grocer', 'Amount', 'Payment Method', 'UUID'])).toBe(false);
  });
});

describe('dataset expiration guard', () => {
  it('passes when no expiration is set', () => {
    expect(checkNoExpiration({}).passed).toBe(true);
    expect(checkNoExpiration({ defaultTableExpirationMs: null }).passed).toBe(true);
  });

  it('fails on a table expiration — it deletes the archive on a timer, silently', () => {
    const res = checkNoExpiration({ defaultTableExpirationMs: '5184000000' });
    expect(res.passed).toBe(false);
    expect(res.audits[0].detail).toContain('defaultTableExpirationMs');
  });

  it('fails on a partition expiration too', () => {
    const res = checkNoExpiration({ defaultPartitionExpirationMs: '7776000000' });
    expect(res.passed).toBe(false);
    expect(res.audits[0].detail).toContain('defaultPartitionExpirationMs');
  });
});
