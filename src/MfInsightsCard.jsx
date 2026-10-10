// ════════════════════════════════════════════════════════════════════════════
// MfInsightsCard.jsx — "Portfolio health" under the Indian MF holdings. All the
// maths is in mfInsights.js (pure, tested); this only reads data and draws it.
// Self-contained: its own NAV read (server-cached, same hook as MfHoldings) and
// its own holdings read (useMfHoldings). Colour is never the only signal: every
// segment/flag also carries a glyph and a number.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo } from 'react';
import { Activity, Eye, Info } from 'lucide-react';
import { useMfNav, cleanCodes } from './useMfNav.js';
import { useMfHoldings } from './mfHoldingsApi.js';
import { buildMfView } from './investMfView.js';
import { buildMfInsights, GROUP_LABELS } from './mfInsights.js';
import { MOCK_MF_NAV } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

// Fixed-order, CVD-checked chart palette (docs/INVEST.md) + a glyph per slot.
const SERIES = [
  { color: '#6366f1', glyph: '■' }, { color: '#d97706', glyph: '●' }, { color: '#0d9488', glyph: '▲' },
  { color: '#f43f5e', glyph: '◆' }, { color: '#0284c7', glyph: '★' },
];
const slot = (i) => SERIES[i % SERIES.length];

const label = { fontSize: 10, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-muted)' };
const sub = { fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-text-muted)' };
const badge = { fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', padding: '2px 5px', borderRadius: 5, whiteSpace: 'nowrap' };
const section = { padding: '14px 16px', borderTop: '1px solid var(--sur-8)' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtAsOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
}
const pct = (n, d = 1) => `${Number(n).toFixed(d).replace(/\.0$/, '')}%`;

const SEVERITY = {
  watch: { text: 'Worth keeping an eye on', Icon: Eye, color: 'var(--color-warning)', bg: 'oklch(75% 0.15 75 / 12%)' },
  info: { text: 'For awareness', Icon: Info, color: 'var(--color-accent-text)', bg: 'var(--sur-6)' },
};

function Flag({ f }) {
  const s = SEVERITY[f.severity];
  return (
    <li style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '9px 11px', borderRadius: 12, background: s.bg, listStyle: 'none' }}>
      <s.Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: s.color, marginTop: 2 }} aria-hidden="true" />
      <div style={{ minWidth: 0 }}>
        <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-text)' }}>
          <span style={{ ...badge, color: s.color, border: `1px solid ${s.color}`, marginRight: 6 }}>{s.text.toUpperCase()}</span>
          {f.message}
        </p>
        {f.asOf.length > 0 && <p style={{ fontSize: 10, marginTop: 3, color: 'var(--color-text-muted)' }}>Holdings as of {f.asOf.map(fmtAsOf).join(' and ')}</p>}
      </div>
    </li>
  );
}

