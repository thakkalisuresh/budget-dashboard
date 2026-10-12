import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PeersView } from '../MfPeersCard.jsx';
import { buildMfPeers } from '../mfPeers.js';
import { MOCK_MF_PEERS } from '../mockMfPeers.js';

const F = (fundKey, plan = null) => ({ planId: fundKey, name: fundKey, fundKey, plan });
const html = (res, loading = false) => renderToStaticMarkup(<PeersView res={res} loading={loading} />);
const build = (funds, data = MOCK_MF_PEERS) => buildMfPeers({ funds, ...data });

describe('PeersView', () => {
  it('renders ranks, medians, the rupee gap, the disclaimer and the explainer for a ranked fund', () => {
    const out = html(build([F('absl-flexi-cap')]));
    expect(out).toMatch(/of 16/);
    expect(out).toMatch(/Peer median/);
    expect(out).toMatch(/INR 770|INR [\d,]+ a year for every INR 1 lakh/);
    expect(out).toMatch(/Observations from public data, not investment advice/);
    expect(out).toMatch(/How this is calculated/);
    expect(out).toMatch(/Plan held not confirmed/);
    expect(out).toMatch(/includes overseas equity/);
  });
  it('conglomerate shows the weak-comparability text, the index twin and no rank', () => {
    const out = html(build([F('absl-conglomerate')]));
    expect(out).toMatch(/Weak comparability, under 2 years of history/);
    expect(out).toMatch(/INDEX TWIN/);
    expect(out).toMatch(/cumulative since 27 Oct 2025/);
    expect(out).not.toMatch(/1st = /);
  });
  it('retirement with an unknown sub-plan shows the skip note only', () => {
    const out = html(build([{ planId: 'sbi-retirement', name: 'SBI Retirement Benefit Fund', fundKey: null }]));
    expect(out).toMatch(/SBI sub-plan not confirmed/);
  });
  it('retirement carries the lock-in sentence', () => {
    expect(html(build([F('sbi-retirement-aggressive-hybrid')]))).toMatch(/ignore the lock-in/);
  });
  it('no data at all: "not available yet" (and "looking" while loading)', () => {
    expect(html(buildMfPeers({ funds: [F('absl-flexi-cap')] }))).toMatch(/not available yet/);
    expect(html(buildMfPeers({ funds: [F('absl-flexi-cap')] }), true)).toMatch(/Looking for peer data/);
  });
  it('a failed held row shows its reason, never a blank', () => {
    const peerRows = MOCK_MF_PEERS.peerRows.map(r => (r.role === 'held' && r.fundKey === 'absl-flexi-cap' ? { ...r, status: 'failed', reason: 'CDN blocked', ret1yPct: null, ret3yPct: null, ret5yPct: null, volPct: null, maxDrawdownPct: null } : r));
    const out = html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows }));
    expect(out).toMatch(/This fund’s own data is unavailable \(CDN blocked\)/);
    expect(out).not.toMatch(/Not loaded yet/);
  });
  it('first run: held rows only, peers loading, TER tab empty', () => {
    const data = { ...MOCK_MF_PEERS, peerRows: MOCK_MF_PEERS.peerRows.filter(r => r.role === 'held'), terRows: [], run: { peers: { done: 12, total: 100, finishedAt: '' } } };
    const out = html(build([F('absl-flexi-cap')], data));
    expect(out).toMatch(/STILL LOADING · 12\/100/);
    expect(out).toMatch(/Not loaded yet \(peer data is loading, 12\/100\)/);
    expect(out).toMatch(/n\/a/);
  });
  it('a failed peer is listed as left out of the ranks', () => {
    expect(html(build([F('iti-small-cap')]))).toMatch(/Left out of the ranks[^<]*Quant Small Cap/);
  });
  it('stale rows get the amber badge', () => {
    const peerRows = MOCK_MF_PEERS.peerRows.map(r => ({ ...r, asOf: '2026-06-01' }));
    expect(html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows }))).toMatch(/MAY BE OUT OF DATE/);
  });

  describe('rows that are not loaded yet are neutral, not failures', () => {
    const noHeld = (extra = {}) => ({ ...MOCK_MF_PEERS, peerRows: MOCK_MF_PEERS.peerRows.filter(r => !(r.role === 'held' && r.fundKey === 'absl-flexi-cap')), ...extra });
    const running = { peers: { done: 4, total: 96, finishedAt: '' } };
    const done = { peers: { done: 96, total: 96, finishedAt: '2026-10-12T02:00:00Z' } };
    it('no held row while the cycle is running: "Not loaded yet", never "unavailable"', () => {
      const out = html(build([F('absl-flexi-cap')], noHeld({ run: running })));
      expect(out).toMatch(/Not loaded yet \(peer data is loading, 4\/96\)/);
      expect(out).not.toMatch(/unavailable/);
      expect(out).not.toMatch(/no data row/);
      expect(out).toMatch(/PEER DATA STILL LOADING · 4\/96/);
    });
    it('no held row after the cycle completed: amber "unavailable" with the reason', () => {
      const out = html(build([F('absl-flexi-cap')], noHeld({ run: done })));
      expect(out).toMatch(/This fund’s own data is unavailable \(no data row\)/);
      expect(out).not.toMatch(/STILL LOADING/);
    });
    it('a pending row reads like not loaded yet', () => {
      const peerRows = MOCK_MF_PEERS.peerRows.map(r => (r.role === 'held' && r.fundKey === 'absl-flexi-cap' ? { ...r, status: 'pending', ret1yPct: null, ret3yPct: null, ret5yPct: null, volPct: null, maxDrawdownPct: null, rollingBeatPeerMedianPct: null } : r));
      const out = html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows, run: running }));
      expect(out).toMatch(/Not loaded yet/); expect(out).not.toMatch(/unavailable/);
    });
    it('a stale row with empty metrics: "Waiting for NAV data", reason only in the collapsed detail', () => {
      const reason = 'phase=nav-fetch host=api.mfapi.in newest NAV 2026-10-02 is older than AMFI NAVAll 2026-10-09';
      const peerRows = MOCK_MF_PEERS.peerRows.map(r => (r.role === 'held' && r.fundKey === 'absl-flexi-cap' ? { ...r, status: 'stale', reason, ret1yPct: null, ret3yPct: null, ret5yPct: null, volPct: null, maxDrawdownPct: null, rollingBeatPeerMedianPct: null } : r));
      const out = html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows, run: done }));
      expect(out).toMatch(/Waiting for NAV data/);
      expect(out).toMatch(/<details[^>]*><summary[^>]*>Details<\/summary><p[^>]*>phase=nav-fetch/);
      expect(out).not.toMatch(/unavailable/);
    });
    it('peers not loaded yet are neutral and not listed as left out', () => {
      const peerRows = MOCK_MF_PEERS.peerRows.filter(r => r.role === 'held' || r.categoryKey !== 'flexi-cap');
      const out = html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows, run: running }));
      expect(out).not.toMatch(/Left out of the ranks/);
      expect(out).toMatch(/Not loaded yet/);
    });
    it('TER and the Direct-vs-Regular gap still render when the metrics are missing', () => {
      const peerRows = MOCK_MF_PEERS.peerRows.filter(r => r.role !== 'held' || r.fundKey !== 'absl-flexi-cap');
      const out = html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows, run: running }));
      expect(out).toMatch(/0\.91%/); expect(out).toMatch(/1\.68%/);
      expect(out).toMatch(/INR 770/);
    });
    it('the conglomerate shows its TER gap too, and a not-loaded comparable stays neutral', () => {
      const peerRows = MOCK_MF_PEERS.peerRows.filter(r => r.fundKey === 'absl-conglomerate' || r.categoryKey !== 'conglomerate' || r.role === 'benchmark');
      const out = html(build([F('absl-conglomerate')], { ...MOCK_MF_PEERS, peerRows, run: running }));
      expect(out).toMatch(/Regular is [\d.]+ points a year above Direct/);
      expect(out).toMatch(/Not loaded yet/);
    });
  });
});
