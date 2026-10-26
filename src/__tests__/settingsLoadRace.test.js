import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSettingsController } from '../settingsController.js';

vi.stubEnv('VITE_TEMPLATE_SHEET_ID', 'tpl');
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
const { loadUserSettings, saveUserSettings, DEFAULT_SETTINGS } = await import('../useSettings.js');

const stored = { ...DEFAULT_SETTINGS, investSheetId: 'REAL', investAccountRules: [{ pattern: 'wise', accountId: 'nro-mf' }] };
let rows, valuesGetStatus;
beforeEach(() => {
  valuesGetStatus = 200;
  rows = [['UserID', 'Settings'], ['me@x.com', JSON.stringify(stored)]];
  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const m = opts.method || 'GET';
    if (m === 'GET' && url.includes('/values/')) {
      return valuesGetStatus === 200
        ? { ok: true, status: 200, json: async () => ({ values: rows }) }
        : { ok: false, status: valuesGetStatus, json: async () => ({ error: { code: valuesGetStatus, message: 'Too many requests' } }) };
    }
    if (m === 'GET') return { ok: true, status: 200, json: async () => ({ sheets: [{ properties: { title: 'UserSettings' } }] }) };
    if (m === 'PUT') { const r = Number(url.match(/!A(\d+)/)[1]); rows[r - 1] = JSON.parse(opts.body).values[0]; }
    if (m === 'POST') rows.push(JSON.parse(opts.body).values[0]);
    return { ok: true, status: 200, json: async () => ({}) };
  });
});

describe('sheet load/save (429 handling)', () => {
  it('load rejects on a persistent 429 instead of returning defaults', async () => {
    valuesGetStatus = 429;
    await expect(loadUserSettings('me@x.com', 't', { delays: [0, 0] })).rejects.toThrow();
  });
  it('load retries a transient 429 and then succeeds with the stored row', async () => {
    valuesGetStatus = 429;
    const p = loadUserSettings('me@x.com', 't', { delays: [0, 0, 0] });
    setTimeout(() => { valuesGetStatus = 200; }, 0);
    expect((await p).investSheetId).toBe('REAL');
  });
  it('load does not retry non-transient errors (401)', async () => {
    valuesGetStatus = 401;
    await expect(loadUserSettings('me@x.com', 't', { delays: [0, 0] })).rejects.toThrow();
    expect(fetch.mock.calls.filter(([u]) => u.includes('/values/')).length).toBe(1);
  });
  it('no stored row is still a normal defaults result', async () => {
    rows = [['UserID', 'Settings']];
    expect((await loadUserSettings('me@x.com', 't')).investSheetId).toBeNull();
  });
  it('save rejects on a failed row read and never appends a duplicate row', async () => {
    valuesGetStatus = 429;
    await expect(saveUserSettings('me@x.com', { ...stored, theme: 'dark' }, 't')).rejects.toThrow();
    expect(rows.length).toBe(2);
  });
});

describe('settings controller', () => {
  const mk = (over = {}) => {
    const saves = [];
    const c = createSettingsController({
      defaults: DEFAULT_SETTINGS,
      load: vi.fn(async () => stored),
      save: vi.fn(async (s) => { saves.push(s); }),
      ...over,
    });
    return { c, saves };
  };

  it('does not save before the load is ready; queued updates replay on top of loaded settings (order kept)', async () => {
    let release;
    const { c, saves } = mk({ load: () => new Promise(r => { release = () => r(stored); }) });
    const p = c.start();
    c.update(prev => ({ ...prev, theme: 'dark' }));
    c.update(prev => ({ ...prev, tags: [...(prev.tags || []), 'a'] }));
    c.update(prev => ({ ...prev, tags: [...(prev.tags || []), 'b'] }));
    expect(saves.length).toBe(0);
    release(); await p; await c.idle();
    const s = c.getState().settings;
    expect(s.investSheetId).toBe('REAL');            // real row preserved
    expect(s.investAccountRules.length).toBe(1);
    expect(s.theme).toBe('dark');
    expect(s.tags).toEqual(['a', 'b']);
    expect(saves.length).toBe(1);                    // one save, built from the loaded row
    expect(saves[0].investSheetId).toBe('REAL');
  });

  it('a load error disables saving and keeps defaults in memory', async () => {
    const { c, saves } = mk({ load: async () => { throw new Error('429'); } });
    await c.start();
    expect(c.getState().status).toBe('error');
    c.update(prev => ({ ...prev, theme: 'dark' }));
    await c.idle();
    expect(saves.length).toBe(0);
    expect(c.getState().settings.theme).toBe('dark'); // still usable in memory
  });

  it('retry success -> ready -> queued updates replayed and saved', async () => {
    let fail = true;
    const { c, saves } = mk({ load: async () => { if (fail) throw new Error('429'); return stored; } });
    await c.start();
    c.update(prev => ({ ...prev, theme: 'dark' }));
    fail = false;
    await c.retry(); await c.idle();
    expect(c.getState().status).toBe('ready');
    expect(c.getState().loadError).toBeNull();
    expect(saves.length).toBe(1);
    expect(saves[0]).toMatchObject({ investSheetId: 'REAL', theme: 'dark' });
  });

  it('after ready, saves are serialized and coalesced (last write wins)', async () => {
    const order = []; let unblock;
    const { c } = mk({
      save: vi.fn((s) => { order.push(s.n); return order.length === 1 ? new Promise(r => { unblock = r; }) : Promise.resolve(); }),
    });
    await c.start();
    c.update(p => ({ ...p, n: 1 }));
    c.update(p => ({ ...p, n: 2 }));
    c.update(p => ({ ...p, n: 3 }));
    expect(order).toEqual([1]);          // only one in flight
    unblock(); await c.idle();
    expect(order).toEqual([1, 3]);       // 2 coalesced away
  });

  it('a failed save does not wedge later saves', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const { c, saves } = mk({ save: vi.fn(async (s) => { if (n++ === 0) throw new Error('x'); saves.push(s); }) });
    await c.start();
    c.update(p => ({ ...p, a: 1 })); await c.idle();
    c.update(p => ({ ...p, a: 2 })); await c.idle();
    expect(saves.length).toBe(1);
    err.mockRestore();
  });

  it('start() is a no-op once ready (token refresh does not reload over in-memory state)', async () => {
    const { c } = mk();
    await c.start();
    c.update(p => ({ ...p, theme: 'dark' }));
    await c.start();
    expect(c.getState().settings.theme).toBe('dark');
  });
});
