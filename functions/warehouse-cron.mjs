/**
 * Cloud Function — the warehouse's one scheduled job.
 *
 * ── Why one job and not two ───────────────────────────────────────────────
 *
 * Cloud Scheduler gives three jobs free; `categoryAudit` and `errorDigest`
 * already use two. Draining the outbox and reconciling are genuinely separate
 * concerns, but giving each its own schedule would be a fourth job at roughly
 * $0.10/month — which is not much money, and is exactly the kind of drift that
 * turns "$0" into "nearly $0" and then into a bill nobody reviews. So they
 * share a tick. **If a future feature needs a schedule, fold it in here rather
 * than adding a job.**
 *
 * `drainOutbox()` and `runReconcile()` stay separate exported functions in
 * separate modules, testable in isolation; only this wrapper is shared.
 *
 * ── Two deployment traps, both previously hit by this project ─────────────
 *
 * 1. Deploying a scheduled function needs BOTH cloudscheduler.googleapis.com
 *    enabled AND roles/cloudscheduler.admin on the deploying principal
 *    (github-ci-deploy). Without the role the function deploys fine, goes
 *    ACTIVE, and its Scheduler job is never created — it simply never fires,
 *    which looks identical to "working".
 * 2. Every environment variable the handler reads must be in `secrets`. errorDigest
 *    shipped reading ALLOWED_EMAILS without binding it and was silently inert
 *    for weeks. `functionSecrets.test.js` and `warehouseSecrets.test.js` guard
 *    both halves of that.
 *
 * The handler try/catches everything and only `console.error`s. A throw here
 * makes Cloud Scheduler retry the whole tick, including the reconciler — the
 * expensive half, and the one that reads every category tab of two months.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { __clearSheetCaches } from './lib/_sheets.mjs';
import { drainOutbox } from './lib/_warehouse-drain.mjs';
import { runReconcile } from './lib/_warehouse-reconcile.mjs';
import { warehouseEnabled } from './lib/_warehouse.mjs';
import { SHEETS_DRIVE_SECRETS, WAREHOUSE_SECRETS } from './lib/secrets.mjs';

/**
 * Core tick, exported separately from the schedule wrapper so it can be tested
 * without standing up Cloud Scheduler.
 */
export async function runWarehouseCron() {
  // Month ids cache for 5 minutes and settings for 60 seconds. A scheduled run
  // has no warm-instance benefit to lose and every reason to see the current
  // registry, so start cold.
  __clearSheetCaches();

  if (!warehouseEnabled()) {
    console.log('warehouse-cron: WAREHOUSE_ENABLED is not "true"; nothing to do');
    return { disabled: true };
  }

  // Drain first: a reconcile that runs before the outbox is emptied would see
  // queued-but-unwritten rows as missing from the warehouse and re-emit them.
  // Harmless (the view dedupes on idempotency_key) but noisy in the logs and
  // in `state_reason`, where 'missed_notify' would stop meaning what it says.
  let drain = null;
  try {
    drain = await drainOutbox();
  } catch (e) {
    console.error('warehouse-cron: drain failed', e?.message);
  }

  let reconcile = null;
  try {
    reconcile = await runReconcile();
  } catch (e) {
    console.error('warehouse-cron: reconcile failed', e?.message);
  }

  return { drain, reconcile };
}

export const warehouseCron = onSchedule(
  {
    // Every 15 minutes. The hot path already writes live, so this is the
    // catch-up pass, not the delivery mechanism.
    schedule: 'every 15 minutes',
    timeZone: 'America/Los_Angeles',
    region: 'us-central1',
    secrets: [...SHEETS_DRIVE_SECRETS, ...WAREHOUSE_SECRETS],
    // Reading two months of category tabs is the slow part; 540s is the v2 cap
    // for an event function and this should never come close.
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    try {
      const res = await runWarehouseCron();
      console.log('warehouse-cron:', JSON.stringify(res));
    } catch (e) {
      // Never rethrow: Scheduler would retry the whole tick.
      console.error('warehouse-cron: run failed', e?.message);
    }
  }
);
