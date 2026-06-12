/**
 * Cloud Function — MCP server endpoint. Stateless JSON-RPC 2.0 over HTTP
 * (Streamable HTTP compatible). Ported from netlify/functions/mcp-server.mjs
 * (Deno Web Request/Response + Netlify Blobs → Express onRequest + Firestore).
 *
 * Auth: a single shared secret in MCP_API_KEY, sent by the client as
 * `Authorization: Bearer <key>` (or `X-API-Key: <key>`). All RPC logic lives
 * in lib/_mcp.mjs, unchanged. Touches the Sheets/Drive data layer via the
 * tool implementations, so those secrets are bound too.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { handleRpc } from './lib/_mcp.mjs';
import { getDb } from './lib/firestore.mjs';
import { sha256Hex } from './lib/http-common.mjs';
import { MCP_API_KEY, SHEETS_DRIVE_SECRETS } from './lib/secrets.mjs';

// Fixed-window rate limit: at most RATE_LIMIT requests per RATE_WINDOW_MS,
// counted per API key. State lives in Firestore (collection `mcp_rate_limit`,
// doc id = key hash) so it survives across stateless invocations and instances
// — an in-memory counter would reset on every cold start, defeating an
// hour-long window. Good enough for a single-user server: guards against a
// runaway client loop or a leaked key being hammered.
const RATE_LIMIT     = 100;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_COLLECTION = 'mcp_rate_limit';

// Returns { allowed, remaining, resetSec }. Fails open on any store error: a
// Firestore outage must not take the whole MCP endpoint down. Non-transactional
// fixed window (matches the original Blobs design — the tiny read-modify-write
// race is acceptable for a soft single-user cap).
async function checkRateLimit(keyHash) {
  try {
    const ref = getDb().collection(RATE_COLLECTION).doc(keyHash);
    const now = Date.now();
    const snap = await ref.get();
    const rec = (snap.exists ? snap.data() : null) || { count: 0, windowStart: now };
    if (now - rec.windowStart >= RATE_WINDOW_MS) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count += 1;
    await ref.set({ count: rec.count, windowStart: rec.windowStart });
    const resetSec = Math.ceil((rec.windowStart + RATE_WINDOW_MS - now) / 1000);
    return { allowed: rec.count <= RATE_LIMIT, remaining: Math.max(0, RATE_LIMIT - rec.count), resetSec };
  } catch (e) {
    console.error('MCP rate-limit store error (failing open):', e);
    return { allowed: true, remaining: RATE_LIMIT, resetSec: 0 };
  }
}

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, MCP-Protocol-Version',
};

function sendRpc(res, payload, status = 200, extraHeaders = {}) {
  res.set({ 'Content-Type': 'application/json', ...CORS, ...extraHeaders });
  res.status(status).send(JSON.stringify(payload));
}

// Constant-length comparison of two equal-length hex strings (no length leak —
// both inputs are hashed to 64 chars first).
async function keyMatches(provided, expected) {
  const [a, b] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractKey(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return req.get('x-api-key')?.trim() || null;
}

export const mcp = onRequest(
  {
    region: 'us-central1',
    secrets: [MCP_API_KEY, ...SHEETS_DRIVE_SECRETS],
    timeoutSeconds: 60,
    memory: '512MiB',
    maxInstances: 5,
    cors: false,
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.set(CORS);
      res.status(204).end();
      return;
    }
    if (req.method !== 'POST') {
      res.set({ Allow: 'POST', ...CORS });
      res.status(405).send('Method Not Allowed');
      return;
    }

    const apiKey = process.env.MCP_API_KEY;
    if (!apiKey) {
      sendRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server not configured' } }, 503);
      return;
    }

    const key = extractKey(req);
    if (!key || !(await keyMatches(key, apiKey))) {
      sendRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401);
      return;
    }

    const { allowed, resetSec } = await checkRateLimit(await sha256Hex(key));
    if (!allowed) {
      sendRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Rate limit exceeded' } }, 429,
        { 'Retry-After': String(resetSec) });
      return;
    }

    // Parse the body from the raw bytes (mirrors the edge function's
    // `await req.json()` + parse-error path exactly).
    let body;
    try {
      body = JSON.parse(req.rawBody ? req.rawBody.toString('utf8') : '');
    } catch {
      sendRpc(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
      return;
    }

    // JSON-RPC batch (array) or single message
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
      if (responses.length) { sendRpc(res, responses); return; }
      res.set(CORS);
      res.status(202).end(); // all notifications — accepted, no body
      return;
    }

    const resp = await handleRpc(body);
    if (resp === null) {
      res.set(CORS);
      res.status(202).end(); // notification — accepted, no body
      return;
    }
    sendRpc(res, resp);
  }
);
