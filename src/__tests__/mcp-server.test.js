import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

vi.stubEnv('MCP_API_KEY', 'super-secret-key');

// In-memory stand-in for Netlify Blobs (get returns the stored object directly).
const mockStore = {
  data: new Map(),
  get(key) { return Promise.resolve(this.data.get(key) || null); },
  setJSON(key, value) { this.data.set(key, value); return Promise.resolve(); },
};
vi.mock('@netlify/blobs', () => ({ getStore: () => mockStore }));

// Stub the RPC core — these tests cover transport, auth, and rate limiting only.
const handleRpc = vi.hoisted(() => vi.fn());
vi.mock('../../netlify/functions/_mcp.mjs', () => ({ handleRpc }));

const { default: handler } = await import('../../netlify/functions/mcp-server.mjs');

const URL = 'https://test.netlify.app/api/mcp';
const KEY = 'super-secret-key';
const KEY_HASH = crypto.createHash('sha256').update(KEY).digest('hex');

function post(body, { key = KEY } = {}) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (key) headers.set('authorization', `Bearer ${key}`);
  return new Request(URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

const PING = { jsonrpc: '2.0', id: 1, method: 'ping' };

beforeEach(() => {
  mockStore.data.clear();
  handleRpc.mockReset();
  handleRpc.mockResolvedValue({ jsonrpc: '2.0', id: 1, result: {} });
});

describe('mcp-server handler — auth & transport', () => {
  it('processes a valid request and forwards it to handleRpc', async () => {
    const res = await handler(post(PING));
    expect(res.status).toBe(200);
    expect(handleRpc).toHaveBeenCalledOnce();
  });

  it('rejects a request with no key', async () => {
    const res = await handler(post(PING, { key: null }));
    expect(res.status).toBe(401);
    expect(handleRpc).not.toHaveBeenCalled();
  });

  it('rejects a wrong key', async () => {
    const res = await handler(post(PING, { key: 'wrong-key' }));
    expect(res.status).toBe(401);
  });

  it('answers a CORS preflight with 204', async () => {
    const res = await handler(new Request(URL, { method: 'OPTIONS' }));
    expect(res.status).toBe(204);
  });

  it('rejects non-POST methods with 405', async () => {
    const res = await handler(new Request(URL, { method: 'GET' }));
    expect(res.status).toBe(405);
  });
});

describe('mcp-server handler — rate limiting', () => {
  it('blocks once the per-key window is exhausted', async () => {
    mockStore.data.set(KEY_HASH, { count: 100, windowStart: Date.now() });
    const res = await handler(post(PING));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(handleRpc).not.toHaveBeenCalled();
  });

  it('allows the request that exactly hits the limit', async () => {
    mockStore.data.set(KEY_HASH, { count: 99, windowStart: Date.now() });
    const res = await handler(post(PING));
    expect(res.status).toBe(200);
  });

  it('resets the counter once the window has elapsed', async () => {
    mockStore.data.set(KEY_HASH, { count: 100, windowStart: Date.now() - 2 * 60 * 60 * 1000 });
    const res = await handler(post(PING));
    expect(res.status).toBe(200);
    expect(mockStore.data.get(KEY_HASH).count).toBe(1);
  });

  it('fails open when the blob store throws', async () => {
    const orig = mockStore.get;
    mockStore.get = () => Promise.reject(new Error('blobs down'));
    const res = await handler(post(PING));
    expect(res.status).toBe(200);
    mockStore.get = orig;
  });
});

describe('mcp-server handler — not configured', () => {
  it('returns 503 when MCP_API_KEY is unset', async () => {
    vi.resetModules();
    vi.stubEnv('MCP_API_KEY', '');
    const { default: freshHandler } = await import('../../netlify/functions/mcp-server.mjs');
    const res = await freshHandler(post(PING));
    expect(res.status).toBe(503);
    vi.stubEnv('MCP_API_KEY', 'super-secret-key');
  });
});
