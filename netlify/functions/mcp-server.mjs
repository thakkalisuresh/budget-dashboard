/**
 * MCP server endpoint — stateless JSON-RPC 2.0 over HTTP (Streamable HTTP compatible).
 * Auth: a single shared secret in the MCP_API_KEY env var, sent by the client as
 * `Authorization: Bearer <key>` (or `X-API-Key: <key>`).
 */

import { getStore } from '@netlify/blobs';
import { handleRpc } from './_mcp.mjs';

const MCP_API_KEY = process.env.MCP_API_KEY;

// Fixed-window rate limit: at most RATE_LIMIT requests per RATE_WINDOW_MS,
// counted per API key. State lives in Netlify Blobs so it survives across
// stateless invocations. The window is good enough for a single-user server —
// it guards against a runaway client loop or a leaked key being hammered.
const RATE_LIMIT     = 100;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Returns { allowed, remaining, resetSec }. Fails open on any store error: a
// blobs outage must not take the whole MCP endpoint down.
async function checkRateLimit(keyHash) {
  try {
    const store = getStore('mcp-rate-limit');
    const now   = Date.now();
    const rec   = (await store.get(keyHash, { type: 'json' })) || { count: 0, windowStart: now };
    if (now - rec.windowStart >= RATE_WINDOW_MS) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count += 1;
    await store.setJSON(keyHash, rec);
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

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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
  const auth = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return req.headers.get('x-api-key')?.trim() || null;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST', ...CORS } });
  }

  if (!MCP_API_KEY) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'MCP server not configured' } }, 503);
  }

  const key = extractKey(req);
  if (!key || !(await keyMatches(key, MCP_API_KEY))) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401);
  }

  const { allowed, resetSec } = await checkRateLimit(await sha256Hex(key));
  if (!allowed) {
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32029, message: 'Rate limit exceeded' } }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': String(resetSec), ...CORS } },
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  // JSON-RPC batch (array) or single message
  if (Array.isArray(body)) {
    const responses = (await Promise.all(body.map(handleRpc))).filter(Boolean);
    return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS });
  }

  const resp = await handleRpc(body);
  if (resp === null) {
    return new Response(null, { status: 202, headers: CORS }); // notification — accepted, no body
  }
  return json(resp);
}

export const config = { path: '/api/mcp' };
