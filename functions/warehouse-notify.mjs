/**
 * Cloud Function — `/api/warehouse-notify`.
 *
 * The dashboard writes to Google Sheets **directly from the browser**, with the
 * user's own OAuth token: manual adds, receipt scans, statement imports, ledger
 * moves, edits, deletes, budgets. Only the wallet webhook, the Telegram bot and
 * MCP go through Cloud Functions. There is no single server-side write path,
 * and creating one would mean refactoring the most-used code in the app.
 *
 * So the frontend keeps writing Sheets exactly as it does today and then tells
 * this endpoint what it wrote. That is "notify-after", and it has one important
 * property: **a row that arrives here is client-ASSERTED, not proven.** It
 * lands with `ingest_source='notify'`, and the reconciler — which diffs the
 * actual spreadsheet — is what confirms it. Anything it can't confirm becomes
 * `erroneous`.
 *
 * Blast radius is therefore warehouse pollution only: this function cannot
 * touch Sheets, and pollution is convertible to `erroneous`. It still gets the
 * full treatment — verified bearer, CORS + sec-fetch-site, per-email rate
 * limit, and a spreadsheet id checked against the month registry.
 *
 * Modelled on push-subscribe.mjs rather than verify-user.mjs: it uses
 * `verifyBearer` and the VERIFIED email, never one claimed in the body.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getDb } from './lib/firestore.mjs';
import { createBotStore } from './lib/bot-store.mjs';
import { listMonths } from './lib/_sheets.mjs';
import { warehouseEnabled, mapTransactionEvent, mapBudgetEvent, flushRows } from './lib/_warehouse.mjs';
import { reportError } from './lib/_error-log.mjs';
import { withErrorContext, setActor, trail } from './lib/_error-context.mjs';
import { SHEETS_DRIVE_SECRETS, WAREHOUSE_SECRETS } from './lib/secrets.mjs';
import { randomUUID } from 'node:crypto';

/** One request carries a batch — a statement import writes dozens of rows at once. */
export const MAX_EVENTS_PER_REQUEST = 50;

/**
 * Per-email hourly ceiling on *events*, not requests.
 *
 * Sized well above any real session (the biggest statement import in the app's
 * history is a few hundred rows) and well below anything that could cost money.
 */
export const RATE_LIMIT_PER_HOUR = 2000;

/**
 * Validate a client-supplied spreadsheet id against the month registry.
 *
 * Cached per warm instance behind `listMonths`' own 5-minute TTL. Fails CLOSED:
 * if the registry can't be read we reject rather than trusting the client,
 * because the only cost of rejecting is that the reconciler picks the row up on
 * its next pass anyway.
 */
async function resolveMonth(spreadsheetId) {
  const months = await listMonths();
  return months.find(m => m.sheetId === spreadsheetId) || null;
}

/**
 * Turn the request body into warehouse rows.
 *
 * Exported and pure-ish (the month lookup is injected) so the validation rules
 * can be tested without a Cloud Function, a token, or Firestore.
 */
export function buildRows(events, { actorEmail, receivedAt, monthFor }) {
  const rows = [];
  const rejected = [];

  for (const event of events) {
    const spreadsheetId = event?.spreadsheetId;
    const month = spreadsheetId ? monthFor(spreadsheetId) : null;
    if (!month) {
      rejected.push({ reason: 'unknown_spreadsheet', spreadsheetId: spreadsheetId || null });
      continue;
    }

    const ctx = {
      ingestId: randomUUID(),
      // ALWAYS the server's clock. A phone five minutes fast would otherwise
      // make its write look like the newest version of a transaction someone
      // else edited afterwards, and "current state" would be wrong in a way no
      // query could detect. The client's own timestamp is kept separately, in
      // client_reported_at, where it can be inspected but never orders anything.
      validFrom: receivedAt,
      ingestSource: 'notify',
      actorEmail,
      channel: 'web',
    };

    // Trust the registry's month name over whatever the client sent.
    const base = { ...event, spreadsheetId, budgetMonth: month.monthName, channel: 'web' };

    switch (event?.eventType) {
      case 'transaction_write':
        rows.push({ table: 'transaction_versions', row: mapTransactionEvent({ ...base, rowState: 'valid' }, ctx) });
        break;
      case 'transaction_delete':
        rows.push({
          table: 'transaction_versions',
          row: mapTransactionEvent({ ...base, rowState: 'deleted', stateReason: base.stateReason || 'deleted_in_sheet' }, ctx),
        });
        break;
      case 'budget_write':
        rows.push({ table: 'budget_versions', row: mapBudgetEvent(base, ctx) });
        break;
      default:
        rejected.push({ reason: 'unknown_event_type', eventType: event?.eventType ?? null });
    }
  }

  return { rows, rejected };
}

