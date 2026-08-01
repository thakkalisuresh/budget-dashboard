/**
 * BigQuery warehouse — schema, DDL, and value encoding.
 *
 * This module is the single source of truth for what the warehouse looks like.
 * Everything else (the ingest, the backfill, the reconciler, the setup script)
 * derives from the table definitions here, so a column can only be added in one
 * place.
 *
 * Three rules are baked into the shapes below and must not be relaxed:
 *
 *  1. **Append-only.** No UPDATE, no DELETE, no MERGE on the fact tables. There
 *     is deliberately no `valid_to` column — closing a version would be an
 *     update. It is derived in `v_transaction_versions` with LEAD().
 *  2. **Money is INT64 cents.** Every verification gate is an exact integer
 *     comparison; float cents is how those gates quietly stop working.
 *  3. **Every new column is nullable, forever.** Append-only means old rows can
 *     never gain a value, so a REQUIRED column added later is unsatisfiable.
 *
 * The only REQUIRED columns are the ones minted by the ingest itself and
 * therefore present on every row ever written.
 *
 * No imports: this file is pure data plus pure functions, so unit tests can
 * load it without pulling in a BigQuery client.
 */

export const DATASET = 'fundient_warehouse';

/**
 * Staging lives in its own dataset so the archive dataset never has to grant
 * delete rights to anything. The backfill truncates staging tables; it must not
 * be able to truncate `transaction_versions` by typo.
 */
export const STAGING_DATASET = 'fundient_staging';

export const LOCATION = 'US';

/* ── Row states ───────────────────────────────────────────────────────────── */

/**
 * Three states, not two. `deleted` was a real transaction that was removed and
 * still counts in historical analysis; `erroneous` should never have existed
 * (a phantom notify, a double-delivered client event) and is excluded from
 * every analytics surface.
 */
export const ROW_STATES = ['valid', 'deleted', 'erroneous'];

/** How the row reached the warehouse. `notify` is client-asserted, not proven. */
export const INGEST_SOURCES = ['hook', 'notify', 'backfill', 'reconcile', 'drain'];

/** Precision of `budget_date`. Always 'day' in Release 1; V1 months are 'month'. */
export const DATE_PRECISIONS = ['day', 'month'];

/**
 * How a budget number was recovered. `formula_literal` is read straight out of
 * `=1200-B4` and is authoritative; `spent_plus_remaining` is inferred and can
 * drift; `raw_number` is the NewMonthDialog bug (fixed in sheetTotals.js) and
 * means the value grows as the month is spent — flag it, never trust it.
 */
export const BUDGET_DERIVATIONS = ['formula_literal', 'spent_plus_remaining', 'raw_number'];

/* ── Field classes ────────────────────────────────────────────────────────── */

/**
 * MIRRORED fields map 1:1 to a cell in the spreadsheet. They — and only they —
 * participate in the idempotency key.
 *
 * A DERIVED field inside the key would mean a Groq model bump, an FX rate
 * refresh, or a card→owner rename mints a spurious new version of a
 * transaction nobody touched. That is precisely the history rewrite this whole
 * design exists to prevent. If you add a field, decide which class it is before
 * you add the column.
 */
export const IDEMPOTENCY_FIELDS = [
  'spreadsheet_id', 'event_type', 'uuid', 'budget_date', 'category',
  'vendor_normalized', 'amount_cents', 'payment_method', 'booking_method',
  'row_state',
];

/* ── Tables ───────────────────────────────────────────────────────────────── */

const c = (name, type, doc, mode = 'NULLABLE') => ({ name, type, mode, doc });

