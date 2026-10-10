/**
 * Cloud Functions — monthly AMC holdings for the household's Indian mutual funds
 * (Invest tab, Phase 2 portfolio health).
 *
 *  mfHoldingsRefresh  scheduled, 02:00 IST on days 8-12 of each month. Targets
 *                     the previous month-end; each fund house that already has
 *                     that month stored is skipped, the rest are retried daily
 *                     until the 12th. One house failing never blocks the others.
 *  mfHoldings         authenticated on-demand endpoint (same auth stack as
 *                     /api/mf-nav). POST /api/mf-holdings
 *                       { action: 'status' }
 *                       { action: 'refresh', asOf?, houses?, force?, itiUrl? }
 *                     `asOf` backfills a month-end (≤ 3 months back); `itiUrl` is
 *                     this month's ITI file link (ITI's listing is encrypted, so
 *                     that house is semi-manual — see lib/mf-holdings/iti.mjs).
 *
 * Output: Invest sheet tabs MfHoldings + MfHoldingsStatus (contract documented in
 * lib/_mf-holdings.mjs and docs/INVEST.md). Failures keep the previous month's
 * rows and are recorded per fund; they are also logged via reportError (INV-001
 * with a `stage` tag — no new error code, no Telegram/push).
 *
 * Secrets: the same Sheets/Drive bundle every Invest function uses. No new
 * secret or param (the User-Agent is a constant), so non-interactive deploys are
 * unaffected.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { SHEETS_DRIVE_SECRETS } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getInvestSheetId, ensureInvestTabsServer, readInvestTabs, replaceInvestRows } from './lib/_invest-sheets.mjs';
import { reportError } from './lib/_error-log.mjs';
import {
  HOUSES, HOLDINGS_COLUMNS, STATUS_COLUMNS, inRunWindow, targetAsOf, validateAsOf, runMfHoldings,
  holdingsToValues, valuesToHoldings, statusToValues, valuesToStatus,
} from './lib/_mf-holdings.mjs';
import { ABSL } from './lib/mf-holdings/absl.mjs';
import { SBI } from './lib/mf-holdings/sbi.mjs';
import { ITI } from './lib/mf-holdings/iti.mjs';

const IMPL = { absl: ABSL, sbi: SBI, iti: ITI };
const HOLDINGS_TAB = 'MfHoldings';
const STATUS_TAB = 'MfHoldingsStatus';
/** ~7 funds x ~150 lines x 2 months fits well inside this. */
const MAX_HOLDINGS_ROWS = 5000;
const MAX_STATUS_ROWS = 100;

/** Sheets-backed io for runMfHoldings (creates the two tabs if the sheet predates them). */
export function sheetsIo(sheetId) {
  return {
    async read() {
      await ensureInvestTabsServer(sheetId, { [HOLDINGS_TAB]: HOLDINGS_COLUMNS, [STATUS_TAB]: STATUS_COLUMNS });
      const [h, s] = await readInvestTabs(sheetId, [
        { title: HOLDINGS_TAB, width: HOLDINGS_COLUMNS.length, maxRows: MAX_HOLDINGS_ROWS },
        { title: STATUS_TAB, width: STATUS_COLUMNS.length, maxRows: MAX_STATUS_ROWS },
      ]);
      return { holdings: valuesToHoldings(h), status: valuesToStatus(s) };
    },
    async write({ holdings, status }) {
      // Holdings first: if the status write then fails, the data is still the newest.
      await replaceInvestRows(sheetId, HOLDINGS_TAB, HOLDINGS_COLUMNS.length, holdingsToValues(holdings), MAX_HOLDINGS_ROWS);
      await replaceInvestRows(sheetId, STATUS_TAB, STATUS_COLUMNS.length, statusToValues(status), MAX_STATUS_ROWS);
    },
  };
}

