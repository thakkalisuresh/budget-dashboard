/**
 * Backfill gates — does a staged month actually match the spreadsheet?
 *
 * Deliberately a PURE function over a snapshot, with no BigQuery and no Sheets
 * client anywhere in this file. A gate that only runs as part of an integration
 * test is a gate that never actually runs, and this project has been bitten by
 * that before. Because `verifyMonth` is pure, `warehouseVerify.test.js` can
 * take a golden fixture, mutate one thing, and assert that the RIGHT check
 * fails — which is the only way to know a gate works.
 *
 * Every comparison is in integer cents. `SUM(amount_cents) == totals × 100`
 * must hold exactly; a tolerance would let a real 1¢ discrepancy through, and
 * that is precisely the class of error this exists to catch.
 *
 * Every check emits a `load_audits` row whether it passes or fails. A gate that
 * only records failures leaves you unable to prove it ran at all.
 */
import { UUID_SHAPE, centsFromUUID } from './_warehouse.mjs';

/**
 * The V2 contract for a category tab. `addCategory` writes a five-column
 * header with no Payment Method and no UUID, so custom-category tabs are
 * structurally V1 — they are skipped per-category AND excluded from both sides
 * of the month_sum gate, or the month would never balance.
 */
export const V2_HEADER          = ['Month', 'Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'UUID'];
export const V2_TRAVEL_HEADER   = ['Month', 'Year', 'Date', 'Vendor', 'Amount', 'Payment Method', 'Booking Method', 'UUID'];

export function headerMatchesV2(header, { travel = false } = {}) {
  const want = travel ? V2_TRAVEL_HEADER : V2_HEADER;
  const got  = (header || []).map(h => String(h ?? '').trim());
  return want.every((h, i) => got[i] === h);
}

const audit = (check, passed, extra = {}) => ({ check, passed, ...extra });

/**
 * Verify one month's staged rows against what the spreadsheet says.
 *
 * snapshot = {
 *   budgetMonth: 'June 2026',
 *   categories: [{
 *     category:      'Grocery',
 *     skipped:       false,          // header failed the V2 contract
 *     dataRowCount:  17,             // non-empty data rows actually read
 *     rows: [{ uuid, amountCents, rowIndex }],
 *   }],
 *   totalsSpentCents: { Grocery: 41250, … },   // Totals!B × 100, per category
 * }
 *
 * Returns `{ passed, audits, skipped }`. `passed` is false if ANY fatal gate
 * failed; `amount_uuid_match` is recorded but never fatal, because an in-place
 * edit legitimately breaks it (the uuid's cents were minted from the original
 * amount).
 */
export function verifyMonth(snapshot) {
  const { budgetMonth, categories = [], totalsSpentCents = {} } = snapshot || {};
  const audits = [];
  const skipped = [];

  let monthStagedCents = 0;
  let monthTotalsCents = 0;

  for (const cat of categories) {
    const name = cat.category;

    // A tab whose header doesn't match the contract is not archived, and is
    // excluded from BOTH sides of month_sum below. Recording the skip is the
    // point: a silently ignored tab looks identical to an empty one.
    if (cat.skipped) {
      skipped.push(name);
      audits.push(audit('header_contract', false, {
        budgetMonth, category: name,
        detail: 'tab header does not match the V2 contract — skipped, and excluded from month_sum',
      }));
      continue;
    }
    audits.push(audit('header_contract', true, { budgetMonth, category: name }));

    const rows = cat.rows || [];

    /* ── category_sum ────────────────────────────────────────────────────── */
    const staged   = rows.reduce((n, r) => n + (Number.isFinite(r.amountCents) ? r.amountCents : 0), 0);
    const expected = totalsSpentCents[name];
    if (expected === undefined) {
      audits.push(audit('category_sum', false, {
        budgetMonth, category: name, actual: staged,
        detail: 'no Totals row for this category',
      }));
    } else {
      audits.push(audit('category_sum', staged === expected, {
        budgetMonth, category: name, expected, actual: staged,
        detail: staged === expected ? null : `off by ${staged - expected} cents`,
      }));
      monthTotalsCents += expected;
    }
    monthStagedCents += staged;

    /* ── row_count ───────────────────────────────────────────────────────── */
    audits.push(audit('row_count', rows.length === cat.dataRowCount, {
      budgetMonth, category: name, expected: cat.dataRowCount, actual: rows.length,
      detail: rows.length === cat.dataRowCount ? null : 'staged rows do not match rows read',
    }));

    /* ── distinct_uuid ───────────────────────────────────────────────────── */
    // A duplicate uuid is a REAL problem — a half-failed moveTransactionCategory
    // leaves the same uuid in two tabs. Alarm; never silently pick one.
    const uuids = rows.map(r => r.uuid).filter(Boolean);
    const distinct = new Set(uuids).size;
    audits.push(audit('distinct_uuid', distinct === rows.length, {
      budgetMonth, category: name, expected: rows.length, actual: distinct,
      detail: distinct === rows.length ? null : 'duplicate or missing uuid in staged rows',
    }));

    /* ── uuid_format ─────────────────────────────────────────────────────── */
    const malformed = rows.filter(r => !UUID_SHAPE.test(String(r.uuid || '')));
    audits.push(audit('uuid_format', malformed.length === 0, {
      budgetMonth, category: name, expected: 0, actual: malformed.length,
      detail: malformed.length === 0 ? null : `first: ${JSON.stringify(malformed[0].uuid ?? null)}`,
    }));

    /* ── amount_uuid_match (recorded, NOT fatal) ─────────────────────────── */
    // The uuid bakes in the cents at mint time, so an in-place amount edit
    // legitimately breaks this. Worth knowing, not worth blocking a load.
    const mismatched = rows.filter(r => {
      const c = centsFromUUID(r.uuid);
      return c !== null && Number.isFinite(r.amountCents) && c !== r.amountCents;
    });
    audits.push(audit('amount_uuid_match', mismatched.length === 0, {
      budgetMonth, category: name, expected: 0, actual: mismatched.length,
      detail: mismatched.length === 0 ? null : 'expected after an in-place edit; informational only',
    }));
  }

  /* ── month_sum ─────────────────────────────────────────────────────────── */
  // Both sides cover the same category set: skipped tabs contribute to neither,
  // so a custom V1 tab can't make an otherwise-correct month look broken.
  audits.push(audit('month_sum', monthStagedCents === monthTotalsCents, {
    budgetMonth, expected: monthTotalsCents, actual: monthStagedCents,
    detail: monthStagedCents === monthTotalsCents
      ? (skipped.length ? `${skipped.length} tab(s) excluded from both sides` : null)
      : `off by ${monthStagedCents - monthTotalsCents} cents`,
  }));

  const passed = audits.every(a => a.passed || NON_FATAL_CHECKS.has(a.check));
  return { passed, audits, skipped };
}

/**
 * Checks that are recorded but never block a load.
 *
 * `header_contract` is here because skipping a custom-category tab is expected
 * behaviour, not a load failure — the tab genuinely is V1-shaped, and it is
 * excluded from both sides of month_sum so nothing downstream is wrong.
 */
export const NON_FATAL_CHECKS = new Set(['amount_uuid_match', 'header_contract']);

/**
 * Assert the archive dataset carries no expiration timer.
 *
 * Neither of these throws or warns anywhere in BigQuery — the tables simply
 * start disappearing on a schedule. That deserves an alarm, not a comment in
 * the setup script.
 */
export function checkNoExpiration(datasetMetadata) {
  const problems = [];
  const table = datasetMetadata?.defaultTableExpirationMs;
  const part  = datasetMetadata?.defaultPartitionExpirationMs;
  if (table) problems.push(`defaultTableExpirationMs=${table}`);
  if (part)  problems.push(`defaultPartitionExpirationMs=${part}`);
  return {
    passed: problems.length === 0,
    audits: [audit('dataset_no_expiration', problems.length === 0, {
      detail: problems.length === 0 ? null : problems.join(', '),
    })],
  };
}
