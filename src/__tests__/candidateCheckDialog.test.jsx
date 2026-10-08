import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CandidateReport, CandidateCheckDialog } from '../CandidateCheckDialog.jsx';

const fullReport = {
  ticker: 'AAPL', isEtf: false,
  overlap: {
    overlapPct: 42.5, sharedCount: 2,
    topShared: [
      { key: 'T:AAPL', label: 'Apple', wA: 40, wB: 100 },
      { key: 'T:MSFT', label: 'Microsoft', wA: 5, wB: 3 },
    ],
  },
  concBefore: { numHoldings: 10, effectiveN: 6.2, verdict: 'highly concentrated' },
  concAfter: { numHoldings: 10, effectiveN: 5.1, verdict: 'highly concentrated' },
  posPctAfter: 33.3,
  factors: {
    price: 180,
    pos52: { high: 200, low: 120, nearHighPct: 10, rangePct: 75 },
    valuation: { peTTM: 28, beta: 1.1 },
    analyst: { counts: { strongBuy: 5, buy: 5, hold: 1, sell: 0, strongSell: 0, period: '2026-10' }, trend: 'improving' },
  },
  evaluation: {
    flags: [
      { id: 'overlap', severity: 'pass', label: 'Overlap 42.5% — within your 60% line' },
      { id: 'position', severity: 'caution', label: 'This position would be 33.3%, over your 25% single-name cap' },
    ],
    cautionCount: 1, passCount: 1,
  },
};

describe('CandidateReport (presentational)', () => {
  it('renders a full briefing with overlap, concentration, factors and flags', () => {
    const html = renderToStaticMarkup(<CandidateReport report={fullReport} />);
    expect(html).toContain('42.5%');                 // overlap headline
    expect(html).toContain('6.2 effective holdings');
    expect(html).toContain('→ 5.1 after');
    expect(html).toContain('Apple');                 // top shared name
    expect(html).toContain('no free sector baseline'); // neutral P/E label, no fabricated sector
    expect(html).toContain('1 of 2 flag caution');
    expect(html).toMatch(/not a buy or sell recommendation/i); // the explicit no-verdict line
  });

  it('renders without crashing when every market factor is missing', () => {
    const bare = {
      ticker: 'NVDA', isEtf: true,
      overlap: { overlapPct: 0, sharedCount: 0, topShared: [] },
      concBefore: { numHoldings: 0, effectiveN: 0, verdict: 'no data' },
      concAfter: null, posPctAfter: null,
      factors: { price: null, pos52: null, valuation: { peTTM: null, beta: null }, analyst: { counts: null, trend: null } },
      evaluation: { flags: [], cautionCount: 0, passCount: 0 },
    };
    const html = renderToStaticMarkup(<CandidateReport report={bare} />);
    expect(html).toContain('No shared holdings');
    expect(html).toContain('No current holdings to compare against yet.');
    expect(html).toContain('Not enough data to run any rule yet.');
  });

  it('returns nothing for a null report', () => {
    expect(renderToStaticMarkup(<CandidateReport report={null} />)).toBe('');
  });
});

describe('CandidateCheckDialog (initial form)', () => {
  it('mounts with the input form and prefilled ticker, no crash', () => {
    const html = renderToStaticMarkup(
      <CandidateCheckDialog
        holdings={[]} positions={[]} portfolioTotal={0} quotes={{}}
        settings={{ preBuyThresholds: {}, investEtfSymbols: [] }}
        sheetId="s" accessToken="t" prefillTicker="VOO" onClose={() => {}}
      />
    );
    expect(html).toContain('Candidate check');
    expect(html).toContain('Run check');
    expect(html).toContain('value="VOO"'); // prefilled
  });
});
