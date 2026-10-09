/**
 * Cloud Function — Indian mutual-fund NAV proxy for the Invest tab.
 *
 * AMFI's NAVAll.txt (official, ~1.5 MB) is parsed once and cached server-side
 * for hours; the browser never downloads it. Historical NAVs come from
 * mfapi.in with AMFI's history report as a short-window fallback. No API keys,
 * $0 run cost. Auth/CORS stack is identical to quotes.mjs.
 *
 * POST { action, ... }
 *   latest:  { codes: ["147919", ...≤20], includeFx?: true }
 *     → { data: { code: {schemeCode,name,amc,plan,option,nav,date} | null }, stale, fx? }
 *   search:  { q }  (≤60 chars)
 *     → { results: [{code,name,amc,plan,option,nav,date}...≤50], stale }
 *   history: { code, date }  → { schemeCode, date, resolvedDate, fellBack, nav, source }
 *            { code, from, to } (≤366 days) → { schemeCode, from, to, series: [{date,nav}], source }
 *   fx:      {} → { fx: { currency: "INR", rate, updatedAt } }   (INR per 1 USD)
 * Dates are ISO YYYY-MM-DD. 503 {retryable:true} while the first AMFI download
 * is still running; 502 {retryable:true} when history sources are all down.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getRate } from './lib/_currency.mjs';
import {
  getSchemes, searchSchemes, toPublic, navOnDate, fetchSeries, MfLoadingError,
  isValidIsoDate, addDays, daysBetween, MAX_RANGE_DAYS,
} from './lib/_mf-nav.mjs';

const MAX_CODES = 20;
const MAX_QUERY = 60;
const CODE_RE = /^\d{4,7}$/;

async function fxOrNull() {
  try {
    const { rate, updatedAt } = await getRate('INR');
    return { currency: 'INR', rate, updatedAt };
  } catch {
    return null;
  }
}

function notFuture(iso) {
  // IST is ahead of UTC, so allow one day of slack.
  return iso <= addDays(new Date().toISOString().slice(0, 10), 1);
}

export const mfNav = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS], maxInstances: 2, timeoutSeconds: 60, memory: '512MiB', cors: false },
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

    const body = req.body || {};
    const bad = (error) => sendJson(res, 400, { error }, corsOrigin);
    const loading = () => sendJson(res, 503, { error: 'NAV data is loading, retry shortly', retryable: true }, corsOrigin);

    try {
      switch (body.action) {
        case 'latest': {
          const codes = Array.isArray(body.codes) ? [...new Set(body.codes.map(c => String(c ?? '').trim()))] : [];
          if (!codes.length || codes.length > MAX_CODES || !codes.every(c => CODE_RE.test(c))) {
            return bad(`codes must be 1–${MAX_CODES} numeric scheme codes`);
          }
          const [{ byCode, stale }, fx] = await Promise.all([getSchemes(), body.includeFx ? fxOrNull() : undefined]);
          const data = {};
          for (const c of codes) {
            const s = byCode.get(c);
            data[c] = s && s.nav != null ? toPublic(s) : null;
          }
          const out = { action: 'latest', data, stale };
          if (body.includeFx) out.fx = fx;
          console.log(`mf-nav: latest ${codes.length} codes${stale ? ' STALE' : ''} for ${v.email}`);
          return sendJson(res, 200, out, corsOrigin);
        }

        case 'search': {
          const q = typeof body.q === 'string' ? body.q.trim() : '';
          if (!q || q.length > MAX_QUERY) return bad(`q must be 1–${MAX_QUERY} characters`);
          const { list, stale } = await getSchemes();
          return sendJson(res, 200, { action: 'search', results: searchSchemes(list, q), stale }, corsOrigin);
        }

        case 'history': {
          const code = String(body.code ?? '').trim();
          if (!CODE_RE.test(code)) return bad('code must be a numeric scheme code');
          try {
            if (body.date !== undefined) {
              if (!isValidIsoDate(body.date) || !notFuture(body.date)) return bad('date must be a valid past YYYY-MM-DD');
              return sendJson(res, 200, { action: 'history', ...(await navOnDate(code, body.date)) }, corsOrigin);
            }
            const { from, to } = body;
            if (!isValidIsoDate(from) || !isValidIsoDate(to) || from > to || !notFuture(to)) {
              return bad('from/to must be valid YYYY-MM-DD with from <= to');
            }
            if (daysBetween(from, to) > MAX_RANGE_DAYS) return bad(`range is limited to ${MAX_RANGE_DAYS} days`);
            const { series, source } = await fetchSeries(code, from, to);
            return sendJson(res, 200, { action: 'history', schemeCode: code, from, to, series, source }, corsOrigin);
          } catch {
            return sendJson(res, 502, { error: 'NAV history unavailable', retryable: true }, corsOrigin);
          }
        }

        case 'fx': {
          const fx = await fxOrNull();
          if (!fx) return sendJson(res, 502, { error: 'FX rate unavailable', retryable: true }, corsOrigin);
          return sendJson(res, 200, { action: 'fx', fx }, corsOrigin);
        }

        default:
          return bad('Unknown action');
      }
    } catch (e) {
      if (e instanceof MfLoadingError) return loading();
      console.error('mf-nav error', e);
      return sendJson(res, 500, { error: 'Internal error' }, corsOrigin);
    }
  }
);
