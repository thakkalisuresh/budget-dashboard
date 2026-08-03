# BigQuery warehouse

An append-only archive beside Google Sheets, plus SQL for cross-month analysis.

**Sheets remains the source of truth, permanently. Hand-editing must keep
working.** The warehouse is derived and rebuildable — with one exception, which
is the whole reason it exists.

## Why

1. **A permanent record.** Deletes in Sheets are physical (`deleteDimension`),
   so a removed transaction is simply gone. There is no record of what the
   budget *used to* say.
2. **Cross-month analytics.** "Spend by vendor across ten months" today means
   reading ten spreadsheets and dozens of API calls, and it gets linearly worse
   every month.

The measured scale is about 82 transactions/month — the archive starts at 164
rows. The complexity here comes from the *requirements* (append-only,
bitemporal, provenance, reconciliation against a mutable source), not from the
volume. It is worth building now because an archive only becomes valuable years
from now, which is exactly when starting late is unrecoverable.

## Five rules

1. **Append-only.** Never UPDATE, never DELETE, never MERGE on the fact tables.
   Bitemporal: system time (`valid_from`) plus wall-clock valid time
   (`budget_date`). There is deliberately **no `valid_to` column** — closing a
   version would be an update. It is derived in the view with `LEAD()`.
2. **Three row states**, not two. `valid`, `deleted` (was real, removed), and
   `erroneous` (never should have existed). Analytics excludes `erroneous` and
   counts `deleted` historically.
3. **Freeze derived values at write time.** Card→owner, FX rate, LLM
   category/confidence/model — all computed from mutable config, so all stored
   rather than recomputed. A settings change must never silently rewrite
   history.
4. **Sheets first, DB second, always.** A warehouse row for a Sheets write that
   failed is a phantom in a store that never deletes.
5. **Two field classes.** *Mirrored* fields map to a spreadsheet cell.
   *Derived* fields are DB-only and may never change the meaning of a mirrored
   one. The test: drop the warehouse, rebuild from Sheets, and no budget number
   changes.

## Architecture

```
  Sheets (source of truth)
      ▲                    ▲
      │ writes             │ writes (browser, user's own OAuth token)
      │                    │
 Cloud Functions      Dashboard (src/)
 wallet │ bot │ mcp        │
      │                    │ POST /api/warehouse-notify  (best-effort, keepalive)
      ▼                    ▼
   functions/lib/_warehouse.mjs
      │  (awaited, 1.5s ceiling, never throws)
      ▼
   BigQuery Storage Write API  ──► fundient_warehouse   ← LIVE, queryable in seconds
      │                                    ▲
      │ on failure                         │
      ▼                                    │
   Firestore warehouse_outbox              │  warehouseCron (ONE job, every 15 min)
      (failure queue only)  ───────────────┤    • drainOutbox()   retries failures
                                           │    • runReconcile()  diffs Sheets↔DB
                                           └── Sheets
```

**Write live, queue only on failure.** The Storage Write API's default stream is
the normal path; writes are visible in seconds. The Firestore outbox is the
*failure queue*, drained by the cron.

**Idempotency without an anti-join.** Dedup happens at **read time** in the
view: `QUALIFY ROW_NUMBER() OVER (PARTITION BY idempotency_key …) = 1`. This is
more faithful to append-only than suppressing at write time — a duplicate
delivery is recorded, then ignored.

**On "fire and forget":** a Cloud Function can freeze the moment it returns, so
an un-awaited promise may never run (a lesson `functions/lib/_error-log.mjs`
already records). Warehouse calls are *awaited with a hard timeout and a
swallowed error*: they land, they can't add seconds to the wallet path, and they
can never fail the user's write.

## Cost — how this stays at exactly $0