/** One row per *observed version* of a logical transaction. */
const TRANSACTION_VERSIONS = {
  name: 'transaction_versions',
  partitionBy: 'month_start',
  clusterBy: ['row_state', 'category', 'transaction_key'],
  columns: [
    /* identity */
    c('ingest_id', 'STRING', 'Unique per write attempt. Tie-breaks equal valid_from.', 'REQUIRED'),
    c('idempotency_key', 'STRING', 'sha256 over IDEMPOTENCY_FIELDS. Dedup happens at READ time.', 'REQUIRED'),
    c('transaction_key', 'STRING', 'First-ever uuid of this lineage. Declared, never inferred.'),
    c('uuid', 'STRING', "This version's sheet uuid. NOT stable across edits."),
    c('prior_uuid', 'STRING', 'The uuid this version replaced, when declared.'),

    /* system time */
    c('valid_from', 'TIMESTAMP', 'Server receive time. Never client-supplied.', 'REQUIRED'),
    c('valid_from_estimated', 'BOOL', 'True when valid_from was reconstructed rather than observed.'),
    c('client_reported_at', 'TIMESTAMP', "The client's own clock. Recorded, never trusted for ordering."),
    c('entered_at', 'TIMESTAMP', 'When the user actually typed it (offline queue). May long precede valid_from.'),

    /* state */
    c('row_state', 'STRING', "One of ROW_STATES.", 'REQUIRED'),
    c('state_reason', 'STRING', "Why, e.g. 'missed_notify', 'unconfirmed_notify', 'sheet_absent'."),

    /* mirrored */
    c('spreadsheet_id', 'STRING', 'Month spreadsheet the row lives in.', 'REQUIRED'),
    c('budget_month', 'STRING', "Registry month name, e.g. 'June 2026'."),
    c('month_start', 'DATE', 'First day of budget_month. Partition key.', 'REQUIRED'),
    c('category', 'STRING', 'Normalized TAB name, not the caller alias.'),
    c('budget_date', 'DATE', 'Transaction date as recorded in the sheet.'),
    c('vendor', 'STRING', 'Vendor exactly as written in the sheet.'),
    c('vendor_normalized', 'STRING', 'Lowercased/stripped vendor, for the idempotency key and grouping.'),
    c('amount_cents', 'INT64', 'Integer cents. Never a float.'),
    c('payment_method', 'STRING', 'Card name as written.'),
    c('booking_method', 'STRING', 'Travel/Holiday only.'),
    c('sheet_row_index', 'INT64', '1-based sheet row at observation time. Positional, so it goes stale.'),

    /* derived — frozen at write time, never recomputed */
    c('date_precision', 'STRING', "'day' | 'month'. V1 months have month precision only."),
    c('card_owner', 'STRING', 'Owner resolved at write time from the then-current card map.'),
    c('card_owner_map_hash', 'STRING', 'content_hash of the config_snapshots row used.'),
    c('fx_rate', 'FLOAT64', 'Rate used at write time.'),
    c('fx_original_amount', 'INT64', 'Original-currency minor units.'),
    c('fx_original_currency', 'STRING', 'ISO 4217.'),
    c('llm_category', 'STRING', "The model's suggestion at write time."),
    c('llm_confidence', 'FLOAT64', 'Its confidence at write time.'),
    c('llm_model', 'STRING', 'Exact model id, so a model bump is visible.'),
    c('category_source', 'STRING', "'smart_rule' | 'llm' | 'extractor' | 'user' | 'unknown'."),
    c('dup_suspect', 'BOOL', 'Duplicate matcher fired at write time.'),
    c('dup_matched_uuid', 'STRING', 'What it matched against.'),
    c('channel', 'STRING', "'web' | 'wallet' | 'telegram' | 'mcp' | 'backfill'."),
    c('ingest_source', 'STRING', 'One of INGEST_SOURCES. `notify` is client-asserted.'),
    c('actor_email', 'STRING', 'Verified email of whoever caused the write.'),
    c('source_action', 'STRING', "Caller-level action, e.g. 'addOrUpdateExpense', 'moveTransactionCategory'."),
    c('amount_uuid_mismatch', 'BOOL', 'Cents embedded in the uuid disagree with amount_cents.'),
  ],
};

/** Budgets and salary. Salary uses the reserved category `__salary__`. */
const BUDGET_VERSIONS = {
  name: 'budget_versions',
  partitionBy: 'month_start',
  clusterBy: ['category'],
  columns: [
    c('ingest_id', 'STRING', 'Unique per write attempt.', 'REQUIRED'),
    c('idempotency_key', 'STRING', 'sha256 over the mirrored budget fields.', 'REQUIRED'),
    c('valid_from', 'TIMESTAMP', 'Server receive time.', 'REQUIRED'),
    c('valid_from_estimated', 'BOOL', ''),
    c('client_reported_at', 'TIMESTAMP', ''),
    c('row_state', 'STRING', 'One of ROW_STATES.', 'REQUIRED'),
    c('state_reason', 'STRING', ''),
    c('spreadsheet_id', 'STRING', '', 'REQUIRED'),
    c('budget_month', 'STRING', ''),
    c('month_start', 'DATE', 'Partition key.', 'REQUIRED'),
    c('category', 'STRING', "Normalized tab name, or '__salary__'."),
    c('budget_cents', 'INT64', 'Integer cents.'),
    c('derivation', 'STRING', 'One of BUDGET_DERIVATIONS. `raw_number` means do not trust it.'),
    c('formula_raw', 'STRING', 'The col-C cell verbatim, e.g. "=1200-B4".'),
    c('spent_cents_at_observation', 'INT64', 'Col B at the moment of reading — the audit trail for the inference.'),
    c('totals_row_num', 'INT64', '1-based Totals row.'),
    c('channel', 'STRING', ''),
    c('ingest_source', 'STRING', ''),
    c('actor_email', 'STRING', ''),
    c('source_action', 'STRING', ''),
  ],
};

