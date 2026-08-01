/**
 * Reconciler — diff the actual spreadsheet against the warehouse.
 *
 * This is the component that makes the whole design honest. Everything else is
 * best-effort: the hot-path hooks can fail, the notify endpoint can be
 * bypassed, and a client can assert something that never happened. The
 * reconciler reads the *sheet* and is authoritative over all of it.
 *
 * Three outcomes, and the third is the one people forget:
 *
 *   in sheet, not in warehouse   → record it, `state_reason='missed_notify'`.
 *                                  A new write path that bypassed both
 *                                  chokepoints is picked up here; worst case is
 *                                  latency, not data loss.
 *   in warehouse, gone from sheet → record a `deleted` version. This is the one
 *                                  thing Sheets genuinely cannot tell you
 *                                  later, because deletes are physical.
 *   asserted by a client, never confirmed → `erroneous`. Rows arriving from the
 *                                  browser are client-ASSERTED. If the sheet
 *                                  never shows them, they did not happen, and
 *                                  the analytics views exclude them.
 *
 * Two guards keep it from doing damage:
 *
 *   • **Abort the whole month on a partial read.** `readMonth` throws rather
 *     than returning what it managed to get, because emitting deletes from an
 *     incomplete snapshot would mark live transactions as deleted — permanently,
 *     in an append-only table.
 *   • **A grace window.** A row written seconds ago may not be in our snapshot
 *     yet. Nothing younger than GRACE_MS is ever marked deleted.
 */
import { reportError } from './_error-log.mjs';
import { getAccessToken } from './_drive.mjs';
import { listMonths } from './_sheets.mjs';
import { sheetSchemaVersion, isV2EligibleMonth } from './_schema-version.mjs';
import { DATASET } from './_warehouse-schema.mjs';
import {
  warehouseEnabled, mapTransactionEvent, mapBudgetEvent, mapMonthDim, flushRows,
} from './_warehouse.mjs';
import { readMonth, serviceFetchJson } from './_warehouse-reader.mjs';
import { randomUUID } from 'node:crypto';

/**
 * How settled a row must be before its absence counts as a deletion.
 *
 * Ten minutes covers a slow notify, a queued outbox entry waiting for the next
 * drain, and the gap between reading the sheet and reading BigQuery. Burying an
 * in-flight write under a `deleted` version would be unfixable.
 */
export const GRACE_MS = 10 * 60 * 1000;

/** Months per tick. The current month plus the previous one covers real editing. */
export const MONTHS_PER_RUN = 2;

/** The most recent months, newest first. */
function recentMonths(months, n) {
  const toTime = (name) => { const t = Date.parse(`${name} 1`); return Number.isNaN(t) ? 0 : t; };
  return [...months].sort((a, b) => toTime(b.monthName) - toTime(a.monthName)).slice(0, n);
}

/**
 * The diff itself — pure, so every branch is unit-testable without BigQuery.
 *
 * `sheetRows`     flattened `[{ category, uuid, amountCents, … }]` from readMonth
 * `warehouseRows` current state from `v_transaction_current`, as
 *                 `[{ uuid, category, amount_cents, row_state, ingest_source,
 *                    valid_from }]`
 */
export function diffMonth({ sheetRows, warehouseRows, now = Date.now(), graceMs = GRACE_MS }) {
  const bySheet = new Map();
  for (const r of sheetRows) if (r.uuid) bySheet.set(r.uuid, r);

  const byWarehouse = new Map();
  for (const r of warehouseRows) if (r.uuid) byWarehouse.set(r.uuid, r);

  const missing = [];    // in the sheet, absent or stale in the warehouse
  const deleted = [];    // in the warehouse as live, gone from the sheet
  const erroneous = [];  // client-asserted, never confirmed by the sheet

  for (const [uuid, sheetRow] of bySheet) {
    const wh = byWarehouse.get(uuid);
    if (!wh) { missing.push({ ...sheetRow, stateReason: 'missed_notify' }); continue; }
    // Present in both, but the warehouse's copy no longer matches the sheet —
    // someone edited the cell by hand, which produces no event anywhere.
    const drifted =
      wh.row_state !== 'valid' ||
      Number(wh.amount_cents) !== Number(sheetRow.amountCents) ||
      String(wh.category ?? '') !== String(sheetRow.category ?? '');
    if (drifted) missing.push({ ...sheetRow, stateReason: 'sheet_drift' });
  }

  for (const [uuid, wh] of byWarehouse) {
    if (bySheet.has(uuid)) continue;
    if (wh.row_state !== 'valid') continue;

    // Too young to judge: it may be mid-flight, or sitting in the outbox
    // waiting for the next drain.
    const age = now - Date.parse(wh.valid_from);
    if (!Number.isFinite(age) || age < graceMs) continue;

    if (wh.ingest_source === 'notify') {
      // A browser said it wrote this and the sheet has never agreed. It didn't
      // happen — retract it rather than recording a deletion that never was.
      erroneous.push({ ...wh, stateReason: 'unconfirmed_notify' });
    } else {
      deleted.push({ ...wh, stateReason: 'absent_from_sheet' });
    }
  }

  return { missing, deleted, erroneous };
}

/** Flatten a readMonth snapshot into rows, dropping skipped tabs. */
export function flattenSnapshot(snapshot) {
  const out = [];
  for (const cat of snapshot.categories) {
    if (cat.skipped) continue;
    for (const row of cat.rows) out.push({ ...row, category: cat.category });
  }
  return out;
}

