/**
 * Netlify Edge Function — Anthropic API proxy
 * Keeps the API key server-side; browser never sees it.
 */

const ALLOWED_ORIGINS = [
  'https://budget-dashboard-tracker.netlify.app',
  'http://localhost:5173',
];

// ── Rate limiter — 20 req/IP/60s, with cleanup to prevent memory growth ──────
const RATE_LIMIT = 20;
const WINDOW_MS  = 60_000;
const MAX_IPS    = 500; // evict oldest if map grows too large
const ipMap      = new Map();

// Periodic cleanup of stale entries
let lastCleanup = Date.now();
function cleanupIfNeeded() {
  const now = Date.now();
  if (now - lastCleanup < 300_000) return; // every 5 min
  lastCleanup = now;
  for (const [ip, entry] of ipMap) {
    if (now - entry.windowStart > WINDOW_MS * 2) ipMap.delete(ip);
  }
}

function isRateLimited(ip) {
  cleanupIfNeeded();
  const now   = Date.now();
  const entry = ipMap.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    // Evict oldest entry if map is full
    if (ipMap.size >= MAX_IPS) {
      const firstKey = ipMap.keys().next().value;
      ipMap.delete(firstKey);
    }
    ipMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async (request) => {
  const origin     = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    if (!corsOrigin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  // Origin check
  if (!corsOrigin) {
    return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // sec-fetch-site check — browsers set this automatically, can't be spoofed cross-origin
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
    return new Response(JSON.stringify({ error: { message: 'Forbidden' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Rate limit — use leftmost IP from x-forwarded-for (actual client)
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
          || request.headers.get('x-real-ip')
          || 'unknown';

  if (isRateLimited(ip)) {
    return new Response(
      JSON.stringify({ error: { message: 'Too many requests. Please wait a moment and try again.' } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin } }
    );
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: { message: 'Service unavailable' } }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const body = await request.text();

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      'Access-Control-Allow-Origin': corsOrigin,
    },
  });
};

export const config = { path: '/api/claude' };
