/**
 * MCP server endpoint — stateless JSON-RPC 2.0 over HTTP (Streamable HTTP compatible).
 * Auth: a single shared secret in the MCP_API_KEY env var, sent by the client as
 * `Authorization: Bearer <key>` (or `X-API-Key: <key>`).
 */

import { handleRpc } from './_mcp.mjs';

const MCP_API_KEY = process.env.MCP_API_KEY;

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