/** Report houses that genuinely failed (not "not published yet"), tagged with the stage. */
async function reportFailures(result) {
  for (const [house, h] of Object.entries(result.houses)) {
    if (h.status !== 'failed' && h.status !== 'partial') continue;
    const reasons = h.reason || Object.entries(h.funds || {}).filter(([, s]) => s !== 'ok').map(([k, s]) => `${k}:${s}`).join(', ');
    await reportError('INV-001', new Error(`mf-holdings ${house} ${h.status} for ${result.target}: ${reasons}`), { stage: 'mf-holdings', house });
  }
}

export async function runMonthlyHoldings({ now = new Date(), io, impl = IMPL } = {}) {
  const sheetId = io ? 'injected' : await getInvestSheetId();
  if (!sheetId) { console.warn('mf-holdings: no invest sheet provisioned; skipping'); return { ran: false, reason: 'no_invest_sheet' }; }
  const result = await runMfHoldings({ io: io || sheetsIo(sheetId), impl, now });
  await reportFailures(result);
  console.log('mf-holdings: run', JSON.stringify(result));
  return { ran: true, ...result };
}

export const mfHoldingsRefresh = onSchedule(
  {
    schedule: '0 2 8-12 * *',
    timeZone: 'Asia/Kolkata',
    region: 'us-central1',
    secrets: [...SHEETS_DRIVE_SECRETS],
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '1GiB',
  },
  async () => {
    const now = new Date();
    if (!inRunWindow(now)) { console.log('mf-holdings: outside the day 8-12 window; skipping'); return; }
    try {
      await runMonthlyHoldings({ now });
    } catch (e) {
      console.error('mf-holdings: run failed', e?.message);
      await reportError('INV-001', e, { stage: 'mf-holdings-run' });
    }
  }
);

let running = false;

export const mfHoldings = onRequest(
  { region: 'us-central1', secrets: [...SHEETS_DRIVE_SECRETS], maxInstances: 1, timeoutSeconds: 300, memory: '1GiB', cors: false },
  async (req, res) => {
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

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const bad = (error) => sendJson(res, 400, { error }, corsOrigin);
    const now = new Date();

    try {
      const sheetId = await getInvestSheetId();
      if (!sheetId) return sendJson(res, 409, { error: 'No Invest sheet provisioned yet — open the Invest tab once' }, corsOrigin);
      const io = sheetsIo(sheetId);

      switch (body.action) {
        case 'status': {
          const { status } = await io.read();
          return sendJson(res, 200, { action: 'status', target: targetAsOf(now), status }, corsOrigin);
        }

        case 'refresh': {
          if (body.asOf !== undefined) {
            const a = validateAsOf(body.asOf, now);
            if (!a.ok) return bad(a.reason);
          }
          if (body.houses !== undefined && !(Array.isArray(body.houses) && body.houses.length > 0 && body.houses.every(h => HOUSES.includes(h)))) {
            return bad(`houses must be a non-empty subset of ${HOUSES.join(', ')}`);
          }
          if (body.force !== undefined && typeof body.force !== 'boolean') return bad('force must be a boolean');
          if (body.itiUrl !== undefined && (typeof body.itiUrl !== 'string' || body.itiUrl.length > 300)) return bad('itiUrl must be a string of at most 300 characters');
          if (running) return sendJson(res, 409, { error: 'A refresh is already running', retryable: true }, corsOrigin);

          running = true;
          try {
            const result = await runMfHoldings({
              io, impl: IMPL, now, asOf: body.asOf, houses: body.houses, force: body.force === true,
              params: body.itiUrl ? { itiUrl: body.itiUrl } : {},
            });
            await reportFailures(result);
            console.log(`mf-holdings: on-demand refresh for ${v.email}`, JSON.stringify(result));
            const { status } = await io.read();
            return sendJson(res, 200, { action: 'refresh', ...result, status }, corsOrigin);
          } finally {
            running = false;
          }
        }

        default:
          return bad('Unknown action');
      }
    } catch (e) {
      console.error('mf-holdings error', e);
      await reportError('INV-001', e, { stage: 'mf-holdings-http' }).catch(() => {});
      return sendJson(res, 500, { error: 'Internal error' }, corsOrigin);
    }
  }
);
