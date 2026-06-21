import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.stubEnv('MCP_API_KEY', 'super-secret-key');

// Shared mock state (hoisted so the vi.mock factories below can close over it).
const { rateStore, ctl, handleRpc } = vi.hoisted(() => ({
  rateStore: new Map(),
  ctl: { throwOnGet: false },
  handleRpc: vi.fn(),
}));

// In-memory stand-in for the Firestore rate-limit store (collection().doc().get/set).
vi.mock('../../functions/lib/firestore.mjs', () => ({
  getDb: () => ({
    collection: () => ({
      doc: (id) => ({
        get: async () => {
          if (ctl.throwOnGet) throw new Error('firestore down');
          return { exists: rateStore.has(id), data: () => rateStore.get(id) };
        },
        set: async (value) => { rateStore.set(id, value); },
      }),
    }),
  }),
}));

// Stub the RPC core — these tests cover transport, auth, and rate limiting only.
vi.mock('../../functions/lib/_mcp.mjs', () => ({ handleRpc }));

const { mcp } = await import('../../functions/mcp-server.mjs');

const KEY = 'super-secret-key';
const KEY_HASH = crypto.createHash('sha256').update(KEY).digest('hex');
const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

// Express-style request + a wrapper that returns { status, headers, body }.
function post(body, { key = KEY } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  return { method: 'POST', get: (h) => headers[h.toLowerCase()], rawBody: Buffer.from(JSON.stringify(body)) };
}
function bare(method) {
  return { method, get: () => undefined, rawBody: Buffer.from('') };
}
async function handle(req) {
  let statusCode = 200; const headers = {}; let body;
  const res = {
    set(k, v) {
      if (typeof k === 'object') for (const [kk, vv] of Object.entries(k)) headers[kk.toLowerCase()] = vv;
      else headers[k.toLowerCase()] = v;
      return this;
    },
    status(c) { statusCode = c; return this; },
    send(b) { body = b; return this; },
    end() { return this; },
  };
  await mcp(req, res);
  return { status: statusCode, headers: { get: (h) => headers[h.toLowerCase()] }, body };
}

beforeEach(() => {
  rateStore.clear();
  ctl.throwOnGet = false;
  handleRpc.mockReset();
  handleRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });
});

describe('mcp-server handler — auth & transport', () => {
  it('processes a valid request and forwards it to handleRpc', async () => {
    const res = await handle(post(PING));
    expect(res.status).toBe(200);
    expect(handleRpc).toHaveBeenCalledOnce();
  });

  it('rejects a request with no key', async () => {
    const res = await handle(post(PING, { key: null }));
    expect(res.status).toBe(401);
    expect(handleRpc).not.toHaveBeenCalled();
  });

  it('rejects a wrong key', async () => {
    const res = await handle(post(PING, { key: 'wrong-key' }));
    expect(res.status).toBe(401);
  });

  it('answers a CORS preflight with 204', async () => {
    const res = await handle(bare('OPTIONS'));
    expect(res.status).toBe(204);
  });

  it('rejects non-POST methods with 405', async () => {
    const res = await handle(bare('GET'));
    expect(res.status).toBe(405);
  });
});

describe('mcp-server handler — rate limiting', () => {
  it('blocks once the per-key window is exhausted', async () => {
    rateStore.set(KEY_HASH, { count: 100, windowStart: Date.now() });
    const res = await handle(post(PING));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(handleRpc).not.toHaveBeenCalled();
  });

  it('allows the request that exactly hits the limit', async () => {
    rateStore.set(KEY_HASH, { count: 99, windowStart: Date.now() });
    const res = await handle(post(PING));
    expect(res.status).toBe(200);
  });

  it('resets the counter once the window has elapsed', async () => {
    rateStore.set(KEY_HASH, { count: 100, windowStart: Date.now() - 2 * 60 * 60 * 1000 });
    const res = await handle(post(PING));
    expect(res.status).toBe(200);
    expect(rateStore.get(KEY_HASH).count).toBe(1);
  });

  it('fails open when the store throws', async () => {
    ctl.throwOnGet = true;
    const res = await handle(post(PING));
    expect(res.status).toBe(200);
  });
});

describe('mcp-server handler — not configured', () => {
  it('returns 503 when MCP_API_KEY is unset', async () => {
    vi.stubEnv('MCP_API_KEY', '');
    const res = await handle(post(PING));
    expect(res.status).toBe(503);
    vi.stubEnv('MCP_API_KEY', 'super-secret-key');
  });
});