async function currentWarehouseRows(spreadsheetId) {
  const { runQuery } = await import('./_warehouse-client.mjs');
  // The view already collapses duplicate deliveries and derives valid_to, so
  // this is just "what does the warehouse believe right now".
  return runQuery(
    `SELECT uuid, category, amount_cents, row_state, ingest_source,
            FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E*SZ', valid_from) AS valid_from
       FROM \`${await projectDataset()}.v_transaction_current\`
      WHERE spreadsheet_id = @sid`,
    { sid: spreadsheetId },
  );
}

async function projectDataset() {
  const { projectId } = await import('./_warehouse-client.mjs');
  return `${projectId()}.${DATASET}`;
}

/**
 * Reconcile the most recent months.
 *
 * Never throws — it runs inside `onSchedule`, and a throw makes Cloud Scheduler
 * retry the entire tick.
 */
export async function runReconcile({ monthsPerRun = MONTHS_PER_RUN, now = Date.now() } = {}) {
  if (!warehouseEnabled()) return { months: 0, reason: 'disabled' };

  let months;
  try {
    months = await listMonths();
  } catch (e) {
    await reportError('WHS-005', e, { step: 'month registry read' });
    return { months: 0, reason: 'registry_failed' };
  }

  // V1 months are deferred (Release 2) — their layout has no Date column and
  // packs several charges into one row, so "reconciling" them would be
  // guesswork rather than a diff.
  const targets = recentMonths(months.filter(m => isV2EligibleMonth(m.monthName)), monthsPerRun);
  const fetchJson = serviceFetchJson(getAccessToken);

  const summary = { months: 0, missing: 0, deleted: 0, erroneous: 0, budgets: 0, aborted: 0 };

  for (const month of targets) {
    let snapshot;
    try {
      snapshot = await readMonth({
        spreadsheetId: month.sheetId,
        budgetMonth: month.monthName,
        fetchJson,
      });
    } catch (e) {
      // Deliberate: one failed range abandons the whole month. Emitting deletes
      // from a partial snapshot is the worst thing this component could do.
      summary.aborted++;
      await reportError('WHS-005', e, { budgetMonth: month.monthName });
      continue;
    }

    let warehouseRows;
    try {
      warehouseRows = await currentWarehouseRows(month.sheetId);
    } catch (e) {
      await reportError('WHS-005', e, { budgetMonth: month.monthName, step: 'warehouse read' });
      continue;
    }

    const sheetRows = flattenSnapshot(snapshot);
    const { missing, deleted, erroneous } = diffMonth({ sheetRows, warehouseRows, now });

    const validFrom = new Date(now).toISOString();
    const ctx = () => ({
      ingestId: randomUUID(), validFrom, ingestSource: 'reconcile', channel: 'reconcile',
    });

    const rows = [];

    for (const r of missing) {
      rows.push({ table: 'transaction_versions', row: mapTransactionEvent({
        spreadsheetId: month.sheetId, budgetMonth: month.monthName, category: r.category,
        uuid: r.uuid, budgetDate: r.budgetDate, vendor: r.vendor, amountCents: r.amountCents,
        paymentMethod: r.paymentMethod, bookingMethod: r.bookingMethod,
        sheetRowIndex: r.rowIndex, rowState: 'valid', stateReason: r.stateReason,
        sourceAction: 'reconcile',
        // The row existed before we noticed it; we do not know when.
        validFromEstimated: true,
      }, ctx()) });
    }

    for (const r of deleted) {
      rows.push({ table: 'transaction_versions', row: mapTransactionEvent({
        spreadsheetId: month.sheetId, budgetMonth: month.monthName, category: r.category,
        uuid: r.uuid, amountCents: r.amount_cents,
        rowState: 'deleted', stateReason: r.stateReason, sourceAction: 'reconcile',
        validFromEstimated: true,
      }, ctx()) });
    }

    for (const r of erroneous) {
      rows.push({ table: 'transaction_versions', row: mapTransactionEvent({
        spreadsheetId: month.sheetId, budgetMonth: month.monthName, category: r.category,
        uuid: r.uuid, amountCents: r.amount_cents,
        rowState: 'erroneous', stateReason: r.stateReason, sourceAction: 'reconcile',
        validFromEstimated: true,
      }, ctx()) });
    }

    // Budgets: read from col C at FORMULA render, so `derivation` comes out as
    // `formula_literal` rather than being inferred. A month whose budgets read
    // back as `raw_number` is flagged, not trusted.
    for (const b of snapshot.budgets) {
      rows.push({ table: 'budget_versions', row: mapBudgetEvent({
        spreadsheetId: month.sheetId, budgetMonth: month.monthName, category: b.category,
        formulaRaw: b.formulaRaw, spentCentsAtObservation: b.spentCents,
        totalsRowNum: b.totalsRowNum, sourceAction: 'reconcile',
      }, ctx()) });
    }

    rows.push({ table: 'month_dim', row: mapMonthDim({
      budgetMonth: month.monthName,
      spreadsheetId: month.sheetId,
      schemaVersion: sheetSchemaVersion(month.monthName),
    }, ctx()) });

    // Duplicate deliveries collapse in the view on idempotency_key, so the
    // unchanged budget and month_dim rows re-sent every tick cost storage
    // measured in kilobytes per year and change no query's answer.
    const res = await flushRows(rows, { ingestSource: 'reconcile', timeoutMs: 60_000 });

    summary.months++;
    summary.missing += missing.length;
    summary.deleted += deleted.length;
    summary.erroneous += erroneous.length;
    summary.budgets += snapshot.budgets.length;

    console.log(
      `warehouse-reconcile: ${month.monthName} — +${missing.length} missing, ` +
      `${deleted.length} deleted, ${erroneous.length} erroneous ` +
      `(wrote ${res.written}, queued ${res.queued})`
    );
  }

  return summary;
}
