/**
 * Cloud Functions — "Fund vs peers" data for the household's Indian mutual funds
 * (Invest tab, Phase 2 slice 2).
 *
 *  mfPeersHeldRefresh     scheduled DAILY 04:00 IST, but weekly in effect: the first run of each IST week
 *                         (Sunday-based) refreshes the HELD funds (both plans) and every row of any
 *                         common-window category (conglomerate), then recomputes the rolling-beat share
 *                         from the stored month-end series. The rest of the week it is a no-op (nothing
 *                         fetched or written); with no held rows yet it runs on the very next tick.
 *  mfPeersMonthlyRefresh  scheduled DAILY 03:00 IST, monthly in effect: refreshes the PEERS (and the
 *                         benchmark twin) then the TER feed once per calendar month; a complete month is a
 *                         no-op. Resumable: a code already refreshed this month is skipped, so a failed
 *                         or time-boxed day is simply retried the next day.
 *  mfPeers                authenticated on-demand endpoint (same auth stack as /api/mf-holdings).
 *                           POST /api/mf-peers { action: 'status' }
 *                           POST /api/mf-peers { action: 'refresh', scope: 'held'|'peers'|'ter'|'all', force? }
 *                         `refresh` does ONE time-budgeted slice and answers { done, remaining } so
 *                         the caller can repeat it; read-only viewers (VIEWER_EMAILS) get 403 on it.
 *
 * Output: Invest sheet tabs MfPeersConfig / MfPeers / MfTer / MfPeersSeries / MfPeersRun (contract in
 * lib/_mf-peers.mjs and docs/INVEST.md). Per-code isolation: one failing code never blocks the others;
 * failures keep the last good row and are reported through reportError('INV-001', …, { stage }) — no new
 * error code. Every failure reason carries phase, host, HTTP status and the underlying cause code.
 *
 * Secrets: the same Sheets/Drive bundle every Invest function uses (+ the existing VIEWER_EMAILS binding
 * on the HTTP function). No new secret or param (the User-Agent is a constant).
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { SHEETS_DRIVE_SECRETS, VIEWER_EMAILS } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getInvestSheetId, ensureInvestTabsServer, readInvestTabs, replaceInvestRows } from './lib/_invest-sheets.mjs';
import { reportError } from './lib/_error-log.mjs';
import { getSchemes } from './lib/_mf-nav.mjs';
import { makeClient } from './lib/mf-peers/_http.mjs';
import {
  CONFIG_COLUMNS, PEERS_COLUMNS, TER_COLUMNS, SERIES_COLUMNS, RUN_COLUMNS, TAB, LIMITS, SCOPES, DEFAULT_BUDGET_MS,
  runScope, valuesToRun, valuesToPeers, peersToValues, seriesToValues, terToValues, runToValues,
} from './lib/_mf-peers.mjs';

const TABS = { [TAB.config]: CONFIG_COLUMNS, [TAB.peers]: PEERS_COLUMNS, [TAB.ter]: TER_COLUMNS, [TAB.series]: SERIES_COLUMNS, [TAB.run]: RUN_COLUMNS };
const SIP_TAB = 'SipPlans';
/** Hosting forwards /api/* to the function with a 60 s limit, so one on-demand slice is ~15 codes; the caller repeats until done. */
const HTTP_BUDGET_MS = 35_000;

/** Sheets-backed io for runScope (creates the five tabs if the sheet predates them). */
export function sheetsIo(sheetId) {
  return {
    async read() {
      await ensureInvestTabsServer(sheetId, TABS);
      const [config, peers, ter, series, run] = await readInvestTabs(sheetId, [
        { title: TAB.config, width: CONFIG_COLUMNS.length, maxRows: LIMITS.config },
        { title: TAB.peers, width: PEERS_COLUMNS.length, maxRows: LIMITS.peers },
        { title: TAB.ter, width: TER_COLUMNS.length, maxRows: LIMITS.ter },
        { title: TAB.series, width: SERIES_COLUMNS.length, maxRows: LIMITS.series },
        { title: TAB.run, width: RUN_COLUMNS.length, maxRows: LIMITS.run },
      ]);
      let sip = [];
      try { [sip] = await readInvestTabs(sheetId, [{ title: SIP_TAB, width: 8, maxRows: 50 }]); } catch { sip = []; } // optional: the auto-narrowing rule only
      return { config, peers, ter, series, run, sip };
    },
    writeConfig: (values) => replaceInvestRows(sheetId, TAB.config, CONFIG_COLUMNS.length, values, LIMITS.config),
    writePeers: (rows) => replaceInvestRows(sheetId, TAB.peers, PEERS_COLUMNS.length, peersToValues(rows), LIMITS.peers),
    writeSeries: (rows) => replaceInvestRows(sheetId, TAB.series, SERIES_COLUMNS.length, seriesToValues(rows), LIMITS.series),
    writeTer: (rows) => replaceInvestRows(sheetId, TAB.ter, TER_COLUMNS.length, terToValues(rows), LIMITS.ter),
    writeRun: (rows) => replaceInvestRows(sheetId, TAB.run, RUN_COLUMNS.length, runToValues(rows), LIMITS.run),
  };
}

let depsOverride = null;
/** Test seam (as in lib/_mf-nav.mjs): replace parts of the real network deps, e.g. the retry sleep. */
export function _setDepsForTests(d) { depsOverride = d; }

