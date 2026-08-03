/**
 * Cloud Function — one-shot warehouse backfill. Owner-authed, run by hand.
 *
 * Two modes, and the order matters:
 *
 * ── mode=raw (Phase 0) ────────────────────────────────────────────────────
 *
 * Dump every month's `History!A:L` and every category tab **verbatim and
 * uninterpreted** into `history_raw` / `sheet_rows_raw`. No modelling, no
 * gates, no schema decisions, and **including V1 months** — they cost nothing
 * extra to capture raw and it preserves the option of backfilling them later.
 *
 * This runs FIRST because everything else in this project is rebuildable from
 * Sheets and this is not: the record of deleted transactions exists only in
 * History, and History is itself unprotected. Every day without this dump is a
 * day it can be lost. Re-running is safe — `row_hash` makes it idempotent at
 * read time.
 *
 * ── mode=load (Phase 2) ───────────────────────────────────────────────────
 *
 * Model V2 months into `transaction_versions` / `budget_versions`, but only
 * after they pass every gate. The gates run against the SNAPSHOT before
 * anything is written, in integer cents, and every check — pass or fail —
 * lands in `load_audits`.
 *
 * V1 months (Oct 2025 – May 2026) are deliberately excluded. They have no Date
 * column at all, pack several charges into `=12.5+9.99`, 92% of rows carry no
 * uuid, and there are thirteen distinct header shapes including six tabs that
 * look like a second table pasted into the same sheet. The plan is to clean
 * those by hand INTO the V2 shape, at which point this same code loads them
 * with no changes at all.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { createHash, randomUUID } from 'node:crypto';
import { corsOriginFor, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getAccessToken } from './lib/_drive.mjs';
import { listMonths } from './lib/_sheets.mjs';
import { sheetSchemaVersion, isV2EligibleMonth } from './lib/_schema-version.mjs';
import { verifyMonth } from './lib/_warehouse-verify.mjs';
import { readMonth, serviceFetchJson, NON_TRANSACTIONAL_TABS } from './lib/_warehouse-reader.mjs';
import {
  warehouseEnabled, mapTransactionEvent, mapBudgetEvent, mapMonthDim,
  flushRows, recordLoadAudits,
} from './lib/_warehouse.mjs';
import { reportError } from './lib/_error-log.mjs';
import { SHEETS_DRIVE_SECRETS, WAREHOUSE_SECRETS } from './lib/secrets.mjs';

/** Stable across re-runs, so a second dump adds no distinct rows. */
export function rowHash(spreadsheetId, tab, rowIndex, cells) {
  return createHash('sha256')
    .update([spreadsheetId, tab, rowIndex, JSON.stringify(cells)].join('\0'))
    .digest('hex');
}

/**
 * Phase 0 — verbatim capture. No interpretation whatsoever.
 *
 * The cells go in as a JSON array of raw strings exactly as Sheets returned
 * them. Deciding what a cell *means* is what the modelled tables are for; the
 * whole value of this table is that it made no decisions.
 */
export async function captureRaw({ months, fetchJson }) {
  const capturedAt = new Date().toISOString();
  const rows = [];
  const errors = [];

  for (const month of months) {
    // History first — it is the irreplaceable half.
    try {
      const range = encodeURIComponent("'History'!A:L");
      const data = await fetchJson(`/${month.sheetId}/values/${range}?valueRenderOption=FORMULA`);
      (data.values || []).forEach((cells, i) => {
        const flat = (cells || []).map(c => (c === null || c === undefined ? '' : String(c)));
        rows.push({ table: 'history_raw', row: {
          spreadsheet_id: month.sheetId,
          budget_month: month.monthName,
          row_index: i + 1,
          cells: JSON.stringify(flat),
          row_hash: rowHash(month.sheetId, 'History', i + 1, flat),
          captured_at: capturedAt,
        } });
      });
    } catch (e) {
      errors.push({ month: month.monthName, tab: 'History', error: e?.message });
    }

    let tabs = [];
    try {
      const meta = await fetchJson(`/${month.sheetId}?fields=sheets.properties.title`);
      tabs = (meta.sheets || []).map(s => s.properties?.title).filter(Boolean);
    } catch (e) {
      errors.push({ month: month.monthName, tab: '(metadata)', error: e?.message });
      continue;
    }

    for (const tab of tabs) {
      if (tab === 'History' || tab === 'Months') continue;
      // Everything else IS captured, including Totals and the 13 mismatched V1
      // header shapes. A raw dump that pre-filters is a raw dump with an
      // opinion, and the opinion is what we cannot revise later.
      try {
        const range = encodeURIComponent(`'${tab}'!A1:Z10000`);
        const data = await fetchJson(`/${month.sheetId}/values/${range}?valueRenderOption=FORMULA`);
        (data.values || []).forEach((cells, i) => {
          const flat = (cells || []).map(c => (c === null || c === undefined ? '' : String(c)));
          if (flat.every(c => c === '')) return;
          rows.push({ table: 'sheet_rows_raw', row: {
            spreadsheet_id: month.sheetId,
            budget_month: month.monthName,
            tab,
            row_index: i + 1,
            cells: JSON.stringify(flat),
            row_hash: rowHash(month.sheetId, tab, i + 1, flat),
            captured_at: capturedAt,
          } });
        });
      } catch (e) {
        // A single unreadable tab does not abandon the dump: unlike the
        // reconciler, this pass draws no conclusions from absence, so a partial
        // capture is strictly better than none.
        errors.push({ month: month.monthName, tab, error: e?.message });
      }
    }
  }

  const res = await flushRows(rows, { ingestSource: 'backfill', timeoutMs: 120_000 });
  return { captured: rows.length, months: months.length, errors, ...res };
}

