/**
 * Drain the warehouse failure queue.
 *
 * The Firestore outbox is NOT the normal path — the hot path writes straight to
 * BigQuery via the Storage Write API and is visible in seconds. Rows only land
 * here when that append errors or blows its 1.5s hot-path ceiling. This drains
 * them on the cron tick.
 *
 * Two properties matter:
 *
 *  • **Retrying is safe.** Dedup happens at read time, in the view, keyed on
 *    `idempotency_key`. A row written twice is recorded twice (append-only
 *    means recorded) and collapsed by `QUALIFY ROW_NUMBER() … = 1`. So a
 *    partial success followed by a full retry costs storage, not correctness.
 *
 *  • **It gives up.** After MAX_OUTBOX_ATTEMPTS an entry is marked `dead`
 *    rather than retried forever. Dead entries stop consuming the tick and
 *    surface through the existing Telegram error digest as WHS-004, which is
 *    the difference between "the archive is behind" and "the archive is behind
 *    and nobody knows".
 */
import { getDb } from './firestore.mjs';
import { reportError } from './_error-log.mjs';
import { DATASET, TABLES, encodeRow } from './_warehouse-schema.mjs';
import {
  OUTBOX_COLLECTION, MAX_OUTBOX_ATTEMPTS, warehouseEnabled, recordAttempt,
} from './_warehouse.mjs';

/** Cap the work per tick so one bad night can't run the function out of time. */
export const DRAIN_BATCH = 100;

/**
 * Retry queued writes.
 *
 * Never throws: this runs inside `onSchedule`, and a throw there makes Cloud
 * Scheduler retry the whole tick — including the reconciler, which is the
 * expensive half.
 */
export async function drainOutbox({ limit = DRAIN_BATCH } = {}) {
  if (!warehouseEnabled()) return { drained: 0, rows: 0, dead: 0, reason: 'disabled' };

  let snap;
  try {
    snap = await getDb().collection(OUTBOX_COLLECTION)
      .where('dead', '==', false)
      .limit(limit)
      .get();
  } catch (e) {
    console.error('warehouse-drain: could not read the outbox', e?.message);
    return { drained: 0, rows: 0, dead: 0, reason: 'read_failed' };
  }

  if (snap.empty) return { drained: 0, rows: 0, dead: 0 };

  const { appendRows } = await import('./_warehouse-client.mjs');
  let drained = 0;
  let rowCount = 0;
  let dead = 0;

  for (const doc of snap.docs) {
    const entry = doc.data();
    const def = TABLES[entry.table];
    if (!def) {
      // Unknown table means the schema changed under a queued entry. Retrying
      // cannot fix that, so dead-letter it immediately rather than eight times.
      await markDead(doc, 'unknown table');
      dead++;
      continue;
    }

    try {
      // Encoded at drain time, not at enqueue time: a schema change between the
      // failure and this retry would otherwise make the queued payload
      // unwritable, and this is the queue that exists for the bad days.
      await appendRows(DATASET, entry.table, (entry.rows || []).map(r => encodeRow(def, r)));
      await doc.ref.delete();
      drained++;
      rowCount += (entry.rows || []).length;
      await recordAttempt({
        targetTable: entry.table,
        outcome: 'applied',
        attemptNumber: (entry.attempts || 0) + 1,
        channel: entry.channel || null,
        actorEmail: entry.actorEmail || null,
      });
    } catch (e) {
      const attempts = (entry.attempts || 0) + 1;
      if (attempts >= MAX_OUTBOX_ATTEMPTS) {
        await markDead(doc, e?.message);
        dead++;
        await reportError('WHS-004', e, { table: entry.table, attempts, rows: (entry.rows || []).length });
        await recordAttempt({
          targetTable: entry.table, outcome: 'dead', attemptNumber: attempts,
          errorCode: 'WHS-004', errorMessage: e?.message,
          channel: entry.channel || null, actorEmail: entry.actorEmail || null,
          rawPayload: entry.rows,
        });
      } else {
        await doc.ref.update({
          attempts,
          lastError: String(e?.message || e).slice(0, 500),
          lastAttemptAt: new Date().toISOString(),
        }).catch(() => {});
        await recordAttempt({
          targetTable: entry.table, outcome: 'failed', attemptNumber: attempts,
          errorCode: 'WHS-001', errorMessage: e?.message,
          channel: entry.channel || null, actorEmail: entry.actorEmail || null,
        });
      }
    }
  }

  if (drained || dead) console.log(`warehouse-drain: ${drained} entries (${rowCount} rows) drained, ${dead} dead`);
  return { drained, rows: rowCount, dead };
}

async function markDead(doc, message) {
  await doc.ref.update({
    dead: true,
    lastError: String(message || 'unknown').slice(0, 500),
    diedAt: new Date().toISOString(),
  }).catch(() => {});
}