| Component | Usage at measured scale | Free tier | Cost |
|---|---|---|---|
| BigQuery storage | <1 MB; tens of MB in 10 years | 10 GiB/mo | $0 |
| BigQuery queries | KB per query | 1 TiB/mo | $0 |
| BigQuery **Storage Write API** | ~0.1 MB/mo | **2 TiB/mo** | $0 |
| BigQuery **`insertAll`** | **not used — see below** | none | *avoided* |
| Firestore outbox | failures only, drained | 20k writes/day | $0 |
| Cloud Functions invocations | ~3k/mo (cron) + user traffic | 2M/mo | $0 |
| **Cloud Scheduler** | **3 jobs total** (2 existing + 1 new) | **3 jobs** | **$0** |

Two things carry the whole guarantee:

1. **Never `insertAll`.** The legacy streaming API is $0.05/GB with a **1 KB
   minimum billed per row** and no free tier. The Storage Write API is a
   *different product* with a 2 TiB/month free tier. They live in the same
   client library and `table().insert()` is the ergonomic one — which is exactly
   how this design would accidentally start costing money.
   `warehouseSecrets.test.js` fails if any warehouse module calls either.
2. **Never exceed 3 scheduler jobs.** Beyond 3 it is ~$0.10/job/month. Hence one
   `warehouseCron` rather than separate drain and reconcile jobs. **If a future
   feature needs a schedule, fold it into `warehouseCron`.**

Guardrails so "$0" is enforced rather than hoped for — see
`node scripts/warehouse-setup.mjs --guardrails`:

- A project-level BigQuery **custom query quota** (~5 GiB/day). Free, a hard
  stop, and the only defence against one bad dashboard query eating the monthly
  1 TiB.
- A **billing budget alert at $1**. The project is on Blaze because Functions
  requires it, so $0 means "inside the free tier", not "cannot be billed".
- The cron asserts the dataset carries no default expiration. A silent-deletion
  timer deserves an alarm, not a comment.

## Schema

Dataset `fundient_warehouse` (US). Staging lives in a **separate**
`fundient_staging` dataset so the archive dataset never needs to grant delete
rights.

> **Two dataset settings are load-bearing:** `defaultTableExpirationMs` and
> `defaultPartitionExpirationMs` must be explicitly unset. Either one silently
> deletes the archive on a timer, with no error anywhere. Error code `WHS-007`.

Everything is generated from `functions/lib/_warehouse-schema.mjs`:

```bash
node scripts/warehouse-setup.mjs --project=fundient-dashboard --print
```

| Table | Grain |
|---|---|
| `transaction_versions` | one row per *observed version* of a logical transaction |
| `budget_versions` | budgets and salary (`category = '__salary__'`) |
| `ingest_attempts` | one row per write attempt — `applied`/`duplicate_suppressed`/`failed`/`dead` |
| `config_snapshots` | append-on-change snapshots of the config that feeds frozen fields |
| `month_dim` | month → spreadsheet id, because ids rotate and nothing else records the old ones |
| `load_audits` | one row per verification check, **pass or fail** |
| `history_raw`, `sheet_rows_raw` | Phase 0 verbatim capture |

**Money is `INT64` cents.** Every verification gate is an exact integer
comparison; float cents is how those gates quietly stop working.

**`transaction_key`** is the first-ever uuid of a lineage, carried by **explicit
declaration only**. Edits are delete + re-append with a *new* uuid, so uuid is
not a stable identity — but **analytics correctness does not depend on
lineage**. Net spend is right as long as each version's validity window is
right; lineage only buys "the history of this one transaction". *The reconciler
never infers lineage heuristically, and nobody should add fuzzy auto-linking
later.*

**Budgets are not stored as a value anywhere.** `Totals!C` holds a *formula*
`=<budget>-B<row>`; the literal exists only inside that string. Read col C at
`FORMULA` render, never `UNFORMATTED_VALUE`. `budget_versions.derivation`
records which of `formula_literal` / `spent_plus_remaining` / `raw_number` /
`salary_literal` produced the number. `raw_number` means the old NewMonthDialog
bug — flag it, never trust it.