/** One row per write attempt, so a failure is replayable and countable. */
const INGEST_ATTEMPTS = {
  name: 'ingest_attempts',
  partitionBy: 'DATE(attempt_at)',
  clusterBy: ['outcome', 'target_table'],
  columns: [
    c('ingest_id', 'STRING', '', 'REQUIRED'),
    c('attempt_at', 'TIMESTAMP', 'Partition key (by DATE).', 'REQUIRED'),
    c('target_table', 'STRING', '', 'REQUIRED'),
    c('outcome', 'STRING', "'applied' | 'duplicate_suppressed' | 'failed' | 'dead'.", 'REQUIRED'),
    c('attempt_number', 'INT64', ''),
    c('error_code', 'STRING', 'A code from the WHS domain in _error-codes.mjs.'),
    c('error_message', 'STRING', ''),
    c('idempotency_key', 'STRING', ''),
    c('channel', 'STRING', ''),
    c('actor_email', 'STRING', ''),
    c('raw_payload', 'STRING', 'JSON, capped at RAW_PAYLOAD_CAP. Never image bytes.'),
  ],
};

/** Append-on-change snapshots of the mutable config that feeds frozen fields. */
const CONFIG_SNAPSHOTS = {
  name: 'config_snapshots',
  partitionBy: 'DATE(captured_at)',
  clusterBy: ['config_kind'],
  columns: [
    c('content_hash', 'STRING', 'sha256 of the canonical JSON. What frozen columns point at.', 'REQUIRED'),
    c('config_kind', 'STRING', "'card_owners' | 'people' | 'user_settings' | 'categories'.", 'REQUIRED'),
    c('captured_at', 'TIMESTAMP', '', 'REQUIRED'),
    c('payload', 'STRING', 'Canonical JSON.'),
    c('actor_email', 'STRING', ''),
  ],
};

/** Month registry snapshots — spreadsheet ids rotate and nothing else records the old ones. */
const MONTH_DIM = {
  name: 'month_dim',
  partitionBy: 'DATE(captured_at)',
  clusterBy: ['budget_month'],
  columns: [
    c('budget_month', 'STRING', '', 'REQUIRED'),
    c('month_start', 'DATE', '', 'REQUIRED'),
    c('spreadsheet_id', 'STRING', '', 'REQUIRED'),
    c('schema_version', 'STRING', "'v1' | 'v2' — the SHEET layout, not the warehouse release."),
    c('captured_at', 'TIMESTAMP', '', 'REQUIRED'),
  ],
};

/** One row per verification check — pass OR fail. A gate that only records failures cannot prove it ran. */
const LOAD_AUDITS = {
  name: 'load_audits',
  partitionBy: 'DATE(checked_at)',
  clusterBy: ['passed', 'check_name'],
  columns: [
    c('audit_id', 'STRING', '', 'REQUIRED'),
    c('checked_at', 'TIMESTAMP', '', 'REQUIRED'),
    c('check_name', 'STRING', '', 'REQUIRED'),
    c('passed', 'BOOL', '', 'REQUIRED'),
    c('budget_month', 'STRING', ''),
    c('category', 'STRING', ''),
    c('expected', 'INT64', 'Integer cents or an integer count.'),
    c('actual', 'INT64', ''),
    c('detail', 'STRING', ''),
  ],
};

/** Phase 0: verbatim, uninterpreted capture. No modelling, no gates. */
const HISTORY_RAW = {
  name: 'history_raw',
  partitionBy: 'DATE(captured_at)',
  clusterBy: ['budget_month'],
  columns: [
    c('spreadsheet_id', 'STRING', '', 'REQUIRED'),
    c('budget_month', 'STRING', '', 'REQUIRED'),
    c('row_index', 'INT64', '1-based row in the History tab.', 'REQUIRED'),
    c('cells', 'STRING', 'JSON array of the raw cell strings, exactly as read.', 'REQUIRED'),
    c('row_hash', 'STRING', 'sha256 of (spreadsheet_id, row_index, cells) — makes re-runs idempotent.', 'REQUIRED'),
    c('captured_at', 'TIMESTAMP', '', 'REQUIRED'),
  ],
};

