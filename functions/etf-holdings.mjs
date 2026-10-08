/**
 * Cloud Function — ETF holdings look-through for the Invest tab.
 *
 * SEC EDGAR rejects requests without a descriptive User-Agent, and browsers
 * forbid overriding that header, so the EDGAR fetch has to run server-side.
 * The browser calls /api/etf-holdings?ticker=VOO with its Google access token;
 * this function resolves the ticker's latest N-PORT filing via edgarService and
 * returns the normalized holdings JSON.
 *
 * Auth = same stack as /api/quotes (allowlisted origin, sec-fetch-site, Google
 * bearer + ALLOWED_EMAILS). Per-instance 24h cache (N-PORT is filed quarterly,
 * so holdings barely move) + maxInstances 2 keeps SEC traffic negligible.
 *
 * GET /api/etf-holdings?ticker=VOO
 *   → { ticker, asOf, source: 'NPORT-P', cik, holdings: [{ name, cusip, ticker, weight }] }
 *
 * EDGAR_USER_AGENT (a plain string param, NOT a secret) carries the descriptive
 * UA required by SEC fair-access policy — format "Name email@example.com". The
 * owner sets the real contact value at deploy (see docs/INVEST.md); the param's
 * fallback keeps dev working but SEC may throttle a generic UA.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS, EDGAR_USER_AGENT } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { getEtfHoldings } from './edgarService.mjs';

const TICKER_RE = /^[A-Z0-9.^-]{1,10}$/;

// Per-instance cache: ticker → { data, at }. 24h TTL — N-PORT is quarterly.
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE = 200;
const cache = new Map();

function cacheGet(ticker) {
  const hit = cache.get(ticker);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  return null;
}
function cacheSet(ticker, data) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(ticker, { data, at: Date.now() });
}

export const etfHoldings = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS], maxInstances: 2, cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.status(204).end();
      return;
    }

    if (!corsOrigin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    if (!hasValidSecFetchSite(req)) { sendJson(res, 403, { error: 'Forbidden' }, corsOrigin); return; }
    if (req.method !== 'GET') { res.status(405).send('Method Not Allowed'); return; }

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }

    const ticker = String(req.query?.ticker || '').trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) { sendJson(res, 400, { error: 'ticker must be a valid symbol' }, corsOrigin); return; }

    const cached = cacheGet(ticker);
    if (cached) {
      console.log(`etf-holdings: ${ticker} (cached) for ${v.email}`);
      sendJson(res, 200, { ...cached, cached: true }, corsOrigin);
      return;
    }

    const userAgent = EDGAR_USER_AGENT.value();
    try {
      const data = await getEtfHoldings(ticker, { userAgent });
      if (!data.holdings.length) { sendJson(res, 404, { error: `No N-PORT holdings found for ${ticker}` }, corsOrigin); return; }
      cacheSet(ticker, data);
      console.log(`etf-holdings: ${ticker} (${data.holdings.length} holdings, asOf ${data.asOf}) for ${v.email}`);
      sendJson(res, 200, { ...data, cached: false }, corsOrigin);
    } catch (e) {
      console.warn(`etf-holdings: ${ticker} failed — ${e?.message}`);
      // Unknown ticker / no NPORT-P is a 404; anything else is an upstream error.
      const notFound = /Unknown ticker|No NPORT-P/i.test(e?.message || '');
      sendJson(res, notFound ? 404 : 502, { error: e?.message || 'EDGAR lookup failed' }, corsOrigin);
    }
  }
);
