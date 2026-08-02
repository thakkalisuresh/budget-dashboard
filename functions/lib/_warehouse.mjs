/**
 * Warehouse ingest — the one place a transaction or budget becomes a row.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 *
 * Google Sheets stays the source of truth, permanently. The warehouse is a
 * derived, append-only archive beside it: nothing here may ever change a budget
 * number, and dropping the whole dataset and rebuilding it from Sheets must
 * produce identical figures. The one thing it holds that Sheets does not is
 * *history* — deletes in Sheets are physical (`deleteDimension`), so a removed
 * transaction is simply gone.
 *
 * ── Four rules, all load-bearing ──────────────────────────────────────────
 *
 * 1. **Sheets first, DB second, always.** Every call into this module sits
 *    physically after a successful `sheetsRequest`. A warehouse row for a
 *    Sheets write that failed is a phantom in a store that never deletes.
 *
 * 2. **Two field classes.** *Mirrored* fields map to a spreadsheet cell and are
 *    the only ones in the idempotency key. *Derived* fields (card owner, FX
 *    rate, LLM category and confidence) are DB-only, frozen at write time, and
 *    excluded from the key. Put a derived field in the key and a Groq model
 *    bump mints a spurious new version of a transaction nobody touched.
 *
 * 3. **Never infer lineage.** `transaction_key` is carried by explicit
 *    declaration only (`priorTransactionKey` on the event). Edits are
 *    delete + re-append with a *new* uuid, so uuid is not a stable identity —
 *    but analytics correctness does **not** depend on lineage. Net spend is
 *    right as long as each version's validity window is right; lineage only
 *    buys "the history of this one transaction". Nobody should add fuzzy
 *    auto-linking later to make a chart look tidier.
 *
 * 4. **Never throw.** Every entry point swallows its own failure. This code
 *    runs after the user's write has already succeeded; turning a bookkeeping
 *    problem into a failed expense entry would be precisely backwards.
 *
 * ── Why it is awaited ─────────────────────────────────────────────────────
 *
 * "Fire and forget" does not work in Cloud Functions: an instance can freeze
 * the moment the handler returns, so an un-awaited promise may simply never
 * run (the same lesson `_error-log.mjs` records). These calls are awaited with
 * a hard timeout instead — they land, they can't add seconds to the wallet
 * path, and they can never fail the user's write.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from './firestore.mjs';
import { reportError } from './_error-log.mjs';
import { monthStart, monthNameFromDate } from './_schema-version.mjs';
import {
  DATASET, TABLES, IDEMPOTENCY_FIELDS, RAW_PAYLOAD_CAP,
  encodeRow, validateRow,
} from './_warehouse-schema.mjs';

/** Firestore failure queue. NOT the normal path — see the header of drainOutbox. */
export const OUTBOX_COLLECTION = 'warehouse_outbox';

/**
 * How long a hot-path write may take before we give up and queue it.
 *
 * The wallet path already runs a vision model and several Sheets round-trips
 * inside a 30s budget, and the user is watching a push notification. A second
 * and a half is enough for a Storage Write API append on a warm instance and
 * cheap to lose on a cold one, because losing it just means the cron picks it
 * up.
 */
export const HOT_PATH_TIMEOUT_MS = 1500;

/** Give up on an outbox entry after this many drains and dead-letter it. */
export const MAX_OUTBOX_ATTEMPTS = 8;

/**
 * Master switch. Unset (the default) means every entry point is a no-op, so
 * this can be deployed before the dataset exists without touching behaviour.
 */
export function warehouseEnabled() {
  // Trimmed: a Secret Manager value with a trailing newline is a classic
  // footgun, and here it would silently disable the whole archive.
  return String(process.env.WAREHOUSE_ENABLED || '').trim().toLowerCase() === 'true';
}

/* ══ Pure mappers ══════════════════════════════════════════════════════════
   Everything below this line to the next banner is deterministic and side-
   effect free, so the interesting logic is unit-testable without BigQuery,
   Firestore, or a network. */

/**
 * Money is integer cents everywhere in the warehouse.
 *
 * Every verification gate is an exact integer comparison, and float cents is
 * how those gates quietly stop working: 0.1 + 0.2 fails a `==` against 30.
 * Returns null rather than NaN for junk, so a bad value is visibly absent
 * instead of silently zero.
 */
