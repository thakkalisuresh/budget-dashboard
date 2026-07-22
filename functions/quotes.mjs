/**
 * Cloud Function — stock quotes proxy for the Invest tab.
 *
 * The Finnhub API key must never reach the client bundle (the site is publicly
 * fetchable), so the browser calls /api/quotes with its Google access token and
 * this function relays to Finnhub. Free-tier budget (60 calls/min) is protected
 * by a per-instance 60s cache and maxInstances: 2 — the household's ~10–30
 * symbols polled once a minute per open tab stays far under the limit.
 *
 * POST { symbols: ["VOO", ...], kind?: "quote" | "recommendation" | "profile" }
 *   → { data: { VOO: {...} | null, ... }, kind }
 * "quote" is normalised to { price, prevClose, dayChangePct, high, low, open, t };
 * recommendation/profile pass Finnhub's shape through (pre-buy check, Phase 2).
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS, FINNHUB_API_KEY } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';

const MAX_SYMBOLS = 30;
const SYMBOL_RE = /^[A-Z0-9.^-]{1,10}$/;

const KINDS = {
  quote:          (s) => `https://finnhub.io/api/v1/quote?symbol=${s}`,
  recommendation: (s) => `https://finnhub.io/api/v1/stock/recommendation?symbol=${s}`,
  profile:        (s) => `https://finnhub.io/api/v1/stock/profile2?symbol=${s}`,
};

// Per-instance cache: `${kind}:${symbol}` → { data, at }. Quotes go stale in
// 60s; slow-moving kinds keep an hour. Pruned by size to bound memory.
const CACHE_TTL_MS = { quote: 60_000, recommendation: 60 * 60_000, profile: 24 * 60 * 60_000 };
const MAX_CACHE = 500;
const cache = new Map();

function cacheGet(kind, symbol) {
  const hit = cache.get(`${kind}:${symbol}`);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS[kind]) return hit;
  return null;
}

function cacheSet(kind, symbol, data) {
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(`${kind}:${symbol}`, { data, at: Date.now() });
}

/** Finnhub /quote → compact shape the client consumes. null when unknown. */
function normalizeQuote(raw) {
  // Finnhub returns zeros for unknown symbols rather than an error.
  if (!raw || !(raw.c > 0)) return null;
  return {
    price: raw.c,
    prevClose: raw.pc,
    dayChangePct: raw.dp ?? (raw.pc > 0 ? ((raw.c - raw.pc) / raw.pc) * 100 : 0),
    high: raw.h, low: raw.l, open: raw.o,
    t: raw.t,
  };
}

async function fetchSymbol(kind, symbol, apiKey) {
  try {
    const res = await fetch(KINDS[kind](symbol), { headers: { 'X-Finnhub-Token': apiKey } });
    if (!res.ok) return { data: null, status: res.status };
    const raw = await res.json();
    return { data: kind === 'quote' ? normalizeQuote(raw) : raw, status: 200 };
  } catch {
    return { data: null, status: 0 };
  }
}

export const quotes = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS, FINNHUB_API_KEY], maxInstances: 2, cors: false },
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

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) { sendJson(res, 503, { error: 'Quotes not configured' }, corsOrigin); return; }

    const body = req.body || {};
    const kind = KINDS[body.kind || 'quote'] ? (body.kind || 'quote') : null;
    if (!kind) { sendJson(res, 400, { error: 'Unknown kind' }, corsOrigin); return; }

    const symbols = Array.isArray(body.symbols)
      ? [...new Set(body.symbols.map(s => String(s || '').trim().toUpperCase()))]
      : [];
    if (symbols.length === 0 || symbols.length > MAX_SYMBOLS || !symbols.every(s => SYMBOL_RE.test(s))) {
      sendJson(res, 400, { error: `symbols must be 1–${MAX_SYMBOLS} valid tickers` }, corsOrigin);
      return;
    }

    const data = {};
    let served = 0, fetched = 0, rateLimited = false;

    await Promise.all(symbols.map(async (symbol) => {
      const hit = cacheGet(kind, symbol);
      if (hit) { data[symbol] = hit.data; served++; return; }
      const { data: fresh, status } = await fetchSymbol(kind, symbol, apiKey);
      if (status === 429) rateLimited = true;
      // Cache successes AND nulls (unknown ticker) — but never a 429 miss, so
      // the next poll retries once Finnhub's window resets.
      if (status === 200) cacheSet(kind, symbol, fresh);
      data[symbol] = fresh;
      fetched++;
    }));

    console.log(`quotes: ${kind} ${symbols.length} symbols (${served} cached, ${fetched} fetched)${rateLimited ? ' RATE-LIMITED' : ''} for ${v.email}`);
    sendJson(res, 200, { kind, data, stale: rateLimited }, corsOrigin);
  }
);