### Views

```sql
v_transaction_versions   -- every version, valid_to derived via LEAD()
v_transaction_current    -- valid_to IS NULL  (INCLUDES deleted: a deletion IS current state)
v_transactions           -- row_state != 'erroneous'   ← the analytics surface
```

Analytics filters `row_state = 'valid'` on top of `v_transaction_current`. The
names are chosen so this cannot be got backwards.

## Where the hooks are, and why

**Inside the two write chokepoints, not at the ~34 call sites.**

- **Backend:** six insertion points in `functions/lib/_sheets.mjs`
  (`appendExpense`, `deleteExpenseByUUID`, `writeBudgetAmount`,
  `writeSalaryAmount`, `addCategory`, `createMonth`). Each sits physically
  *after* the successful `sheetsRequest`, so "Sheets first, DB second" is
  enforced by control flow rather than by discipline.
- **Frontend:** inside `src/sheetExpenses.js`, `src/sheetTotals.js`,
  `src/sheetUndo.js`, `src/duplicateScan.js` — not at the UI call sites. This
  covers the offline-queue replay path with **zero** call-site changes, since
  `useOfflineSync → offlineReplay → sheetExpenses`.

### Adding a new way to record a transaction

The normal case is: build the feature, ignore the warehouse, and it shows up.

- A **new backend feature** calls `appendExpense`. That is the only server-side
  way to write an expense. **Zero warehouse work.**
- A **new frontend feature** calls `addOrUpdateExpense`. Same. **Zero warehouse
  work.**

Three escalating safety nets for the abnormal case — a feature that calls the
Sheets API directly:

1. **An ESLint rule** bans `sheets.googleapis.com` outside `src/sheetApi.js`,
   `functions/lib/_sheets.mjs` and two documented read-only exceptions.
2. **The reconciler catches it anyway.** It diffs the *actual sheet*, so a row
   written by an unhooked path is picked up on the next pass with
   `state_reason='missed_notify'`. Worst case is latency, not data loss. **No
   new write path can permanently escape the warehouse.**
3. **Unhooked paths are visible.** A steady trickle of `missed_notify` for a
   channel that should be hooked means something is bypassing the chokepoint.

### Adding a new field

Three steps, and only the last one can break things:

1. Add a **nullable** BigQuery column. Append-only means old rows can never gain
   a value, so every new column is nullable forever.
2. If it adds a spreadsheet column, update the header contract in
   `_warehouse-verify.mjs` so drift detection expects the new shape rather than
   aborting.
3. Decide whether it is **mirrored** (goes in the idempotency key, write-through
   to Sheets) or **derived** (DB-only, excluded from the key). *A derived field
   inside the idempotency key mints spurious versions* — a Groq model bump would
   create a new version of every transaction nobody touched.

## Verification

Backfill gates, all in integer cents, all recorded to `load_audits`, all run
against the snapshot before anything lands:

| Gate | Assertion |
|---|---|
| `category_sum` | per (month, category), `SUM(amount_cents)` **==** `Totals!B` × 100, exactly |
| `row_count` | staged rows **==** non-empty data rows read |
| `distinct_uuid` | `COUNT(DISTINCT uuid) == COUNT(*)` — a dupe is a real problem (a half-failed `moveTransactionCategory`), so alarm, don't dedupe |
| `month_sum` | month total **==** `SUM(Totals!B)` over the *same* categories (skipped tabs excluded from both sides) |
| `uuid_format` | matches `/^tx_\d+_[0-9a-f]{8}$/` |
| `amount_uuid_match` | cents in the uuid equal `amount_cents` — recorded, **not fatal** (in-place edits legitimately break it) |
| `header_contract` | the tab matches the V2 shape — recorded, **not fatal**; a custom-category tab is skipped and excluded from `month_sum` |