export function realDeps() {
  return {
    client: makeClient(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getNavAll: async () => (await getSchemes()).byCode,
    ...(depsOverride || {}),
  };
}

/** Report scopes that genuinely failed (not "resume tomorrow"), aggregated per scope, tagged with the stage. */
async function reportFailures(results) {
  for (const r of results) {
    if (!r.failed && !r.error) continue;
    const first = r.failures?.[0]?.reason || r.error;
    await reportError('INV-001', new Error(`mf-peers ${r.scope} ${r.cycle}: ${r.failed} failed, ${r.stale} stale of ${r.total}${r.error && !r.failed ? ` (${r.error})` : ''}; first: ${first}`), { stage: `mf-peers-${r.scope}` });
  }
}

/**
 * Run scopes in order within one shared time budget.
 * @returns {Promise<{ran:boolean, reason?:string, done:boolean, remaining:number, scopes:object[]}>}
 */
export async function runScopes({ scopes, now = new Date(), force = false, budgetMs = DEFAULT_BUDGET_MS, io, deps }) {
  const sheetId = io ? 'injected' : await getInvestSheetId();
  if (!sheetId) { console.warn('mf-peers: no invest sheet provisioned; skipping'); return { ran: false, reason: 'no_invest_sheet', done: false, remaining: 0, scopes: [] }; }
  const theIo = io || sheetsIo(sheetId);
  const theDeps = deps || realDeps();
  const clock = theDeps.clock || (() => Date.now());
  const end = clock() + budgetMs;
  const results = [];
  for (const scope of scopes) {
    const left = Math.max(0, end - clock());
    results.push(await runScope({ scope, io: theIo, deps: theDeps, now, force, budgetMs: left }));
  }
  await reportFailures(results);
  console.log('mf-peers: run', JSON.stringify(results.map(({ failures, ...r }) => ({ ...r, firstFailure: failures[0]?.reason }))));
  return { ran: true, done: results.every((r) => r.done), remaining: results.reduce((s, r) => s + r.remaining, 0), scopes: results };
}

export const mfPeersHeldRefresh = onSchedule(
  { schedule: '0 4 * * *', timeZone: 'Asia/Kolkata', region: 'us-central1', secrets: [...SHEETS_DRIVE_SECRETS], maxInstances: 1, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    try { await runScopes({ scopes: ['held'], budgetMs: DEFAULT_BUDGET_MS }); }
    catch (e) { console.error('mf-peers: held run failed', e?.message); await reportError('INV-001', e, { stage: 'mf-peers-held-run' }); }
  }
);

export const mfPeersMonthlyRefresh = onSchedule(
  { schedule: '0 3 * * *', timeZone: 'Asia/Kolkata', region: 'us-central1', secrets: [...SHEETS_DRIVE_SECRETS], maxInstances: 1, timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    try { await runScopes({ scopes: ['peers', 'ter'], budgetMs: DEFAULT_BUDGET_MS }); }
    catch (e) { console.error('mf-peers: monthly run failed', e?.message); await reportError('INV-001', e, { stage: 'mf-peers-monthly-run' }); }
  }
);

let running = false;

/** Read-only household viewers (VIEWER_EMAILS ⊆ ALLOWED_EMAILS, same detection as verify-user / mf-holdings). */
const isViewer = (email) => String(VIEWER_EMAILS.value() || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean).includes(String(email || '').toLowerCase());
const READ_ONLY_ERROR = 'Read-only users cannot refresh peers';

/** 'all' → peers first so the held run sees fresh month-end series, then TER, then held. */
export function scopesFor(scope) {
  if (scope === 'all') return ['peers', 'ter', 'held'];
  return SCOPES.includes(scope) ? [scope] : null;
}

export const mfPeers = onRequest(
  { region: 'us-central1', secrets: [...SHEETS_DRIVE_SECRETS, VIEWER_EMAILS], maxInstances: 1, timeoutSeconds: 300, memory: '512MiB', cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({ 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
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

    try {
      switch (body.action) {
        case 'status': {
          const sheetId = await getInvestSheetId();
          if (!sheetId) return sendJson(res, 409, { error: 'No Invest sheet provisioned yet — open the Invest tab once' }, corsOrigin);
          const st = await sheetsIo(sheetId).read();
          const counts = {};
          for (const r of valuesToPeers(st.peers)) counts[r.status] = (counts[r.status] || 0) + 1;
          return sendJson(res, 200, { action: 'status', run: valuesToRun(st.run), counts }, corsOrigin);
        }

        case 'refresh': {
          if (isViewer(v.email)) return sendJson(res, 403, { ok: false, error: READ_ONLY_ERROR }, corsOrigin);
          const scopes = scopesFor(body.scope === undefined ? 'all' : body.scope);
          if (!scopes) return bad(`scope must be one of ${SCOPES.join(', ')}, all`);
          if (body.force !== undefined && typeof body.force !== 'boolean') return bad('force must be a boolean');
          if (running) return sendJson(res, 409, { error: 'A refresh is already running', retryable: true }, corsOrigin);
          const sheetId = await getInvestSheetId();
          if (!sheetId) return sendJson(res, 409, { error: 'No Invest sheet provisioned yet — open the Invest tab once' }, corsOrigin);
          running = true;
          try {
            const r = await runScopes({ scopes, force: body.force === true, budgetMs: HTTP_BUDGET_MS });
            console.log(`mf-peers: on-demand refresh by ${v.email}`);
            return sendJson(res, 200, {
              action: 'refresh', done: r.done, remaining: r.remaining,
              scopes: r.scopes.map(({ failures, ...s }) => ({ ...s, failures: failures.slice(0, 5) })),
            }, corsOrigin);
          } finally {
            running = false;
          }
        }

        default:
          return bad('Unknown action');
      }
    } catch (e) {
      console.error('mf-peers error', e);
      await reportError('INV-001', e, { stage: 'mf-peers-http' }).catch(() => {});
      return sendJson(res, 500, { error: 'Internal error' }, corsOrigin);
    }
  }
);
