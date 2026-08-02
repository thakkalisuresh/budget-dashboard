#!/usr/bin/env node
/**
 * Stand up (or re-print) the BigQuery warehouse.
 *
 * The DDL is GENERATED from functions/lib/_warehouse-schema.mjs, so the tables
 * can never drift from the definitions the ingest encodes against.
 *
 *   node scripts/warehouse-setup.mjs --print              show the SQL, change nothing
 *   node scripts/warehouse-setup.mjs --apply --project=X  run it with the bq CLI
 *   node scripts/warehouse-setup.mjs --guardrails         print the $0 setup commands
 *
 * `--apply` shells out to `bq query` rather than using the Node client on
 * purpose: creating datasets and tables should be a deliberate act by a human
 * with admin credentials, not something a deployed function can do. The
 * functions' service account is granted a custom role with NO create, update or
 * delete rights — see --guardrails — which is the only thing that makes
 * "append-only" a mechanism rather than a policy.
 */
import { execFileSync } from 'node:child_process';
import { setupDDL, DATASET, STAGING_DATASET } from '../functions/lib/_warehouse-schema.mjs';

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const val = (name) => args.find(a => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const project = val('project') || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;

/**
 * The commands that make "$0" enforced rather than hoped for.
 *
 * The project is on Blaze because Cloud Functions requires it, so $0 means
 * "inside the free tier", not "cannot be billed". Each of these is free to set
 * and closes one specific way the bill could start moving.
 */
function guardrails(p) {
  return `
# ── 1. Custom IAM role: append-only as a MECHANISM, not a policy ────────────
#
# roles/bigquery.dataEditor includes tables.delete — with it, the functions'
# service account could drop the archive. This role can append and read and
# nothing else. Table creation stays with a human admin identity.

gcloud iam roles create fundientWarehouseAppender --project=${p} \\
  --title="Fundient warehouse appender" \\
  --description="Append and read only. No create, update or delete." \\
  --permissions=bigquery.tables.get,bigquery.tables.getData,bigquery.tables.updateData,bigquery.jobs.create \\
  --stage=GA

# Bind it at the DATASET, not the project, so it cannot reach anything else.
bq add-iam-policy-binding \\
  --member="serviceAccount:${p}@appspot.gserviceaccount.com" \\
  --role="projects/${p}/roles/fundientWarehouseAppender" \\
  ${p}:${DATASET}

# ── 2. A query quota: the only guard against one bad dashboard query ────────
#
# The monthly free tier is 1 TiB. A single unpartitioned scan written in a hurry
# can eat a meaningful slice of it. This is a hard stop and costs nothing.

gcloud alpha services quota update \\
  --service=bigquery.googleapis.com \\
  --consumer=projects/${p} \\
  --metric=bigquery.googleapis.com/quota/query/usage \\
  --unit=1/d/{project} --value=5368709120        # 5 GiB/day

# ── 3. A $1 billing alert ───────────────────────────────────────────────────
#
# Not a limit — a tripwire. Anything that makes this fire is drift worth
# understanding, and an email beats discovering it on a statement.
# Console: Billing → Budgets & alerts → Create budget → scope to this project,
#          amount $1, alert at 100%.

# ── 4. Assert no expiration timer, forever ──────────────────────────────────
#
# defaultTableExpiration or defaultPartitionExpiration silently deletes the
# archive on a schedule, with no error anywhere. The warehouse cron re-checks
# this, but set it explicitly to zero now.

bq update --default_table_expiration 0 --default_partition_expiration 0 ${p}:${DATASET}
bq update --default_table_expiration 0 --default_partition_expiration 0 ${p}:${STAGING_DATASET}

# ── 5. Turn the ingest on ───────────────────────────────────────────────────
#
# Everything above deploys as a no-op until this is "true".

firebase functions:secrets:set WAREHOUSE_ENABLED     # value: true
`.trimStart();
}

if (has('--guardrails')) {
  if (!project) { console.error('Need --project=<id> (or GOOGLE_CLOUD_PROJECT).'); process.exit(1); }
  console.log(guardrails(project));
  process.exit(0);
}

if (!project) {
  console.error('Need --project=<id> (or GOOGLE_CLOUD_PROJECT set).');
  process.exit(1);
}

const statements = setupDDL(project);

if (has('--apply')) {
  console.error(`Applying ${statements.length} statements to ${project}…`);
  for (const sql of statements) {
    const first = sql.split('\n')[0].slice(0, 90);
    console.error(`  ${first}`);
    execFileSync('bq', ['query', '--use_legacy_sql=false', '--project_id', project, sql], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  }
  console.error('\nDone. Now run with --guardrails and work through that list — the IAM');
  console.error('role in particular is what makes append-only real rather than aspirational.');
} else {
  console.log(statements.join('\n\n'));
  if (!has('--print')) {
    console.error('\n(Nothing was applied. Re-run with --apply to execute, or --guardrails');
    console.error(' for the IAM, quota and billing-alert setup.)');
  }
}