`verifyMonth()` is a **pure** function, so `warehouseVerify.test.js` runs it
against a golden fixture plus one-at-a-time mutations — a dropped row, an amount
off by one cent, a duplicated uuid, a row in the wrong category — and asserts
each fails with the *specific* expected `check_name`. This has to be a unit
test: an integration-only gate test is one that never actually runs.

## Setup

```bash
# 1. Look at the DDL. It is generated from _warehouse-schema.mjs.
node scripts/warehouse-setup.mjs --project=fundient-dashboard --print

# 2. Create the datasets, tables and views (needs bq + admin credentials).
node scripts/warehouse-setup.mjs --project=fundient-dashboard --apply

# 3. Work through the IAM role, query quota, billing alert and expiration
#    settings. The custom role is what makes append-only a mechanism.
node scripts/warehouse-setup.mjs --project=fundient-dashboard --guardrails

# 4. Turn it on. Until this is "true", every entry point is a no-op.
firebase functions:secrets:set WAREHOUSE_ENABLED     # value: true
```

Then, in order:

```bash
# Phase 0 — the irreplaceable part. Do this FIRST. Includes V1 months.
curl -X POST https://fundient-dashboard.web.app/api/warehouse-backfill \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"raw"}'

# Phase 2 — model the V2 months. Dry-run first: it runs every gate and writes
# load_audits without loading anything.
curl -X POST .../api/warehouse-backfill -d '{"mode":"load","dryRun":true}'
curl -X POST .../api/warehouse-backfill -d '{"mode":"load"}'
```

> **Deployment trap:** a scheduled function needs BOTH
> `cloudscheduler.googleapis.com` enabled AND `roles/cloudscheduler.admin` on
> the deploying principal. Without the role `warehouseCron` deploys fine, goes
> ACTIVE, and its Scheduler job is never created — it simply never fires, which
> looks identical to working.

## Scope: what is deliberately not here

**The modelled archive starts June 2026.** Phase 0 captures October 2025 – May
2026 verbatim so nothing is lost, but those months are not modelled. They are
sheet-schema V1:

| Metric | Value |
|---|---|
| Vendor rows | 435 |
| Individual charges (after splitting `=a+b`) | 592 |
| **Rows with no UUID** | **402 of 435 (92%)** |
| Distinct header shapes | **13** |

Two blockers, one not solvable by code:

1. **There is no Date column in V1 at all.** Headers are
   `Month | Year | <label> | Amount`. Month precision only. No parser recovers a
   day that was never recorded — though the existing `ReconcileDialog`
   statement-import tooling could recover real dates from card statements.
2. **Header chaos:** `Vendor`, `Grocer`, `Investor`, `Utility Bill`,
   `Food Vendor|Total`, `Activity`, a typo'd `Furntirue`, and six tabs shaped
   `Month|Year|Vendor|Amount|||||Month|Year` — apparently a second table pasted
   into the same tab. Those need human eyes before any parser runs.

**The recommendation is to clean the old months into the V2 sheet shape** — a
`Date` column, one row per charge, a `UUID` column. That cleaning is happening
by hand regardless, and doing it this way means Release 2 needs **no new code at
all**: same loader, same header contract, same gates.

`date_precision` exists from day one for this reason. Without it a spend-by-day
chart would silently drop all 592 legacy charges onto the 1st of each month and
look entirely plausible. Adding the column later means backfilling an
append-only table, which is a contradiction.

Also deferred: Invest/HYSA (separate spreadsheet, unmerged branch), receipt line
items (transient today — forward-only capture required), and a general SQL query
page.

## Error codes

`WHS-001` … `WHS-009`, catalogued in [ERROR_CODES.md](ERROR_CODES.md). Nothing
in the domain is `fatal`: the warehouse is written strictly *after* the
spreadsheet, so a failure costs the archive a row, not the user their
transaction — and the reconciler re-emits it on the next pass.