export const warehouseNotify = onRequest(
  { region: 'us-central1', secrets: [...SHEETS_DRIVE_SECRETS, ...WAREHOUSE_SECRETS], cors: false, timeoutSeconds: 30 },
  async (req, res) => withErrorContext({ channel: 'web' }, async () => {
    const corsOrigin = corsOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.status(204).end();
      return;
    }

    if (!corsOrigin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    if (!hasValidSecFetchSite(req)) { sendJson(res, 403, { error: 'Forbidden' }, corsOrigin); return; }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }
    setActor(v.email);

    // Deployable before the dataset exists: with the flag off this is a
    // well-behaved no-op rather than a 500 the frontend has to special-case.
    if (!warehouseEnabled()) { sendJson(res, 200, { ok: true, disabled: true }, corsOrigin); return; }

    const events = Array.isArray(req.body?.events) ? req.body.events : null;
    if (!events || events.length === 0) { sendJson(res, 400, { error: 'No events' }, corsOrigin); return; }
    if (events.length > MAX_EVENTS_PER_REQUEST) {
      sendJson(res, 413, { error: `Too many events (max ${MAX_EVENTS_PER_REQUEST})` }, corsOrigin);
      return;
    }

    try {
      const store = createBotStore(getDb());
      const bucket = `whnotify:${v.email}:${new Date().toISOString().slice(0, 13)}`;
      const { allowed } = await store.incrementIfBelow(bucket, RATE_LIMIT_PER_HOUR);
      if (!allowed) { sendJson(res, 429, { error: 'Rate limited' }, corsOrigin); return; }
    } catch (e) {
      // A rate limiter that can't read its counter should not take the endpoint
      // down; the ceiling above it is the 50-event cap on this request.
      console.warn('warehouse-notify: rate limit check failed (allowing)', e?.message);
    }

    let months;
    try {
      months = await listMonths();
    } catch (e) {
      await reportError('WHS-008', e, { step: 'month registry read' });
      sendJson(res, 503, { error: 'Registry unavailable' }, corsOrigin);
      return;
    }
    const byId = new Map(months.map(m => [m.sheetId, m]));

    trail(`notify ${events.length} events`);
    const { rows, rejected } = buildRows(events, {
      actorEmail: v.email,
      receivedAt: new Date().toISOString(),
      monthFor: (id) => byId.get(id) || null,
    });

    if (rejected.length) {
      await reportError('WHS-008', new Error(rejected.map(r => r.reason).join(',')), {
        rejected: rejected.length, first: rejected[0].spreadsheetId || rejected[0].eventType,
      });
    }

    const result = await flushRows(rows, {
      ingestSource: 'notify',
      actorEmail: v.email,
      channel: 'web',
      // Nobody is waiting on this response the way they wait on a wallet charge,
      // and a queued row costs a cron cycle — so give the append room to land.
      timeoutMs: 10_000,
    });

    sendJson(res, 200, {
      ok: true,
      accepted: rows.length,
      rejected: rejected.length,
      written: result.written,
      queued: result.queued,
    }, corsOrigin);
  })
);
