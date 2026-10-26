import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNportXml, getEtfHoldings, resolveFund, _resetEdgarCache } from '../../functions/edgarService.mjs';

// Saved, trimmed real N-PORT filing (SPDR DIA, CIK 1041130, 2026-07-31).
// NEVER hit data.sec.gov in tests — the fixture is the source of truth.
const xml = readFileSync(new URL('./fixtures/nport-dia.xml', import.meta.url), 'utf8');
const xmlSeries500 = readFileSync(new URL('./fixtures/nport-series-500.xml', import.meta.url), 'utf8');
const xmlSeriesOther = readFileSync(new URL('./fixtures/nport-series-other.xml', import.meta.url), 'utf8');

// In-instance caches (ticker map, series CSV) are module-level; reset per test.
beforeEach(() => _resetEdgarCache());

describe('parseNportXml (N-PORT holdings → normalized shape)', () => {
  const out = parseNportXml(xml);

  it('yields the normalized envelope', () => {
    expect(out.source).toBe('NPORT-P');
    expect(out.asOf).toBe('2026-07-31');
    expect(out.cik).toBe('1041130');
    expect(out.holdings).toHaveLength(7);
  });

  it('keys every holding on its CUSIP, preserving leading zeros', () => {
    expect(out.holdings.every((h) => h.cusip)).toBe(true);
    const apple = out.holdings.find((h) => h.name === 'Apple Inc');
    expect(apple.cusip).toBe('037833100'); // NOT coerced to the number 37833100
    const alphabet = out.holdings.find((h) => h.name === 'Alphabet Inc');
    expect(alphabet.cusip).toBe('02079K305');
  });

  it('extracts a best-effort ticker only when the filer supplied one', () => {
    const apple = out.holdings.find((h) => h.name === 'Apple Inc');
    expect(apple.ticker).toBe('AAPL'); // injected <ticker value="AAPL"/>
    // Every other holding in this filing carries only ISIN/CUSIP — no ticker.
    expect(out.holdings.filter((h) => h.ticker).length).toBe(1);
  });

  it('renormalizes weights to sum ~100 (this is a partial 7-of-30 slice)', () => {
    const sum = out.holdings.reduce((s, h) => s + h.weight, 0);
    expect(sum).toBeCloseTo(100, 2);
    // Caterpillar is the heaviest of the slice (raw 9.22% of 30.43% ≈ 30.3%).
    const top = [...out.holdings].sort((a, b) => b.weight - a.weight)[0];
    expect(top.name).toBe('Caterpillar Inc');
    expect(top.weight).toBeCloseTo(30.3, 1);
  });

  it('reports an empty seriesId for a standalone trust', () => {
    expect(out.seriesId).toBe(''); // DIA trust is single-series
  });

  it('is resilient to an empty / holdings-less document', () => {
    const empty = parseNportXml('<edgarSubmission><formData><genInfo></genInfo></formData></edgarSubmission>');
    expect(empty).toMatchObject({ source: 'NPORT-P', holdings: [] });
  });
});

describe('getEtfHoldings (orchestration, fixture-backed fetch — no live network)', () => {
  // Fake fetch that serves the three EDGAR stages from local data.
  const fakeFetch = (url) => {
    if (url.includes('company_tickers.json')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ 0: { cik_str: 1041130, ticker: 'DIA', title: 'SPDR DIA' } }) });
    }
    if (url.includes('/submissions/CIK')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        filings: { recent: { form: ['10-K', 'NPORT-P'], accessionNumber: ['x', '0001410368-26-095867'], filingDate: ['2026-01-01', '2026-09-18'] } },
      }) });
    }
    if (url.includes('primary_doc.xml')) {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(xml) });
    }
    return Promise.resolve({ ok: false, status: 404 });
  };

  it('resolves ticker → CIK → latest NPORT-P → parsed holdings', async () => {
    const out = await getEtfHoldings('DIA', { userAgent: 'Test/1.0 test@example.com', fetchFn: fakeFetch });
    expect(out.ticker).toBe('DIA');
    expect(out.cik).toBe('1041130');
    expect(out.source).toBe('NPORT-P');
    expect(out.holdings).toHaveLength(7);
  });

  it('requires a descriptive User-Agent (SEC fair-access)', async () => {
    await expect(getEtfHoldings('DIA', { fetchFn: fakeFetch })).rejects.toThrow(/userAgent/i);
  });

  it('throws a clear error for an unknown ticker', async () => {
    await expect(getEtfHoldings('ZZZZ', { userAgent: 'Test/1.0', fetchFn: fakeFetch })).rejects.toThrow(/Unknown ticker/i);
  });
});

describe('getEtfHoldings — multi-series trust (CSV fallback + series scan)', () => {
  // VOO is NOT in company_tickers.json; it lives in the Series & Class dataset
  // under a trust CIK with many series. The target series filing must be found
  // among the trust's NPORT-P filings, skipping sibling series.
  const CSV = [
    'Reporting File Number,CIK Number,Entity Name,Entity Org Type,Series ID,Series Name,Class ID,Class Name,Class Ticker,Address_1',
    '811-02652,0000036405,VANGUARD INDEX FUNDS,30,S000002839,Vanguard 500 Index Fund,C000092055,ETF Shares,VOO,PO BOX 2600',
  ].join('\n');

  // A more recent sibling-series filing (accA) is listed before VOO's (accB).
  const fakeFetch = (url) => {
    if (url.includes('company_tickers.json')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) }); // VOO absent
    if (url.includes('investment-company-series-class')) return Promise.resolve({ ok: true, text: () => Promise.resolve(CSV) });
    if (url.includes('/submissions/CIK')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        filings: { recent: { form: ['NPORT-P', 'NPORT-P'], accessionNumber: ['0000000000-26-000001', '0000000000-26-000002'], filingDate: ['2026-08-28', '2026-08-28'] } },
      }) });
    }
    if (url.includes('000000000026000001')) return Promise.resolve({ ok: true, text: () => Promise.resolve(xmlSeriesOther) }); // sibling — skip
    if (url.includes('000000000026000002')) return Promise.resolve({ ok: true, text: () => Promise.resolve(xmlSeries500) });  // VOO — match
    return Promise.resolve({ ok: false, status: 404 });
  };

  it('resolveFund falls back to the Series & Class dataset and returns the seriesId', async () => {
    const r = await resolveFund('VOO', { userAgent: 'Test/1.0', fetchFn: fakeFetch });
    expect(r).toMatchObject({ cik: '0000036405', seriesId: 'S000002839' });
  });

  it('scans NPORT-P filings and selects the one matching the series', async () => {
    const out = await getEtfHoldings('VOO', { userAgent: 'Test/1.0', fetchFn: fakeFetch });
    expect(out.ticker).toBe('VOO');
    expect(out.seriesId).toBe('S000002839');
    expect(out.holdings.map((h) => h.name)).toContain('NVIDIA Corp');  // from VOO's series
    expect(out.holdings.map((h) => h.name)).not.toContain('Tesla Inc'); // sibling series skipped
    expect(out.holdings.reduce((s, h) => s + h.weight, 0)).toBeCloseTo(100, 2);
  });

  it('throws when the series is not found within the scan budget', async () => {
    await expect(
      getEtfHoldings('VOO', { userAgent: 'Test/1.0', fetchFn: fakeFetch, maxSeriesScan: 1 }),
    ).rejects.toThrow(/No NPORT-P filing for series/i);
  });
});