function CategoryMix({ ins }) {
  const mix = ins.categoryMix;
  return (
    <div style={section}>
      <p style={sub}>Category mix · {ins.basis === 'value' ? 'by current value' : 'by SIP amount'}</p>
      <div role="img" aria-label={`Category mix: ${mix.map(c => `${c.categoryKey} ${pct(c.pct)}`).join(', ')}`}
        style={{ display: 'flex', height: 14, borderRadius: 7, overflow: 'hidden', marginTop: 9, background: 'var(--sur-8)', gap: 2 }}>
        {mix.map((c, i) => (
          <span key={c.categoryKey} title={`${c.categoryKey} ${pct(c.pct)}`}
            style={{ width: `${c.pct}%`, background: slot(i).color, minWidth: c.pct > 0 ? 3 : 0 }} />
        ))}
      </div>
      <ul style={{ display: 'grid', gap: 5, marginTop: 10, padding: 0 }}>
        {mix.map((c, i) => (
          <li key={c.categoryKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, listStyle: 'none' }}>
            <span style={{ minWidth: 0, color: 'var(--color-text-secondary)' }}>
              <span aria-hidden="true" style={{ color: slot(i).color, marginRight: 6 }}>{slot(i).glyph}</span>
              {c.categoryKey}{c.assumed ? ' (assumed)' : ''}
              <span style={{ color: 'var(--color-text-muted)' }}> · {c.funds.join(', ')}</span>
            </span>
            <b className="tabular-nums" style={{ color: 'var(--color-text)', flexShrink: 0 }}>{pct(c.pct)}</b>
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 11, marginTop: 9, color: 'var(--color-text-secondary)' }}>
        {Object.entries(ins.groupMix).map(([g, v]) => `${GROUP_LABELS[g] || g} ${pct(v)}`).join(' · ')}
      </p>
      {ins.holdings.funds.filter(f => f.available).length > 0 && (
        <p style={{ fontSize: 10.5, marginTop: 4, color: 'var(--color-text-muted)' }}>
          Look-through equity share from holdings: {ins.holdings.funds.filter(f => f.available).map(f => `${f.label} ${pct(f.equityPct)}`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function SipSplit({ ins }) {
  const rows = ins.sipSplit.filter(s => s.sipSharePct != null);
  if (!rows.length) return null;
  const hasValue = rows.some(s => s.valueSharePct != null);
  return (
    <div style={section}>
      <p style={sub}>SIP split{hasValue ? ' vs current value' : ''}</p>
      <ul style={{ display: 'grid', gap: 6, marginTop: 8, padding: 0 }}>
        {rows.map(s => (
          <li key={s.planId} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, listStyle: 'none' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{s.label}</span>
            <span className="tabular-nums" style={{ color: 'var(--color-text)', flexShrink: 0 }}>
              <b>{pct(s.sipSharePct)}</b> of SIPs{s.valueSharePct != null ? <span style={{ color: 'var(--color-text-muted)' }}> · {pct(s.valueSharePct)} of value</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Overlap({ ins }) {
  const pairs = [...ins.overlap.pairs].sort((a, b) => b.overlapPct - a.overlapPct);
  const t = ins.thresholds;
  if (!pairs.length) return null;
  return (
    <div style={section}>
      <p style={sub}>Holdings overlap · equity part of each fund</p>
      <ul style={{ display: 'grid', gap: 10, marginTop: 9, padding: 0 }}>
        {pairs.map(p => {
          const sev = p.overlapPct >= t.pairOverlapPct ? 'watch' : p.overlapPct >= t.pairOverlapInfoPct ? 'info' : null;
          return (
            <li key={`${p.a}|${p.b}`} style={{ listStyle: 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5 }}>
                <span style={{ color: 'var(--color-text-secondary)', minWidth: 0 }}>{p.aLabel} × {p.bLabel}</span>
                <b className="tabular-nums" style={{ color: 'var(--color-text)', flexShrink: 0 }}>
                  {sev && <span style={{ ...badge, marginRight: 6, color: SEVERITY[sev].color, border: `1px solid ${SEVERITY[sev].color}` }}>{sev === 'watch' ? 'WATCH' : 'INFO'}</span>}
                  {pct(p.overlapPct)}
                </b>
              </div>
              <div aria-hidden="true" style={{ height: 5, borderRadius: 3, background: 'var(--sur-8)', marginTop: 4 }}>
                <div style={{ width: `${Math.min(100, p.overlapPct)}%`, height: '100%', borderRadius: 3, background: 'var(--color-accent)' }} />
              </div>
              <p style={{ fontSize: 10.5, marginTop: 3, color: 'var(--color-text-muted)' }}>
                {p.commonCount} stocks in common · equity covers {pct(p.equityCoverage.a)} and {pct(p.equityCoverage.b)} of the two funds · {pct(p.rawPct)} of NAV unscaled
              </p>
              {p.topShared.length > 0 && (
                <details style={{ marginTop: 3 }}>
                  <summary style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--color-accent-text)', cursor: 'pointer' }}>Top shared stocks</summary>
                  <ul style={{ display: 'grid', gap: 3, marginTop: 5, padding: 0 }}>
                    {p.topShared.map(s => (
                      <li key={s.isin || s.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, listStyle: 'none', color: 'var(--color-text-secondary)' }}>
                        <span style={{ minWidth: 0 }}>{s.name}</span>
                        <span className="tabular-nums" style={{ flexShrink: 0 }}>{pct(s.wA, 2)} / {pct(s.wB, 2)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Exposure({ ins }) {
  const ex = ins.exposure;
  if (!ex.coveredFunds.length) return null;
  return (
    <div style={section}>
      <p style={sub}>Stocks and sectors across the funds</p>
      <p style={{ fontSize: 11.5, marginTop: 7, color: 'var(--color-text-secondary)' }}>
        {ex.stockCount} distinct stocks; the top 10 are {pct(ex.top10Pct)} of the portfolio ({pct(ex.top10SharePct)} of the stock holdings). Effective number of stocks: about {ex.effectiveN}.
      </p>
      <p style={{ ...sub, marginTop: 10 }}>Largest stock exposures</p>
      <ul style={{ display: 'grid', gap: 3, marginTop: 5, padding: 0 }}>
        {ex.top10.slice(0, 5).map(s => (
          <li key={s.isin || s.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, listStyle: 'none' }}>
            <span style={{ minWidth: 0, color: 'var(--color-text-secondary)' }}>{s.name}<span style={{ color: 'var(--color-text-muted)' }}> · {s.funds.length} fund{s.funds.length > 1 ? 's' : ''}</span></span>
            <b className="tabular-nums" style={{ color: 'var(--color-text)', flexShrink: 0 }}>{pct(s.pct, 2)}</b>
          </li>
        ))}
      </ul>
      <p style={{ ...sub, marginTop: 10 }}>Largest sectors</p>
      <ul style={{ display: 'grid', gap: 3, marginTop: 5, padding: 0 }}>
        {ex.sectors.slice(0, 5).map(s => (
          <li key={s.sector} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11.5, listStyle: 'none', color: 'var(--color-text-secondary)' }}>
            <span>{s.sector}</span><b className="tabular-nums" style={{ color: 'var(--color-text)' }}>{pct(s.pct)}</b>
          </li>
        ))}
      </ul>
      {ex.lowerBound && <p style={{ fontSize: 10.5, marginTop: 8, color: 'var(--color-text-muted)' }}>Covers {pct(ex.coveragePct)} of the portfolio, so these are minimums.</p>}
    </div>
  );
}

function Explainer({ ins }) {
  const t = ins.thresholds;
  return (
    <details style={{ ...section }}>
      <summary style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>How this is calculated</summary>
      <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 8, color: 'var(--color-text-muted)', display: 'grid', gap: 6 }}>
        <p>{ins.basisNote} Funds are matched to the AMCs’ monthly portfolio files by scheme; categories come from AMFI, or a fixed table when a fund is not mapped yet (marked “assumed”).</p>
        <p>Overlap between two funds adds up, for every stock both hold, the smaller of its two weights, after scaling each fund’s equity holdings to 100%. Debt, cash and derivatives are left out.</p>
        <p>Stock and sector exposure multiplies each fund’s share of the portfolio by the stock’s weight inside that fund, then adds across funds. Effective number of stocks is 1 divided by the sum of squared shares, so a few large positions pull it down.</p>
        <p>Markers used: pair overlap {t.pairOverlapInfoPct}% (awareness) and {t.pairOverlapPct}% (keep an eye on); one stock {t.singleStockPct}%; one sector {t.sectorPct}%; one category {t.categoryPct}%; one fund {t.sipSharePct}% of SIPs. Holdings older than 45 days are marked as possibly out of date.</p>
        <p>Everything is rule-based on public data; nothing here is a recommendation.</p>
      </div>
    </details>
  );
}

export function MfInsightsCard({ user, settings, accounts, activities, sipPlans, sheetId }) {
  const mfIds = useMemo(() => accounts.filter(a => a.type === 'mf_in').map(a => a.id), [accounts]);
  const codes = useMemo(() => (DEV_MOCK ? [] : cleanCodes(sipPlans.map(p => p.schemeCode))), [sipPlans]);
  const live = useMfNav(codes, user.accessToken);
  const navs = DEV_MOCK ? MOCK_MF_NAV.navs : live.navs;
  const { data: holdings, loading } = useMfHoldings({ sheetId, accessToken: user.accessToken, enabled: mfIds.length > 0 && sipPlans.length > 0 });

  const ins = useMemo(() => {
    const view = buildMfView({ plans: sipPlans, activities, accountIds: mfIds, navs, fx: null, currency: 'INR' });
    return buildMfInsights({ funds: view.funds, navs, holdings, thresholds: settings?.mfInsightThresholds });
  }, [sipPlans, activities, mfIds, navs, holdings, settings?.mfInsightThresholds]);

  if (!mfIds.length || !sipPlans.length) return null;

  const watch = ins.flags.filter(f => f.severity === 'watch');
  const info = ins.flags.filter(f => f.severity === 'info');
  const asOfFunds = ins.holdings.funds.filter(f => f.available);

  return (
    <section aria-label="Mutual fund portfolio health" style={{ marginBottom: 14 }}>
      <div style={{ padding: '8px 2px 10px' }}>
        <p style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}><Activity className="w-3.5 h-3.5" aria-hidden="true" /> Portfolio health · India</p>
      </div>
      <div style={{ borderRadius: 22, overflow: 'hidden', background: 'var(--sur-4)', border: '1px solid var(--sur-10)' }}>
        <div style={{ padding: '14px 16px' }}>
          <p style={{ fontSize: 14, fontWeight: 900, color: 'var(--color-text)', lineHeight: 1.35 }}>{ins.headline}</p>
          {asOfFunds.length > 0 && (
            <p style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {asOfFunds.map(f => (
                <span key={f.fundKey} style={{ ...badge, color: f.stale ? 'var(--color-warning)' : 'var(--color-text-muted)', background: f.stale ? 'oklch(75% 0.15 75 / 14%)' : 'var(--sur-8)' }}>
                  {f.label.toUpperCase()} · {fmtAsOf(f.asOf)}{f.stale ? ' · MAY BE OUT OF DATE' : ''}
                </span>
              ))}
            </p>
          )}
          {ins.holdings.status === 'no-holdings' && (
            <p role="note" style={{ fontSize: 11.5, marginTop: 8, color: 'var(--color-text-muted)' }}>
              {loading ? 'Looking for holdings data…' : 'Holdings data is not available yet, so overlap and concentration are not shown. The category mix and SIP split below do not need it.'}
            </p>
          )}
        </div>

        {ins.flags.length > 0 && (
          <div style={{ ...section, display: 'grid', gap: 7 }}>
            <ul style={{ display: 'grid', gap: 7, padding: 0, margin: 0 }}>
              {watch.map(f => <Flag key={f.id} f={f} />)}
              {info.map(f => <Flag key={f.id} f={f} />)}
            </ul>
          </div>
        )}

        <CategoryMix ins={ins} />
        <SipSplit ins={ins} />
        <Overlap ins={ins} />
        <Exposure ins={ins} />

        {ins.notes.filter(n => n.kind !== 'no-holdings').length > 0 && (
          <div style={section}>
            <p style={sub}>Data notes</p>
            <ul style={{ display: 'grid', gap: 5, marginTop: 7, padding: 0 }}>
              {ins.notes.filter(n => n.kind !== 'no-holdings').map(n => (
                <li key={n.id} style={{ fontSize: 11, lineHeight: 1.5, listStyle: 'none', color: n.kind === 'stale' || n.kind === 'status' ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>{n.message}</li>
              ))}
            </ul>
          </div>
        )}

        <Explainer ins={ins} />
      </div>
      <p style={{ fontSize: 10.5, marginTop: 8, padding: '0 2px', color: 'var(--color-text-muted)' }}>{ins.disclaimer}</p>
    </section>
  );
}