const SHEET_ROWS_RAW = {
  name: 'sheet_rows_raw',
  partitionBy: 'DATE(captured_at)',
  clusterBy: ['budget_month', 'tab'],
  columns: [
    c('spreadsheet_id', 'STRING', '', 'REQUIRED'),
    c('budget_month', 'STRING', '', 'REQUIRED'),
    c('tab', 'STRING', '', 'REQUIRED'),
    c('row_index', 'INT64', '', 'REQUIRED'),
    c('cells', 'STRING', 'JSON array of raw cell strings (FORMULA render).', 'REQUIRED'),
    c('row_hash', 'STRING', '', 'REQUIRED'),
    c('captured_at', 'TIMESTAMP', '', 'REQUIRED'),
  ],
};

export const TABLES = {
  transaction_versions: TRANSACTION_VERSIONS,
  budget_versions: BUDGET_VERSIONS,
  ingest_attempts: INGEST_ATTEMPTS,
  config_snapshots: CONFIG_SNAPSHOTS,
  month_dim: MONTH_DIM,
  load_audits: LOAD_AUDITS,
  history_raw: HISTORY_RAW,
  sheet_rows_raw: SHEET_ROWS_RAW,
};

/** Tables the backfill stages into before anything lands in the archive. */
export const STAGING_TABLES = ['transaction_versions', 'budget_versions'];

/** raw_payload is for replay, not for storage. Images never go near it. */
export const RAW_PAYLOAD_CAP = 32 * 1024;

/* ── Views ────────────────────────────────────────────────────────────────── */

/**
 * Named so the distinction cannot be got backwards:
 *
 *   v_transaction_versions  every version, with valid_to derived
 *   v_transaction_current   the latest version of each lineage — INCLUDING
 *                           deletions, because a deletion IS the current state
 *   v_transactions          the analytics surface: `erroneous` removed
 *
 * Analytics filters `row_state = 'valid'` on top of `v_transaction_current`.
 */
export function viewDefinitions(projectId) {
  const t = (name) => `\`${projectId}.${DATASET}.${name}\``;
  const v = (name) => `\`${projectId}.${DATASET}.${name}\``;

  return [
    {
      name: 'v_transaction_versions',
      sql: `
SELECT
  * EXCEPT(_rn),
  -- valid_to is DERIVED, never stored: storing it would mean UPDATEing the
  -- previous row when a new version arrives, which breaks append-only.
  LEAD(valid_from) OVER (
    PARTITION BY COALESCE(transaction_key, uuid, idempotency_key)
    ORDER BY valid_from, ingest_id
  ) AS valid_to
FROM (
  SELECT
    *,
    -- Duplicate DELIVERIES of the same event are recorded (append-only) and
    -- then ignored here. This is the read-time half of idempotency.
    ROW_NUMBER() OVER (
      PARTITION BY idempotency_key ORDER BY valid_from, ingest_id
    ) AS _rn
  FROM ${t('transaction_versions')}
)
WHERE _rn = 1`.trim(),
    },
    {
      name: 'v_transaction_current',
      sql: `
SELECT * FROM ${v('v_transaction_versions')}
WHERE valid_to IS NULL`.trim(),
    },
    {
      name: 'v_transactions',
      sql: `
SELECT * FROM ${v('v_transaction_current')}
WHERE row_state != 'erroneous'`.trim(),
    },
    {
      name: 'v_budget_versions',
      sql: `
SELECT
  * EXCEPT(_rn),
  LEAD(valid_from) OVER (
    PARTITION BY spreadsheet_id, category ORDER BY valid_from, ingest_id
  ) AS valid_to
FROM (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY idempotency_key ORDER BY valid_from, ingest_id
  ) AS _rn
  FROM ${t('budget_versions')}
)
WHERE _rn = 1`.trim(),
    },
    {
      name: 'v_budgets_current',
      sql: `
SELECT * FROM ${v('v_budget_versions')}
WHERE valid_to IS NULL AND row_state != 'erroneous'`.trim(),
    },
  ];
}

/* ── DDL ──────────────────────────────────────────────────────────────────── */

