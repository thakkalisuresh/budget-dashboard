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
    expect(out).toMatch(/CDN blocked/);
    expect(out).toMatch(/not enough history/);
  });
  it('first run: held rows only, peers loading, TER tab empty', () => {
    const data = { ...MOCK_MF_PEERS, peerRows: MOCK_MF_PEERS.peerRows.filter(r => r.role === 'held'), terRows: [], run: { peers: { done: 12, total: 100, finishedAt: '' } } };
    const out = html(build([F('absl-flexi-cap')], data));
    expect(out).toMatch(/STILL LOADING · 12\/100/);
    expect(out).toMatch(/Peer data for this fund has not loaded yet/);
    expect(out).toMatch(/n\/a/);
  });
  it('a failed peer is listed as left out of the ranks', () => {
    expect(html(build([F('iti-small-cap')]))).toMatch(/Left out of the ranks[^<]*Quant Small Cap/);
  });
  it('stale rows get the amber badge', () => {
    const peerRows = MOCK_MF_PEERS.peerRows.map(r => ({ ...r, asOf: '2026-06-01' }));
    expect(html(build([F('absl-flexi-cap')], { ...MOCK_MF_PEERS, peerRows }))).toMatch(/MAY BE OUT OF DATE/);
  });
});
