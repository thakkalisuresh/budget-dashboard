/**
 * Cloud Function — CUSIP→ticker reconciliation proxy (Invest tab, Candidate Check).
 *
 * N-PORT keys ETF underlyings by CUSIP; directly-held stocks are keyed by ticker.
 * The cheap cache-derived tier (investInsights.buildCusipTickerMap) covers the
 * megacaps that dominate overlap, but some CUSIPs stay unmapped. This proxy
 * resolves them via OpenFIGI (Bloomberg-run, free): POST /v3/mapping with
 * [{ idType:'ID_CUSIP', idValue:<cusip> }] → the security's ticker.
 *
 * WHY SERVER-SIDE (same rationale as etf-holdings): keeps any OPENFIGI_API_KEY
 * off the public client bundle, and browsers can't set X-OPENFIGI-APIKEY on a
 * cross-origin request anyway. Results are the client's to cache in the CusipMap
 * sheet tab, so a CUSIP is resolved at most once.
 *
 * Auth = same stack as /api/quotes + /api/etf-holdings (allowlisted origin,
 * sec-fetch-site, Google bearer + ALLOWED_EMAILS).
 *
 * POST /api/openfigi { cusips: ["037833100", ...] }
 *   → { data: { "037833100": "AAPL", "<unresolved>": null, ... } }
 *
 * OPENFIGI_API_KEY is OPTIONAL: key-less OpenFIGI allows ~25 req/min with 10 jobs
 * per request; a free key lifts both. We chunk by the active per-request job cap
 * so a batch never exceeds it.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS, OPENFIGI_API_KEY } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';

const OPENFIGI_URL = 'https://api.openfigi.com/v3/mapping';
const CUSIP_RE = /^[0-9A-Z]{9}$/; // CUSIP: 9 alphanumerics
const MAX_CUSIPS = 100;           // bound the batch a client can ask for

// Per-instance cache: cusip → ticker|null. CUSIP↔ticker never changes, so keep
// it for the warm instance's life; the client's CusipMap sheet is the durable one.
const MAX_CACHE = 2000;
const cache = new Map();

function cacheGet(cusip) { return cache.has(cusip) ? cache.get(cusip) : undefined; }
function cacheSet(cusip, ticker) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(cusip, ticker);
}

/** Pick the ticker out of one OpenFIGI mapping job result (or null). */
function tickerFromJob(job) {
  const rows = Array.isArray(job?.data) ? job.data : [];
  for (const r of rows) {
    const t = String(r?.ticker || '').trim().toUpperCase();
    // Skip composite/exchange suffixes; a plain equity ticker is what we want.
    if (t && /^[A-Z0-9.\-]{1,10}$/.test(t)) return t;
  }
  return null;
}

/**
 * Resolve a chunk of CUSIPs in one OpenFIGI request. Returns a Map<cusip,ticker|null>
 * for exactly the input order (OpenFIGI echoes results positionally). On any
 * transport/HTTP error returns an empty map so the caller degrades gracefully
 * (unresolved CUSIPs simply keep PR1's CUSIP key — overlap is understated, never
 * wrong).
 */
async function resolveChunk(cusips, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-OPENFIGI-APIKEY'] = apiKey;
  const body = cusips.map((c) => ({ idType: 'ID_CUSIP', idValue: c }));
  let res;
  try {
    res = await fetch(OPENFIGI_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    return new Map();
  }
  if (!res.ok) return new Map(); // 429/5xx → degrade; client retries later
  const json = await res.json().catch(() => null);
  const out = new Map();
  if (Array.isArray(json)) {
    for (let i = 0; i < cusips.length; i++) out.set(cusips[i], tickerFromJob(json[i]));
  }
  return out;
}

export const openfigi = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS], maxInstances: 2, cors: false },
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

    const raw = Array.isArray(req.body?.cusips) ? req.body.cusips : [];
    const cusips = [...new Set(raw.map((c) => String(c || '').trim().toUpperCase()))].filter((c) => CUSIP_RE.test(c));
    if (cusips.length === 0 || cusips.length > MAX_CUSIPS) {
      sendJson(res, 400, { error: `cusips must be 1–${MAX_CUSIPS} valid CUSIPs` }, corsOrigin);
      return;
    }

    const apiKey = OPENFIGI_API_KEY.value();
    const jobsPerReq = apiKey ? 100 : 10; // OpenFIGI per-request job cap

    const data = {};
    const toFetch = [];
    for (const c of cusips) {
      const hit = cacheGet(c);
      if (hit !== undefined) data[c] = hit;
      else toFetch.push(c);
    }

    let fetched = 0;
    for (let i = 0; i < toFetch.length; i += jobsPerReq) {
      const chunk = toFetch.slice(i, i + jobsPerReq);
      const resolved = await resolveChunk(chunk, apiKey);
      for (const c of chunk) {
        const t = resolved.has(c) ? resolved.get(c) : null;
        // Only cache a definitive answer (a resolved ticker, or a confirmed miss
        // from a successful response). An empty map (transport error) leaves the
        // CUSIP uncached so the next request retries it.
        if (resolved.has(c)) cacheSet(c, t);
        data[c] = t;
        fetched++;
      }
    }

    console.log(`openfigi: ${cusips.length} cusips (${cusips.length - toFetch.length} cached, ${fetched} fetched)${apiKey ? '' : ' key-less'} for ${v.email}`);
    sendJson(res, 200, { data }, corsOrigin);
  }
);