export function toCents(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Category names must be normalized to the *tab* name.
 *
 * `src/sheetHelpers.js` deliberately maps a misspelled `'Utilties'` onto the
 * `Utilities` tab, and the backend `SHEET_MAP` has no such alias. Without
 * normalization here you get two warehouse categories for one budget line, and
 * every per-category gate fails for a reason that looks like a data problem.
 */
const CATEGORY_TAB_ALIASES = {
  utilties: 'Utilities',
  utilities: 'Utilities',
  'wi-fi': 'Wi-Fi',
  wifi: 'Wi-Fi',
};

export function normalizeCategory(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  return CATEGORY_TAB_ALIASES[raw.toLowerCase()] || raw;
}

/**
 * Vendor, flattened for matching. Feeds the idempotency key, so it must be
 * stable against the cosmetic differences between how the bot, the wallet
 * macro and a hand-typed row spell the same shop.
 */
export function normalizeVendor(vendor) {
  return String(vendor ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * sha256 over the MIRRORED fields only.
 *
 * Deduplication happens at READ time, in `v_transaction_versions`, never here:
 * a duplicate delivery is recorded (append-only means recorded) and then
 * ignored by `QUALIFY ROW_NUMBER() … = 1`. Suppressing it at write time would
 * be a small lie about what the system actually received.
 */
export function idempotencyKey(row) {
  const parts = IDEMPOTENCY_FIELDS.map(f => {
    const v = row[f];
    return v === null || v === undefined ? '' : String(v);
  });
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/** `tx_<cents>_<hex8>` — the cents are baked into the uuid at mint time. */
export function centsFromUUID(uuid) {
  const m = /^tx_(\d+)_[0-9a-f]{8}$/.exec(String(uuid || ''));
  return m ? Number(m[1]) : null;
}

export const UUID_SHAPE = /^tx_\d+_[0-9a-f]{8}$/;

/**
 * Recover a budget from what is actually in `Totals!C`.
 *
 * The budget literal exists ONLY inside the formula string `=1200-B4`. Reading
 * col C at UNFORMATTED_VALUE gives you the evaluated remainder and loses it, so
 * the ingest must read at FORMULA render.
 *
 * Three outcomes, and the caller must treat them differently:
 *   formula_literal        parsed from the formula — authoritative
 *   spent_plus_remaining   inferred from cols B+C — correct today, but drifts
 *                          if anything else writes C
 *   raw_number             a bare number in C. This was the NewMonthDialog bug:
 *                          `remaining` stops shrinking, so the derived budget
 *                          GROWS as the month is spent. Flag it, never trust it.
 */
export function parseBudgetCell(formulaRaw, { spentCents = null, remainingCents = null } = {}) {
  const raw = formulaRaw === null || formulaRaw === undefined ? '' : String(formulaRaw).trim();

  const m = /^=\s*(-?[\d.]+)\s*-\s*B\d+\s*$/i.exec(raw);
  if (m) {
    const cents = toCents(m[1]);
    if (cents !== null) return { budgetCents: cents, derivation: 'formula_literal', formulaRaw: raw };
  }

  // A bare number where a formula belongs.
  if (raw !== '' && /^-?[\d.,$\s]+$/.test(raw)) {
    return { budgetCents: toCents(raw), derivation: 'raw_number', formulaRaw: raw };
  }

  if (spentCents !== null && remainingCents !== null) {
    return {
      budgetCents: spentCents + remainingCents,
      derivation: 'spent_plus_remaining',
      formulaRaw: raw || null,
    };
  }

  return { budgetCents: null, derivation: null, formulaRaw: raw || null };
}

/**
 * Build a `transaction_versions` row from an ingest event.
 *
 * `validFrom` is supplied by the caller and is always the SERVER clock. A
 * skewed phone clock in `client_reported_at` is recorded but never used for
 * ordering — otherwise a phone five minutes fast would make its write look
 * like the latest version of a transaction someone else edited afterwards, and
 * "current state" would be wrong in a way no query could detect.
 */
export function mapTransactionEvent(event = {}, ctx = {}) {
  const category   = normalizeCategory(event.category);
  const budgetMonth = event.budgetMonth || monthNameFromDate(event.budgetDate) || null;
  const amountCents = event.amountCents != null ? Math.trunc(event.amountCents) : toCents(event.amount);
  const uuid = event.uuid || null;
  const uuidCents = centsFromUUID(uuid);

  const row = {
    ingest_id: ctx.ingestId || randomUUID(),
    transaction_key: event.transactionKey || event.priorTransactionKey || uuid || null,
    uuid,
    prior_uuid: event.priorUuid || null,

    valid_from: ctx.validFrom,
    valid_from_estimated: event.validFromEstimated === true ? true : null,
    client_reported_at: event.clientReportedAt || null,
    entered_at: event.enteredAt || null,

    row_state: event.rowState || 'valid',
    state_reason: event.stateReason || null,

    spreadsheet_id: event.spreadsheetId || null,
    budget_month: budgetMonth,
    month_start: monthStart(budgetMonth),
    category,
    budget_date: event.budgetDate || null,
    vendor: event.vendor ?? null,
    vendor_normalized: event.vendor ? normalizeVendor(event.vendor) : null,
    amount_cents: amountCents,
    payment_method: event.paymentMethod || null,
    booking_method: event.bookingMethod || null,
    sheet_row_index: event.sheetRowIndex ?? null,

    date_precision: event.datePrecision || 'day',
    card_owner: event.cardOwner || null,
    card_owner_map_hash: event.cardOwnerMapHash || null,
    fx_rate: event.fxRate ?? null,
    fx_original_amount: event.fxOriginalAmount ?? null,
    fx_original_currency: event.fxOriginalCurrency || null,
    llm_category: event.llmCategory || null,
    llm_confidence: event.llmConfidence ?? null,
    llm_model: event.llmModel || null,
    category_source: event.categorySource || null,
    dup_suspect: event.dupSuspect === true ? true : null,
    dup_matched_uuid: event.dupMatchedUuid || null,
    channel: event.channel || ctx.channel || null,
    ingest_source: ctx.ingestSource || 'hook',
    // Always the verified identity from the caller's context, never anything
    // the client claimed in the request body.
    actor_email: ctx.actorEmail || null,
    source_action: event.sourceAction || null,
    amount_uuid_mismatch:
      uuidCents !== null && amountCents !== null ? uuidCents !== amountCents : null,
  };

  row.idempotency_key = idempotencyKey({
    ...row,
    event_type: event.rowState === 'deleted' ? 'transaction_delete' : 'transaction_write',
  });
  return row;
}

/** Build a `budget_versions` row. `category` is `__salary__` for salary. */
export function mapBudgetEvent(event = {}, ctx = {}) {
  const budgetMonth = event.budgetMonth || null;
  const parsed = event.derivation
    ? { budgetCents: event.budgetCents ?? null, derivation: event.derivation, formulaRaw: event.formulaRaw || null }
    : parseBudgetCell(event.formulaRaw, {
        spentCents: event.spentCentsAtObservation ?? null,
        remainingCents: event.remainingCents ?? null,
      });

  const row = {
    ingest_id: ctx.ingestId || randomUUID(),
    valid_from: ctx.validFrom,
    valid_from_estimated: event.validFromEstimated === true ? true : null,
    client_reported_at: event.clientReportedAt || null,
    row_state: event.rowState || 'valid',
    state_reason: event.stateReason || null,
    spreadsheet_id: event.spreadsheetId || null,
    budget_month: budgetMonth,
    month_start: monthStart(budgetMonth),
    category: event.category === '__salary__' ? '__salary__' : normalizeCategory(event.category),
    budget_cents: parsed.budgetCents,
    derivation: parsed.derivation,
    formula_raw: parsed.formulaRaw,
    spent_cents_at_observation: event.spentCentsAtObservation ?? null,
    totals_row_num: event.totalsRowNum ?? null,
    channel: event.channel || ctx.channel || null,
    ingest_source: ctx.ingestSource || 'hook',
    actor_email: ctx.actorEmail || null,
    source_action: event.sourceAction || null,
  };

  row.idempotency_key = idempotencyKey({
    spreadsheet_id: row.spreadsheet_id,
    event_type: 'budget_write',
    uuid: null,
    budget_date: null,
    category: row.category,
    vendor_normalized: null,
    amount_cents: row.budget_cents,
    payment_method: null,
    booking_method: null,
    row_state: row.row_state,
  });
  return row;
}

/**
 * Content hash of a config object, over a CANONICAL rendering.
 *
 * Key order in a JS object is insertion order, and settings objects are
 * assembled differently on different paths — so `JSON.stringify` alone would
 * produce a different hash for an identical map and mint a spurious
 * config_snapshots row on every write. Keys are sorted before hashing.
 */
export function configHash(value) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonical(v[k]); return acc; }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value ?? null))).digest('hex');
}

