import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetch = vi.fn();
vi.mock('../sheetApi.js', () => ({ apiFetch: (...a) => apiFetch(...a) }));

const { fetchMfPeers } = await import('../mfPeersApi.js');
const { MF_PEERS_CONFIG_COLUMNS, MF_PEERS_COLUMNS, MF_PEERS_RUN_COLUMNS, MF_TER_COLUMNS } = await import('../mfPeers.js');

beforeEach(() => { apiFetch.mockReset(); });

const tabOf = (path) => decodeURIComponent(path).match(/'([^']+)'!/)[1];
const serve = (tabs) => apiFetch.mockImplementation(async (_id, path) => {
  const rows = tabs[tabOf(path)];
  if (rows === 'missing') { const e = new Error('Unable to parse range'); e.status = 400; throw e; }
  return { values: rows || [] };
});

describe('contract with the peer-data job (by header name)', () => {
  it('pins the header names the reader relies on', () => {
    expect(new Set(MF_PEERS_CONFIG_COLUMNS)).toEqual(new Set(['categoryKey', 'role', 'fundKey', 'amc', 'name', 'directCode', 'regularCode', 'isin', 'launch', 'note', 'weakMatch', 'active', 'comparisonJson']));
    expect(new Set(MF_PEERS_COLUMNS)).toEqual(new Set(['asOf', 'categoryKey', 'role', 'fundKey', 'code', 'plan', 'name', 'firstNavDate', 'lastNavDate', 'nav', 'ret1yPct', 'ret3yPct', 'ret5yPct', 'volPct', 'maxDrawdownPct', 'rollingBeatPeerMedianPct', 'rollingWindows', 'historyDays', 'status', 'reason', 'windowStartDate', 'retWindowPct', 'windowReturnBasis', 'volWindowPct', 'maxDrawdownWindowPct', 'fetchedAt']));
    expect(MF_TER_COLUMNS).toEqual(['asOf', 'code', 'plan', 'name', 'terPct', 'berPct', 'matchedName', 'matched']);
    expect(MF_PEERS_RUN_COLUMNS).toEqual(['scope', 'cycle', 'startedAt', 'finishedAt', 'done', 'total', 'cursorNote', 'lastError']);
  });
});

describe('fetchMfPeers', () => {
  it('reads the four tabs, mapping columns by header even when reordered', async () => {
    serve({
      MfPeersConfig: [['role', 'categoryKey', 'name', 'directCode', 'regularCode', 'fundKey'], ['held', 'flexi-cap', 'ABSL Flexi', '1', '2', 'absl-flexi-cap']],
      MfPeers: [['code', 'plan', 'asOf', 'role', 'status', 'ret3yPct'], ['1', 'direct', 46300, 'held', 'ok', '13.7']],
      MfTer: [['asOf', 'code', 'plan', 'terPct', 'matched'], ['2026-10-09', '1', 'direct', 0.91, true]],
      MfPeersRun: [['scope', 'done', 'total', 'finishedAt'], ['peers', 3, 60, '']],
    });
    const r = await fetchMfPeers('sheet', 'tok');
    expect(r.missing).toBe(false);
    expect(r.config[0]).toMatchObject({ role: 'held', categoryKey: 'flexi-cap', fundKey: 'absl-flexi-cap', active: true });
    expect(r.peerRows[0]).toMatchObject({ code: '1', plan: 'direct', ret3yPct: 13.7, status: 'ok' });
    expect(r.terRows[0]).toMatchObject({ terPct: 0.91, matched: true });
    expect(r.run.peers).toMatchObject({ done: 3, total: 60 });
  });
  it('never asks for the job’s private series tab', async () => {
    serve({});
    await fetchMfPeers('sheet', 'tok');
    const tabs = apiFetch.mock.calls.map(c => tabOf(c[1]));
    expect(tabs.sort()).toEqual(['MfPeers', 'MfPeersConfig', 'MfPeersRun', 'MfTer']);
  });
  it('tolerates missing tabs: empty result, no throw', async () => {
    serve({ MfPeersConfig: 'missing', MfPeers: 'missing', MfTer: 'missing', MfPeersRun: 'missing' });
    expect(await fetchMfPeers('sheet', 'tok')).toMatchObject({ config: [], peerRows: [], terRows: [], run: {}, missing: true });
  });
  it('an optional tab (MfPeersRun, MfTer) missing does not hide the rest', async () => {
    serve({ MfPeersConfig: [['categoryKey', 'role'], ['flexi-cap', 'held']], MfPeers: [['asOf', 'code', 'plan', 'role', 'status'], ['2026-10-09', '1', 'direct', 'held', 'ok']], MfTer: 'missing', MfPeersRun: 'missing' });
    const r = await fetchMfPeers('sheet', 'tok');
    expect(r.missing).toBe(false); expect(r.terRows).toEqual([]);
  });
  it('sign-in errors still surface', async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error('auth'), { code: 'AUTH-005' }));
    await expect(fetchMfPeers('sheet', 'tok')).rejects.toMatchObject({ code: 'AUTH-005' });
  });
  it('no sheet or no token: empty, no network', async () => {
    expect((await fetchMfPeers('', 'tok')).missing).toBe(true);
    expect((await fetchMfPeers('sheet', '')).missing).toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
