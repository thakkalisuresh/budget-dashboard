import React, { useState } from 'react';
import { Search, AlertTriangle, CheckCircle2, MinusCircle, Layers, PieChart, Activity } from 'lucide-react';
import { Sheet, Field, ErrorNote, inputCls, inputStyle } from './InvestDialogs.jsx';
import { isEtf } from './investMath.js';
import { aggregatePortfolio, buildCandidateReport } from './investInsights.js';
import { fetchEtfHoldings, fetchMarketFactors, resolveCusipTickers } from './investApi.js';

// ════════════════════════════════════════════════════════════════════════════
// CandidateCheckDialog — type a ticker, get a decision-support briefing: overlap
// with current holdings, concentration delta, market-factor relay, and a
// transparent "worth it?" rule-check. Deterministic, no LLM, NO buy/sell verdict.
// Also closes PR1's CUSIP↔ticker gap so a direct stock and the same company held
// inside an ETF count as one holding. Read-only analysis → shown even in
// read-only mode (unlike Import / Activity).
// ════════════════════════════════════════════════════════════════════════════

const TICKER_RE = /^[A-Z0-9.^-]{1,10}$/;

// CVD-validated: caution = amber, pass = teal. Colour is NEVER the only signal —
// every flag carries an icon + text.
const SEV = {
  caution: { color: '#d97706', Icon: AlertTriangle },
  pass:    { color: '#0d9488', Icon: CheckCircle2 },
  neutral: { color: 'var(--color-text-muted)', Icon: MinusCircle },
};

function pct(x, d = 1) {
  return Number.isFinite(Number(x)) ? `${(Math.round(Number(x) * 10 ** d) / 10 ** d).toFixed(d)}%` : '—';
}

function SectionLabel({ icon: Icon, children }) {
  return (
    <p style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
      <Icon className="w-3.5 h-3.5" /> {children}
    </p>
  );
}