function columnDDL(col) {
  const notNull = col.mode === 'REQUIRED' ? ' NOT NULL' : '';
  const desc = col.doc ? ` OPTIONS(description=${sqlString(col.doc)})` : '';
  return `  ${col.name} ${col.type}${notNull}${desc}`;
}

function sqlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `CREATE TABLE IF NOT EXISTS` for one table, in the given dataset. */
export function tableDDL(projectId, table, dataset = DATASET) {
  const clauses = [];
  if (table.partitionBy) clauses.push(`PARTITION BY ${table.partitionBy}`);
  if (table.clusterBy?.length) clauses.push(`CLUSTER BY ${table.clusterBy.join(', ')}`);
  return [
    `CREATE TABLE IF NOT EXISTS \`${projectId}.${dataset}.${table.name}\` (`,
    table.columns.map(columnDDL).join(',\n'),
    ')',
    ...clauses,
  ].join('\n') + ';';
}

/**
 * Every statement needed to stand the warehouse up, in order.
 *
 * The dataset CREATEs deliberately set no `default_table_expiration_days` and
 * no `default_partition_expiration_days`. Either one silently deletes the
 * archive on a timer with no error anywhere — the monthly sweep asserts they
 * are still unset (see _warehouse-verify.mjs).
 */
export function setupDDL(projectId) {
  const out = [
    `CREATE SCHEMA IF NOT EXISTS \`${projectId}.${DATASET}\` OPTIONS(location=${sqlString(LOCATION)}, description=${sqlString('Fundient append-only archive. Sheets remains the source of truth.')});`,
    `CREATE SCHEMA IF NOT EXISTS \`${projectId}.${STAGING_DATASET}\` OPTIONS(location=${sqlString(LOCATION)}, description=${sqlString('Backfill staging. Truncatable; the archive dataset is not.')});`,
  ];
  for (const table of Object.values(TABLES)) out.push(tableDDL(projectId, table));
  for (const name of STAGING_TABLES) out.push(tableDDL(projectId, TABLES[name], STAGING_DATASET));
  for (const view of viewDefinitions(projectId)) {
    out.push(`CREATE OR REPLACE VIEW \`${projectId}.${DATASET}.${view.name}\` AS\n${view.sql};`);
  }
  return out;
}

/* ── Value encoding for the Storage Write API ─────────────────────────────── */

const MS_PER_DAY = 86_400_000;

/** DATE arrives at the proto as days since 1970-01-01. */
export function encodeDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).slice(0, 10);
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / MS_PER_DAY);
}

/** TIMESTAMP arrives at the proto as epoch MICROseconds. */
export function encodeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (Number.isNaN(ms)) return null;
  return ms * 1000;
}

/**
 * Coerce one row to what the Storage Write API's proto descriptor expects,
 * driven by the declared column types.
 *
 * Written as a table-driven function rather than per-call-site casts because
 * getting a DATE or TIMESTAMP wrong here does not throw — it writes a plausible
 * but wrong instant, which is unfixable in an append-only store.
 *
 * Unknown keys are dropped: a stray field would be rejected by the writer and
 * take the whole batch with it.
 */
export function encodeRow(table, row) {
  const out = {};
  for (const col of table.columns) {
    const raw = row[col.name];
    if (raw === undefined) continue;
    if (raw === null) { out[col.name] = null; continue; }
    switch (col.type) {
      case 'DATE':      out[col.name] = encodeDate(raw); break;
      case 'TIMESTAMP': out[col.name] = encodeTimestamp(raw); break;
      case 'INT64':     out[col.name] = Number.isFinite(Number(raw)) ? Math.trunc(Number(raw)) : null; break;
      case 'FLOAT64':   out[col.name] = Number.isFinite(Number(raw)) ? Number(raw) : null; break;
      case 'BOOL':      out[col.name] = Boolean(raw); break;
      default:          out[col.name] = String(raw); break;
    }
  }
  return out;
}

/**
 * Reject a row that violates a REQUIRED column before it reaches BigQuery.
 * Returns a list of problems (empty means fine) rather than throwing, so the
 * caller can record the row as a failed attempt instead of crashing a write
 * path the user is waiting on.
 */
export function validateRow(table, row) {
  const problems = [];
  for (const col of table.columns) {
    if (col.mode !== 'REQUIRED') continue;
    const v = row[col.name];
    if (v === null || v === undefined || v === '') problems.push(`${col.name} is required`);
  }
  for (const key of Object.keys(row)) {
    if (!table.columns.some(col => col.name === key)) problems.push(`unknown column ${key}`);
  }
  return problems;
}