/** Build a `month_dim` snapshot row. */
export function mapMonthDim(event = {}, ctx = {}) {
  return {
    budget_month: event.budgetMonth || null,
    month_start: monthStart(event.budgetMonth),
    spreadsheet_id: event.spreadsheetId || null,
    schema_version: event.schemaVersion || null,
    captured_at: ctx.validFrom,
  };
}

/**
 * Group events by target table, encode, and drop anything malformed.
 *
 * Returns `{ batches, rejected }`. A bad row is *rejected*, not thrown and not
 * silently written: the whole batch failing because one event had no
 * spreadsheet id would lose the good rows alongside it.
 */
export function prepareBatches(rows) {
  const batches = new Map();
  const rejected = [];
  for (const { table, row } of rows) {
    const def = TABLES[table];
    if (!def) { rejected.push({ table, row, problems: [`unknown table ${table}`] }); continue; }
    const problems = validateRow(def, row);
    if (problems.length) { rejected.push({ table, row, problems }); continue; }
    if (!batches.has(table)) batches.set(table, []);
    batches.get(table).push(encodeRow(def, row));
  }
  return { batches, rejected };
}

/* ══ Side effects ══════════════════════════════════════════════════════════ */

/** Resolve, or reject with a timeout, whichever comes first. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Write a batch of rows, and queue whatever didn't make it.
 *
 * The Storage Write API's default stream is the *normal* path — writes are
 * visible in BigQuery within seconds. The Firestore outbox is demoted to a
 * failure queue: a write that errors or blows the timeout lands there, and the
 * cron drains it. So the dead-letter behaviour is unchanged; only the happy
 * path got shorter.
 *
 * Never throws.
 */