/**
 * Phase 2 — model one month, gated.
 *
 * Nothing is written unless every fatal gate passes. `load_audits` gets a row
 * either way, so a refusal is as visible as a success.
 */
export async function loadMonth({ month, fetchJson, dryRun = false }) {
  const snapshot = await readMonth({
    spreadsheetId: month.sheetId,
    budgetMonth: month.monthName,
    fetchJson,
  });

  const { passed, audits, skipped } = verifyMonth(snapshot);
  await recordLoadAudits(audits);

  if (!passed) {
    const failed = audits.filter(a => !a.passed).map(a => a.check);
    await reportError('WHS-006', new Error(`gates failed: ${[...new Set(failed)].join(', ')}`), {
      budgetMonth: month.monthName,
    });
    return { month: month.monthName, loaded: 0, passed: false, failedChecks: [...new Set(failed)], skipped };
  }

  if (dryRun) return { month: month.monthName, loaded: 0, passed: true, dryRun: true, skipped };

  const validFrom = new Date().toISOString();
  const ctx = () => ({
    ingestId: randomUUID(), validFrom, ingestSource: 'backfill', channel: 'backfill',
  });

  const rows = [];
  for (const cat of snapshot.categories) {
    if (cat.skipped) continue;
    for (const r of cat.rows) {
      rows.push({ table: 'transaction_versions', row: mapTransactionEvent({
        spreadsheetId: month.sheetId, budgetMonth: month.monthName, category: cat.category,
        uuid: r.uuid, budgetDate: r.budgetDate, vendor: r.vendor, amountCents: r.amountCents,
        paymentMethod: r.paymentMethod, bookingMethod: r.bookingMethod,
        sheetRowIndex: r.rowIndex, rowState: 'valid', stateReason: 'backfill',
        sourceAction: 'backfill',
        // The row was written at some unknown time before this load. Saying so
        // is the difference between an honest archive and a confident wrong one.
        validFromEstimated: true,
        // Release 1 is all V2, so every row is day-precision. The column exists
        // from day one anyway: without it, a spend-by-day chart over the future
        // V1 backfill would drop 592 legacy charges onto the 1st of the month
        // and look entirely plausible.
        datePrecision: 'day',
      }, ctx()) });
    }
  }

  for (const b of snapshot.budgets) {
    rows.push({ table: 'budget_versions', row: mapBudgetEvent({
      spreadsheetId: month.sheetId, budgetMonth: month.monthName, category: b.category,
      formulaRaw: b.formulaRaw, spentCentsAtObservation: b.spentCents,
      totalsRowNum: b.totalsRowNum, sourceAction: 'backfill', validFromEstimated: true,
    }, ctx()) });
  }

  rows.push({ table: 'month_dim', row: mapMonthDim({
    budgetMonth: month.monthName,
    spreadsheetId: month.sheetId,
    schemaVersion: sheetSchemaVersion(month.monthName),
  }, ctx()) });

  const res = await flushRows(rows, { ingestSource: 'backfill', timeoutMs: 120_000 });
  return { month: month.monthName, loaded: res.written, queued: res.queued, passed: true, skipped };
}

export const warehouseBackfill = onRequest(
  {
    region: 'us-central1',
    secrets: [...SHEETS_DRIVE_SECRETS, ...WAREHOUSE_SECRETS],
    cors: false,
    timeoutSeconds: 540,
    memory: '1GiB',
  },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }

    if (!warehouseEnabled()) {
      sendJson(res, 409, { error: 'WAREHOUSE_ENABLED is not "true"' }, corsOrigin);
      return;
    }

    const mode   = req.body?.mode === 'raw' ? 'raw' : 'load';
    const dryRun = req.body?.dryRun === true;
    const only   = Array.isArray(req.body?.months) ? new Set(req.body.months) : null;

    let months;
    try {
      months = await listMonths();
    } catch (e) {
      sendJson(res, 503, { error: `Registry unavailable: ${e.message}` }, corsOrigin);
      return;
    }
    if (only) months = months.filter(m => only.has(m.monthName));

    const fetchJson = serviceFetchJson(getAccessToken);

    try {
      if (mode === 'raw') {
        // Every month, V1 included — see the header.
        sendJson(res, 200, await captureRaw({ months, fetchJson }), corsOrigin);
        return;
      }

      // Release 1 is V2-only. A V1 month here would be silently misread as an
      // empty V2 month (no matching header → every tab skipped), which is a
      // very convincing way to load nothing and call it a success.
      const v2Months = months.filter(m => isV2EligibleMonth(m.monthName));
      const skippedV1 = months.filter(m => !isV2EligibleMonth(m.monthName)).map(m => m.monthName);

      const results = [];
      for (const month of v2Months) {
        try {
          results.push(await loadMonth({ month, fetchJson, dryRun }));
        } catch (e) {
          await reportError('WHS-006', e, { budgetMonth: month.monthName });
          results.push({ month: month.monthName, loaded: 0, passed: false, error: e.message });
        }
      }

      sendJson(res, 200, {
        ok: results.every(r => r.passed),
        dryRun,
        results,
        skippedV1,
        note: skippedV1.length
          ? 'V1-layout months are Release 2. Clean them into the V2 sheet shape and this same endpoint loads them unchanged.'
          : undefined,
      }, corsOrigin);
    } catch (e) {
      await reportError('WHS-006', e, { mode });
      sendJson(res, 500, { error: e.message }, corsOrigin);
    }
  }
);

export { NON_TRANSACTIONAL_TABS };