function Card({ children }) {
  return (
    <div style={{ borderRadius: 18, padding: '14px 16px', background: 'var(--sur-4)', border: '1px solid var(--sur-10)', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {children}
    </div>
  );
}

/** Presentational — exported so it can be smoke-tested with a mock report. */
export function CandidateReport({ report }) {
  if (!report) return null;
  const { overlap, concBefore, concAfter, posPctAfter, factors, evaluation, isEtf: etf } = report;
  const { pos52, valuation, analyst } = factors || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Overlap */}
      <Card>
        <SectionLabel icon={Layers}>Overlap with what you own</SectionLabel>
        <p style={{ fontSize: 26, fontWeight: 900, color: 'var(--color-text)', lineHeight: 1 }}>
          {pct(overlap?.overlapPct)}
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-muted)', marginLeft: 8 }}>already owned</span>
        </p>
        {overlap?.topShared?.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {overlap.topShared.slice(0, 6).map((s) => (
              <span key={s.key} style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', borderRadius: 7, background: 'var(--sur-8)', color: 'var(--color-text-secondary)' }}>
                {s.label} · {pct(Math.min(s.wA, s.wB))}
              </span>
            ))}
          </div>
        ) : (
          <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>No shared holdings with your current portfolio.</p>
        )}
      </Card>

      {/* Concentration delta */}
      <Card>
        <SectionLabel icon={PieChart}>Concentration</SectionLabel>
        {concBefore?.numHoldings > 0 ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-text)' }}>
                {concBefore.effectiveN} effective holdings
              </span>
              {concAfter && (
                <span style={{ fontSize: 13, fontWeight: 800, color: concAfter.effectiveN < concBefore.effectiveN ? '#d97706' : '#0d9488' }}>
                  → {concAfter.effectiveN} after
                </span>
              )}
            </div>
            <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              Now {concBefore.verdict}{concAfter ? ` → ${concAfter.verdict}` : ''}.
              {posPctAfter != null && <> This position would be {pct(posPctAfter)} of the total.</>}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>No current holdings to compare against yet.</p>
        )}
      </Card>

      {/* Market factors — facts only */}
      <Card>
        <SectionLabel icon={Activity}>Market factors</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px' }}>
          <Factor label="52-week position">
            {pos52 ? (pos52.rangePct != null ? `${pct(pos52.rangePct, 0)} of range` : `${pct(pos52.nearHighPct)} below high`) : '—'}
          </Factor>
          <Factor label="Below 52-wk high">{pos52 ? pct(pos52.nearHighPct) : '—'}</Factor>
          <Factor label="P/E (TTM)">
            {valuation?.peTTM != null ? valuation.peTTM.toFixed(1) : '—'}
            <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--color-text-muted)', marginLeft: 4 }}>no free sector baseline</span>
          </Factor>
          <Factor label="Beta">{valuation?.beta != null ? valuation.beta.toFixed(2) : '—'}</Factor>
          <Factor label="Analyst sentiment">
            {analyst?.trend ? analyst.trend : (analyst?.counts ? 'single period' : '—')}
          </Factor>
          <Factor label="Latest ratings">
            {analyst?.counts
              ? `${analyst.counts.strongBuy + analyst.counts.buy} buy · ${analyst.counts.hold} hold · ${analyst.counts.sell + analyst.counts.strongSell} sell`
              : '—'}
          </Factor>
        </div>
      </Card>

      {/* Rule-check */}
      <Card>
        <SectionLabel icon={etf ? Layers : Activity}>
          Worth it? — your rule-check{etf ? ' · ETF' : ''}
        </SectionLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {evaluation?.flags?.length > 0 ? evaluation.flags.map((f) => {
            const s = SEV[f.severity] || SEV.neutral;
            const Icon = s.Icon;
            return (
              <div key={f.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Icon className="w-4 h-4" style={{ color: s.color, flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                  <span style={{ color: s.color, fontWeight: 800 }}>{f.severity === 'caution' ? 'Caution: ' : f.severity === 'pass' ? 'OK: ' : ''}</span>
                  {f.label}
                </span>
              </div>
            );
          }) : (
            <p style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>Not enough data to run any rule yet.</p>
          )}
        </div>
        <p style={{ fontSize: 12, fontWeight: 800, color: 'var(--color-text)' }}>
          {evaluation?.cautionCount || 0} of {evaluation?.flags?.length || 0} flag caution
          {evaluation?.passCount ? ` · ${evaluation.passCount} pass` : ''}.
        </p>
        <p style={{ fontSize: 10.5, lineHeight: 1.5, color: 'var(--color-text-muted)', borderTop: '1px solid var(--sur-8)', paddingTop: 8 }}>
          You set every threshold — this is a transparent rule-check against your own limits, not a buy or sell recommendation.
        </p>
      </Card>
    </div>
  );
}

function Factor({ label, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <p style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{label}</p>
      <p style={{ fontSize: 13, fontWeight: 800, color: 'var(--color-text)', marginTop: 2 }}>{children}</p>
    </div>
  );
}

export function CandidateCheckDialog({
  holdings = [], positions = [], portfolioTotal = 0, quotes = {},
  settings, sheetId, accessToken, prefillTicker = '', onClose,
}) {
  const [ticker, setTicker] = useState(String(prefillTicker || '').toUpperCase());
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null);

  const extraEtfs = settings?.investEtfSymbols || [];
  const thresholds = settings?.preBuyThresholds || {};

  const runCheck = async () => {
    const sym = ticker.trim().toUpperCase();
    setError('');
    if (!TICKER_RE.test(sym)) { setError('Enter a valid ticker symbol, e.g. VOO or AAPL.'); return; }
    if (!accessToken) { setError('Not signed in.'); return; }
    const amt = parseFloat(amount);
    const amount$ = amt > 0 ? amt : 0;

    setLoading(true);
    setReport(null);
    try {
      const candidateIsEtf = isEtf(sym, extraEtfs);

      // 1. Candidate holdings: ETF → look-through; stock → itself at 100%.
      let candidateHoldings = [{ ticker: sym, name: sym, cusip: '', weight: 100 }];
      if (candidateIsEtf) {
        try {
          const data = await fetchEtfHoldings(sheetId, accessToken, sym);
          if (data.holdings?.length) candidateHoldings = data.holdings;
        } catch (e) {
          // No N-PORT (e.g. a brand-new or non-US ETF) → treat as a single holding.
          console.warn('Candidate look-through unavailable:', e?.message);
        }
      }

      // 2. Look-through for the user's held ETFs (cache-first, failures tolerated).
      const heldEtfSyms = [...new Set(holdings.map((h) => String(h.symbol).toUpperCase()).filter((s) => isEtf(s, extraEtfs)))];
      const etfHoldingsByTicker = {};
      await Promise.all(heldEtfSyms.map(async (s) => {
        try {
          const d = await fetchEtfHoldings(sheetId, accessToken, s);
          if (d.holdings?.length) etfHoldingsByTicker[s] = { holdings: d.holdings };
        } catch { /* ETF without look-through stays a direct holding */ }
      }));

      // 3. CUSIP↔ticker reconciliation across both identity spaces.
      const cacheRows = [
        ...candidateHoldings,
        ...Object.values(etfHoldingsByTicker).flatMap((e) => e.holdings),
      ];
      const wantedCusips = cacheRows.map((h) => h.cusip).filter(Boolean);
      const cusipTicker = await resolveCusipTickers({ sheetId, accessToken, cacheRows, wantedCusips });

      // 4. User aggregate + 5. market factors (parallel).
      const [market] = await Promise.all([fetchMarketFactors(sym, accessToken)]);
      const aggPortfolio = aggregatePortfolio({ holdings, quotes, etfHoldingsByTicker, extraEtfs, cusipTicker });

      // 6. Assemble the briefing (pure).
      setReport(buildCandidateReport({
        candidateTicker: sym, candidateHoldings, isEtfCandidate: candidateIsEtf,
        aggPortfolio, positions, portfolioTotal, amount: amount$, cusipTicker, market, thresholds,
      }));
    } catch (e) {
      setError(e?.message || 'Could not run the check.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Sheet title="Candidate check" subtitle="Overlap, concentration & your rule-check — never a verdict" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ticker">
          <input
            type="text" value={ticker} autoFocus autoCapitalize="characters"
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') runCheck(); }}
            className={inputCls} style={inputStyle} placeholder="VOO" />
        </Field>
        <Field label="Add amount (optional)">
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>{currencyGlyph()}</span>
            <input
              type="number" step="0.01" min="0" value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runCheck(); }}
              className={`${inputCls} pl-8`} style={inputStyle} placeholder="2000" />
          </div>
        </Field>
      </div>

      <button
        onClick={runCheck} disabled={loading}
        className="w-full py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2"
        style={{ background: 'var(--color-accent)' }}>
        <Search className="w-4 h-4" />
        {loading ? 'Checking…' : 'Run check'}
      </button>

      <ErrorNote error={error} />

      {report && <CandidateReport report={report} />}
    </Sheet>
  );
}

// The dialog is purely dollar-denominated here (brokerage); the app's currency
// symbol isn't threaded into dialogs, so use a plain $ like AddActivityDialog.
function currencyGlyph() { return '$'; }