export async function flushRows(rows, { ingestSource = 'hook', actorEmail = null, channel = null, timeoutMs = HOT_PATH_TIMEOUT_MS } = {}) {
  if (!warehouseEnabled() || !rows || rows.length === 0) return { written: 0, queued: 0, rejected: 0 };

  const { batches, rejected } = prepareBatches(rows);

  if (rejected.length) {
    // Malformed events are a bug in a caller, not a transient failure — queuing
    // them would just retry the same bad shape eight times.
    await reportError('WHS-003', new Error(rejected[0].problems.join('; ')), {
      count: rejected.length, table: rejected[0].table,
    }).catch(() => {});
  }

  let written = 0;
  const failed = [];
  for (const [table, encoded] of batches) {
    try {
      const { appendRows } = await import('./_warehouse-client.mjs');
      await withTimeout(appendRows(DATASET, table, encoded), timeoutMs, `warehouse append to ${table}`);
      written += encoded.length;
    } catch (e) {
      failed.push({ table, rows: rows.filter(r => r.table === table).map(r => r.row), error: e?.message || String(e) });
    }
  }

  let queued = 0;
  if (failed.length) {
    queued = await enqueueOutbox(failed, { ingestSource, actorEmail, channel });
  }

  return { written, queued, rejected: rejected.length };
}

/**
 * Park failed writes in Firestore so the cron can retry them.
 *
 * The rows are stored UNENCODED (plain JSON) rather than in Storage-Write proto
 * form: a schema change between the failure and the drain would otherwise make
 * the queued payload unwritable, and this is the queue that exists precisely
 * for the bad days.
 */
export async function enqueueOutbox(failed, meta = {}) {
  let queued = 0;
  try {
    const db = getDb();
    const batch = db.batch();
    for (const entry of failed) {
      const ref = db.collection(OUTBOX_COLLECTION).doc();
      batch.set(ref, {
        table: entry.table,
        rows: entry.rows,
        attempts: 0,
        dead: false,
        lastError: String(entry.error || '').slice(0, 500),
        ingestSource: meta.ingestSource || 'hook',
        actorEmail: meta.actorEmail || null,
        channel: meta.channel || null,
        createdAt: new Date().toISOString(),
      });
      queued += entry.rows.length;
    }
    await batch.commit();
    // Not silent: a queued write means BigQuery was unreachable, which is worth
    // a digest line even though nothing was lost.
    await reportError('WHS-001', new Error(failed[0].error || 'append failed'), {
      table: failed[0].table, queued,
    }).catch(() => {});
  } catch (e) {
    // Both BigQuery and Firestore failed. This is the one path where a
    // warehouse row is genuinely lost — the reconciler is the backstop, since
    // it diffs the actual sheet and will re-emit the row on its next pass.
    await reportError('WHS-002', e, { batches: failed.length }).catch(() => {});
    return 0;
  }
  return queued;
}

/**
 * Record one write attempt, for the audit trail.
 *
 * Best-effort and deliberately not part of `flushRows`' return contract: an
 * attempt log that can fail a real write would be worse than no attempt log.
 */
export async function recordAttempt({
  ingestId, targetTable, outcome, attemptNumber = 1, errorCode = null,
  errorMessage = null, idempotencyKey: key = null, channel = null,
  actorEmail = null, rawPayload = null,
}) {
  if (!warehouseEnabled()) return;
  try {
    const row = {
      ingest_id: ingestId || randomUUID(),
      attempt_at: new Date().toISOString(),
      target_table: targetTable,
      outcome,
      attempt_number: attemptNumber,
      error_code: errorCode,
      error_message: errorMessage ? String(errorMessage).slice(0, 500) : null,
      idempotency_key: key,
      channel,
      actor_email: actorEmail,
      // Capped, and never image bytes: this is for replaying a failed write,
      // not for storage.
      raw_payload: rawPayload ? JSON.stringify(rawPayload).slice(0, RAW_PAYLOAD_CAP) : null,
    };
    const { appendRows } = await import('./_warehouse-client.mjs');
    await withTimeout(
      appendRows(DATASET, 'ingest_attempts', [encodeRow(TABLES.ingest_attempts, row)]),
      HOT_PATH_TIMEOUT_MS,
      'warehouse attempt log',
    );
  } catch {
    // Swallowed on purpose. See the note above.
  }
}

/* ══ The entry points the sheet layer calls ════════════════════════════════ */

const ctxFor = (opts = {}) => ({
  ingestId: randomUUID(),
  validFrom: new Date().toISOString(),
  ingestSource: opts.ingestSource || 'hook',
  actorEmail: opts.actorEmail || null,
  channel: opts.channel || null,
});

/**
 * A transaction was written to a sheet. Call AFTER the write succeeded.
 *
 * `provenance` carries the derived, frozen-at-write-time fields — LLM category
 * and confidence, FX, card owner, duplicate match. They are optional
 * everywhere: a caller that doesn't have them writes NULL, and NULL is honest.
 * Backfilled rows are never retro-enriched from today's settings, which would
 * be exactly the history rewrite this design prevents.
 */
export async function recordTransactionWrite(event, opts = {}) {
  if (!warehouseEnabled()) return { written: 0, queued: 0, rejected: 0 };
  try {
    const ctx = ctxFor(opts);
    const row = mapTransactionEvent({ ...event, rowState: 'valid' }, ctx);
    return await flushRows([{ table: 'transaction_versions', row }], { ...opts, ...ctx });
  } catch (e) {
    await reportError('WHS-001', e, { step: 'recordTransactionWrite' }).catch(() => {});
    return { written: 0, queued: 0, rejected: 1 };
  }
}

/**
 * A transaction was deleted from a sheet.
 *
 * This is recorded as a NEW version with `row_state = 'deleted'`, not as a
 * removal — the deletion IS the current state, and the prior version keeps its
 * own validity window. This is the single thing the warehouse holds that Sheets
 * cannot: `deleteDimension` leaves no trace at all.
 */
export async function recordTransactionDelete(event, opts = {}) {
  if (!warehouseEnabled()) return { written: 0, queued: 0, rejected: 0 };
  try {
    const ctx = ctxFor(opts);
    const row = mapTransactionEvent(
      { ...event, rowState: 'deleted', stateReason: event.stateReason || 'deleted_in_sheet' },
      ctx,
    );
    return await flushRows([{ table: 'transaction_versions', row }], { ...opts, ...ctx });
  } catch (e) {
    await reportError('WHS-001', e, { step: 'recordTransactionDelete' }).catch(() => {});
    return { written: 0, queued: 0, rejected: 1 };
  }
}

/** A budget (or salary) cell was written. */
export async function recordBudgetWrite(event, opts = {}) {
  if (!warehouseEnabled()) return { written: 0, queued: 0, rejected: 0 };
  try {
    const ctx = ctxFor(opts);
    const row = mapBudgetEvent(event, ctx);
    return await flushRows([{ table: 'budget_versions', row }], { ...opts, ...ctx });
  } catch (e) {
    await reportError('WHS-001', e, { step: 'recordBudgetWrite' }).catch(() => {});
    return { written: 0, queued: 0, rejected: 1 };
  }
}

/**
 * A month was created (or observed) in the registry.
 *
 * Month spreadsheet ids can rotate and nothing else in the system records what
 * they used to be, so an old id in an old row would become unresolvable.
 */
export async function recordMonthDim(event, opts = {}) {
  if (!warehouseEnabled()) return { written: 0, queued: 0, rejected: 0 };
  try {
    const ctx = ctxFor(opts);
    return await flushRows([{ table: 'month_dim', row: mapMonthDim(event, ctx) }], { ...opts, ...ctx });
  } catch (e) {
    await reportError('WHS-001', e, { step: 'recordMonthDim' }).catch(() => {});
    return { written: 0, queued: 0, rejected: 1 };
  }
}

/**
 * Snapshot a piece of mutable config, if it has changed.
 *
 * Frozen derived fields point at these by `content_hash`. Without the snapshot,
 * `card_owner = 'me'` on a row from last March is unexplainable: you can see
 * what was decided but not what it was decided from.
 *
 * Append-on-CHANGE: the hash is cached per warm instance, so a settings object
 * that hasn't moved costs nothing after the first write of an instance's life.
 * A duplicate that does slip through collapses in the view anyway — the hash is
 * the key.
 *
 * Returns the hash so the caller can stamp it onto the transaction row.
 */
const _snapshotted = new Set();

export async function snapshotConfig(kind, payload, opts = {}) {
  const hash = configHash(payload);
  if (!warehouseEnabled()) return hash;
  const key = `${kind}:${hash}`;
  if (_snapshotted.has(key)) return hash;
  _snapshotted.add(key);
  try {
    await flushRows([{ table: 'config_snapshots', row: {
      content_hash: hash,
      config_kind: kind,
      captured_at: new Date().toISOString(),
      payload: JSON.stringify(payload ?? null).slice(0, RAW_PAYLOAD_CAP),
      actor_email: opts.actorEmail || null,
    } }], { ingestSource: opts.ingestSource || 'hook', actorEmail: opts.actorEmail || null });
  } catch {
    // The hash is still returned and still correct — the row it points at just
    // isn't there yet, and the next write of a changed config will re-add it.
  }
  return hash;
}

/** Testing seam: forget which config hashes this instance has already written. */
export function __resetConfigSnapshots() {
  _snapshotted.clear();
}

/** Record a verification check — pass or fail. See _warehouse-verify.mjs. */
export async function recordLoadAudits(audits) {
  if (!warehouseEnabled() || !audits?.length) return { written: 0, queued: 0, rejected: 0 };
  const checkedAt = new Date().toISOString();
  const rows = audits.map(a => ({
    table: 'load_audits',
    row: {
      audit_id: randomUUID(),
      checked_at: checkedAt,
      check_name: a.check,
      passed: a.passed,
      budget_month: a.budgetMonth || null,
      category: a.category || null,
      expected: a.expected ?? null,
      actual: a.actual ?? null,
      detail: a.detail || null,
    },
  }));
  // Audits are not on anyone's hot path, so give them room to land.
  return flushRows(rows, { ingestSource: 'backfill', timeoutMs: 20_000 });
}
