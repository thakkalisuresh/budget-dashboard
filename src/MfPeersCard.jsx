// ════════════════════════════════════════════════════════════════════════════
// MfPeersCard.jsx — "Fund vs peers" under the Indian MF portfolio-health card. All
// the maths is in mfPeers.js (pure, tested); this only reads data and draws it.
// Self-contained: own NAV read (same server-cached hook as MfHoldings) and own
// peer-data read (useMfPeers). Neutral wording only: ranks, medians, gaps. Colour
// is never the only signal: positions carry a glyph and a number.
// ════════════════════════════════════════════════════════════════════════════
import { useMemo, useState } from 'react';
import { Users, Info } from 'lucide-react';
import { useMfNav, cleanCodes } from './useMfNav.js';
import { useMfPeers } from './mfPeersApi.js';
import { buildMfView } from './investMfView.js';
import { fundKeyFor, fundLabel } from './mfInsights.js';
import { buildMfPeers, ordinal, PLAN_LABELS, METRICS } from './mfPeers.js';
import { MOCK_MF_NAV } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

const label = { fontSize: 10, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-muted)' };
const sub = { fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-text-muted)' };
const badge = { fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', padding: '2px 5px', borderRadius: 5, whiteSpace: 'nowrap' };
const section = { padding: '14px 16px', borderTop: '1px solid var(--sur-8)' };
const muted = { color: 'var(--color-text-muted)' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtAsOf(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '—';
}
const fmt = (n, d = 1) => (n == null ? 'n/a' : `${Number(n).toFixed(d)}%`);
const fmtTer = (n) => (n == null ? 'n/a' : `${Number(n).toFixed(2)}%`);
const pts = (n, d = 1) => { const v = Math.abs(n).toFixed(d); return `${v} point${Number(v) === 1 ? '' : 's'}`; };

const STATE_TEXT = {
  'no-history': 'not enough history',
  'no-peers': 'no peers with data yet',
  'too-few': 'too few peers with data for a rank',
};
const GLYPH = { above: '▲', below: '▼', at: '◆' };
const POSITION_TEXT = { above: 'above', below: 'below', at: 'at' };

/** Min..max track with a median tick and the fund's marker. Position only, no judgement. */
function RangeBar({ m, unit = '%' }) {
  if (m.value == null || m.min == null || m.max == null || m.peerMedian == null) return null;
  const span = m.max - m.min;
  const at = (v) => (span > 0 ? Math.min(100, Math.max(0, ((v - m.min) / span) * 100)) : 50);
  return (
    <div style={{ position: 'relative', height: 18, marginTop: 5 }}
      role="img" aria-label={`Peer range ${m.min} to ${m.max}${unit}, median ${m.peerMedian}${unit}, this fund ${m.value}${unit}, ${POSITION_TEXT[m.position]} the median`}>
      <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, top: 8, height: 3, borderRadius: 2, background: 'var(--sur-10)' }} />
      <div aria-hidden="true" title={`Peer median ${m.peerMedian}${unit}`} style={{ position: 'absolute', left: `${at(m.peerMedian)}%`, top: 3, width: 2, height: 13, background: 'var(--color-text-muted)', transform: 'translateX(-1px)' }} />
      <span aria-hidden="true" style={{ position: 'absolute', left: `${at(m.value)}%`, top: 0, transform: 'translateX(-50%)', fontSize: 13, lineHeight: '18px', fontWeight: 900, color: 'var(--color-accent)' }}>{GLYPH[m.position]}</span>
    </div>
  );
}

function rankText(m) {
  if (m.rank == null) return null;
  return `${m.tied ? 'joint ' : ''}${ordinal(m.rank)} of ${m.of}`;
}

function MetricRow({ def, m, fmtVal }) {
  const dirText = def.direction === 'high' ? '1st = highest' : '1st = lowest';
  return (
    <li style={{ listStyle: 'none', padding: '9px 0', borderTop: '1px solid var(--sur-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
        <span style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', minWidth: 0 }}>{def.label}</span>
        <b className="tabular-nums" style={{ fontSize: 13, color: 'var(--color-text)', flexShrink: 0 }}>{fmtVal(m.value)}</b>
      </div>
      {m.value == null || m.state === 'no-history' ? (
        <p style={{ fontSize: 10.5, marginTop: 3, ...muted }}>{STATE_TEXT['no-history']}</p>
      ) : (
        <>
          <RangeBar m={m} />
          <p className="tabular-nums" style={{ fontSize: 10.5, marginTop: 2, ...muted }}>
            {m.peerMedian != null && <>Peer median {fmtVal(m.peerMedian)}{m.deltaVsMedian != null && m.position !== 'at' ? ` · ${pts(m.deltaVsMedian, def.id === 'ter' ? 2 : 1)} ${POSITION_TEXT[m.position]} it` : m.position === 'at' ? ' · at the median' : ''}</>}
          </p>
          <p style={{ fontSize: 11, marginTop: 2, color: 'var(--color-text-secondary)' }}>
            {m.rank != null
              ? <><b>{rankText(m)}</b> <span style={muted}>({dirText}; {m.withData} funds with data)</span></>
              : <span style={muted}>{STATE_TEXT[m.state] || ''}{m.withData ? ` (${m.withData} with data)` : ''}</span>}
          </p>
        </>
      )}
    </li>
  );
}

function Group({ title, children }) {
  return (
    <div style={{ marginTop: 12 }}>
      <p style={sub}>{title}</p>
      <ul style={{ padding: 0, margin: '4px 0 0' }}>{children}</ul>
    </div>
  );
}

function CostBlock({ fund, plan }) {
  const p = fund.plans[plan];
  const m = p.metrics.ter;
  const g = fund.costGap;
  const d = fund.plans.direct.held.values.ter, r = fund.plans.regular.held.values.ter;
  return (
    <Group title="Expense ratio (TER)">
      <li style={{ listStyle: 'none', padding: '4px 0 9px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[['direct', d], ['regular', r]].map(([k, v]) => (
            <div key={k} style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--sur-6)', border: k === plan ? '1px solid var(--color-accent)' : '1px solid transparent' }}>
              <p style={sub}>{PLAN_LABELS[k]}</p>
              <p className="tabular-nums" style={{ fontSize: 15, fontWeight: 900, color: 'var(--color-text)', marginTop: 2 }}>{fmtTer(v)}</p>
              <p className="tabular-nums" style={{ fontSize: 10.5, ...muted }}>peer median {fmtTer(fund.peerMedianTer[k])}</p>
            </div>
          ))}
        </div>
        {g ? (
          <p style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
            Regular is {g.gapPct.toFixed(2)} points a year above Direct: about <b>INR {g.inrPerLakhPerYear.toLocaleString('en-IN')}</b> a year for every INR 1 lakh invested.
          </p>
        ) : <p style={{ fontSize: 11, marginTop: 8, ...muted }}>The Direct-vs-Regular gap needs a TER for both plans (n/a for one of them).</p>}
      </li>
      <MetricRow def={METRICS.find(x => x.id === 'ter')} m={m} fmtVal={fmtTer} />
    </Group>
  );
}

function CommonWindow({ fund, plan }) {
  const p = fund.plans[plan];
  const rows = [p.held, ...p.peers, ...(p.benchmark ? [p.benchmark] : [])];
  const basis = fund.windowBasis;
  const since = fund.window.startDate ? `since ${fmtAsOf(fund.window.startDate)}` : fund.window.label;
  const basisText = basis === 'annualised' ? `annualised ${since} (per-year figures)` : basis === 'cumulative' ? `cumulative ${since} (whole-window returns, not per-year figures)` : since;
  const showRet = basis === 'cumulative' || basis === 'annualised'; // never put two bases side by side
  return (
    <div>
      <p style={{ fontSize: 11.5, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
        Weak comparability, under 2 years of history. No ranks and no category median are shown.
        {' '}Common window: {basisText}.
      </p>
      {basis === 'mixed' && <p role="note" style={{ fontSize: 11, marginTop: 6, color: 'var(--color-warning)' }}>The funds’ window returns use different bases right now, so they are not shown side by side.</p>}
      <ul style={{ display: 'grid', gap: 8, marginTop: 10, padding: 0 }}>
        {rows.map((e, i) => (
          <li key={`${e.code}-${i}`} style={{ listStyle: 'none', padding: '8px 10px', borderRadius: 10, background: i === 0 ? 'var(--sur-8)' : 'var(--sur-6)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
              <span style={{ fontSize: 11.5, fontWeight: i === 0 ? 800 : 600, color: 'var(--color-text)', minWidth: 0 }}>
                {e.name || e.code}
                {e.role === 'benchmark' && <span style={{ ...badge, marginLeft: 6, color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-text)' }}>INDEX TWIN</span>}
                {e.weakMatch && e.role !== 'benchmark' && <span style={{ ...badge, marginLeft: 6, ...muted, border: '1px solid var(--sur-10)' }}>WEAK MATCH</span>}
              </span>
              <b className="tabular-nums" style={{ fontSize: 13, flexShrink: 0, color: 'var(--color-text)' }}>{showRet ? fmt(e.window.retWindow) : 'n/a'}</b>
            </div>
            <p className="tabular-nums" style={{ fontSize: 10.5, marginTop: 2, ...muted }}>
              Volatility {fmt(e.window.volWindow)} · largest fall {fmt(e.window.mddWindow)} · TER {fmtTer(e.values.ter)}{e.lastNavDate ? ` · NAV to ${fmtAsOf(e.lastNavDate)}` : ''}
            </p>
            {(e.status !== 'ok' || (e.window.retWindow == null && e.reason)) && <p style={{ fontSize: 10.5, marginTop: 2, color: 'var(--color-warning)' }}>{e.status !== 'ok' ? `${e.status}. ` : ''}{e.reason}</p>}
            {e.note && <p style={{ fontSize: 10.5, marginTop: 2, ...muted }}>{e.note}</p>}
          </li>
        ))}
      </ul>
      <p style={{ fontSize: 10.5, marginTop: 8, ...muted }}>The index fund tracks the benchmark family of this fund; it is shown for reference, not as a peer.</p>
    </div>
  );
}

function FundBlock({ fund }) {
  const [plan, setPlan] = useState(fund.defaultPlan);
  const p = fund.plans[plan];
  const held = p.held;
  const staleH = held.stale;
  return (
    <div style={section}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 13, fontWeight: 900, color: 'var(--color-text)' }}>{fund.label}</p>
          <p style={{ fontSize: 10.5, marginTop: 2, ...muted }}>
            vs {p.peerCount} {fund.kind === 'common-window' ? 'comparable' : 'peer'} fund{p.peerCount === 1 ? '' : 's'} · {fund.categoryLabel}
          </p>
        </div>
        <div role="group" aria-label={`Plan type for ${fund.label}`} style={{ display: 'inline-flex', borderRadius: 9, background: 'var(--sur-8)', padding: 2 }}>
          {['direct', 'regular'].map(k => (
            <button key={k} type="button" aria-pressed={plan === k} onClick={() => setPlan(k)}
              style={{ fontSize: 11, fontWeight: 800, padding: '6px 12px', minHeight: 32, borderRadius: 7, background: plan === k ? 'var(--color-accent)' : 'transparent', color: plan === k ? '#fff' : 'var(--color-text-secondary)' }}>
              {PLAN_LABELS[k]}
            </button>
          ))}
        </div>
      </div>
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        <span style={{ ...badge, color: staleH ? 'var(--color-warning)' : 'var(--color-text-muted)', background: staleH ? 'oklch(75% 0.15 75 / 14%)' : 'var(--sur-8)' }}>
          THIS FUND · {fmtAsOf(held.asOf)}{held.lastNavDate ? ` · NAV ${fmtAsOf(held.lastNavDate)}` : ''}{staleH ? ' · MAY BE OUT OF DATE' : ''}
        </span>
        {p.peers.some(x => x.asOf) && (
          <span style={{ ...badge, color: p.peerStale ? 'var(--color-warning)' : 'var(--color-text-muted)', background: p.peerStale ? 'oklch(75% 0.15 75 / 14%)' : 'var(--sur-8)' }}>
            PEERS · {fmtAsOf(p.peers.map(x => x.asOf).filter(Boolean).sort().slice(-1)[0])} · NAV to {fmtAsOf(p.peers.map(x => x.lastNavDate).filter(Boolean).sort().slice(-1)[0])}{p.peerStale ? ' · MAY BE OUT OF DATE' : ''}
          </span>
        )}
      </p>
      {!fund.heldPlanConfirmed && <p style={{ fontSize: 10.5, marginTop: 6, ...muted }}>Plan held not confirmed; showing {PLAN_LABELS[fund.defaultPlan]} first.</p>}
      {held.status === 'failed' || held.status === 'insufficient-history' ? (
        <p role="note" style={{ fontSize: 11, marginTop: 8, color: 'var(--color-warning)' }}>This fund’s own data is {held.status === 'failed' ? 'unavailable' : 'too short'}{held.reason ? ` (${held.reason})` : ''}; figures below show n/a where they depend on it.</p>
      ) : held.status === 'stale' ? (
        <p role="note" style={{ fontSize: 11, marginTop: 8, color: 'var(--color-warning)' }}>The latest refresh for this fund did not complete{held.reason ? ` (${held.reason})` : ''}; showing the last good numbers.</p>
      ) : null}
      {p.peersNotLoaded && <p role="note" style={{ fontSize: 11, marginTop: 8, ...muted }}>Peer data for this fund has not loaded yet.</p>}

      <div style={{ marginTop: 10 }}>
        {fund.kind === 'common-window' ? <CommonWindow fund={fund} plan={plan} /> : p.metrics && (
          <>
            <Group title="Returns vs peers">
              {['ret1y', 'ret3y', 'ret5y'].map(id => <MetricRow key={id} def={METRICS.find(x => x.id === id)} m={p.metrics[id]} fmtVal={fmt} />)}
            </Group>
            <CostBlock fund={fund} plan={plan} />
            <Group title="Risk from NAV history (3 years)">
              {['vol', 'mdd'].map(id => <MetricRow key={id} def={METRICS.find(x => x.id === id)} m={p.metrics[id]} fmtVal={fmt} />)}
            </Group>
            <Group title="Consistency">
              <li style={{ listStyle: 'none', padding: '9px 0', borderTop: '1px solid var(--sur-6)' }}>
                {p.metrics.rolling.state === 'ok' ? (
                  <p style={{ fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
                    Beat the peer median in <b className="tabular-nums" style={{ color: 'var(--color-text)' }}>{Math.round(p.metrics.rolling.value)}%</b> of {held.rollingWindows} monthly rolling 1-year windows.
                  </p>
                ) : <p style={{ fontSize: 11.5, ...muted }}>Rolling 1-year windows: not enough history.</p>}
              </li>
            </Group>
          </>
        )}
      </div>

      {p.excluded.length > 0 && (
        <p style={{ fontSize: 10.5, marginTop: 8, color: 'var(--color-warning)' }}>
          Left out of the ranks (no usable data): {p.excluded.map(x => `${x.name}${x.reason ? ` (${x.reason})` : ''}`).join('; ')}.
        </p>
      )}
      {fund.notes.length > 0 && (
        <ul style={{ display: 'grid', gap: 4, marginTop: 8, padding: 0 }}>
          {fund.notes.filter(n => !(fund.kind === 'common-window' && n.kind === 'weak')).map(n => (
            <li key={n.id} style={{ fontSize: 10.5, lineHeight: 1.5, listStyle: 'none', ...muted }}>{n.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Explainer({ res }) {
  const t = res.thresholds;
  return (
    <details style={section}>
      <summary style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>How this is calculated</summary>
      <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 8, color: 'var(--color-text-muted)', display: 'grid', gap: 6 }}>
        <p>Each fund is compared with a fixed list of peers in the same SEBI category, Growth plans only. Direct is compared with Direct peers and Regular with Regular peers. Peers were chosen by category, age and size, not by returns.</p>
        <p>Returns of 3 and 5 years are per-year (CAGR) figures from NAV history; 1-year is the point-to-point change. Rank 1 is the highest return, or the lowest expense ratio, volatility and fall. Ties share a rank. The peer median leaves this fund out; ranks count this fund among the funds that have data for that figure, and a rank needs at least {t.minPeersForRank} funds with data.</p>
        <p>Volatility is the annualised standard deviation of daily NAV changes over 3 years. The largest fall is the biggest drop from a peak to a later low over 3 years. The expense ratio is the total TER from AMFI (base expense ratio plus brokerage, transaction cost and levies); some AMCs are missing from that feed and show n/a.</p>
        <p>Consistency counts monthly steps over the last 3 years: in how many of the 1-year windows this fund’s return was above the peer median for that window. It needs at least {t.minRollingWindows} windows.</p>
        <p>The ▲ ▼ ◆ marker shows where a number sits on the peer range relative to the median. It is a position on a number line and nothing more; it says nothing about which side is preferred for a given measure.</p>
        <p>The lists contain funds that exist today (merged or closed funds are not listed, so peer medians may lean high). Peer data refreshes monthly (older than {t.stalePeerDays} days is marked) and this fund’s data weekly (older than {t.staleHeldDays} days is marked). Returns come from NAVs and ignore any lock-in.</p>
        <p>Everything is rule-based on public data; nothing here is a recommendation.</p>
      </div>
    </details>
  );
}

export function MfPeersCard({ user, settings, accounts, activities, sipPlans, sheetId }) {
  const mfIds = useMemo(() => accounts.filter(a => a.type === 'mf_in').map(a => a.id), [accounts]);
  const codes = useMemo(() => (DEV_MOCK ? [] : cleanCodes(sipPlans.map(p => p.schemeCode))), [sipPlans]);
  const live = useMfNav(codes, user.accessToken);
  const navs = DEV_MOCK ? MOCK_MF_NAV.navs : live.navs;
  const { data, loading } = useMfPeers({ sheetId, accessToken: user.accessToken, enabled: mfIds.length > 0 && sipPlans.length > 0 });

  const res = useMemo(() => {
    const view = buildMfView({ plans: sipPlans, activities, accountIds: mfIds, navs, fx: null, currency: 'INR' });
    const funds = view.funds.filter(f => f.active !== false).map(f => {
      const code = String(f.schemeCode ?? '').trim();
      const nav = /^\d+$/.test(code) ? navs?.[code] : null;
      const fundKey = fundKeyFor({ schemeCode: code, name: nav?.name || f.name, planId: f.planId });
      return { planId: f.planId, name: fundKey ? fundLabel(fundKey) : f.name, fundKey, plan: nav?.plan === 'direct' || nav?.plan === 'regular' ? nav.plan : null };
    });
    return buildMfPeers({ funds, config: data?.config, peerRows: data?.peerRows, terRows: data?.terRows, run: data?.run, thresholds: settings?.mfPeerThresholds });
  }, [sipPlans, activities, mfIds, navs, data, settings?.mfPeerThresholds]);

  if (!mfIds.length || !sipPlans.length) return null;
  return <PeersView res={res} loading={loading} />;
}

/** Presentational half (pure props → markup) so every degraded state can be rendered in tests. */
export function PeersView({ res, loading = false }) {
  const peersAsOf = res.peersFinishedAt || res.asOf[res.asOf.length - 1] || null;

  return (
    <section aria-label="Mutual fund peer comparison" style={{ marginBottom: 14 }}>
      <div style={{ padding: '8px 2px 10px' }}>
        <p style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}><Users className="w-3.5 h-3.5" aria-hidden="true" /> Fund vs peers · India</p>
      </div>
      <div style={{ borderRadius: 22, overflow: 'hidden', background: 'var(--sur-4)', border: '1px solid var(--sur-10)' }}>
        <div style={{ padding: '14px 16px' }}>
          {res.status === 'unavailable' ? (
            <p role="note" style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
              {loading ? 'Looking for peer data…' : 'Peer data is not available yet. It is prepared by a scheduled job and will appear here once it has run.'}
            </p>
          ) : (
            <>
              <p style={{ fontSize: 14, fontWeight: 900, color: 'var(--color-text)', lineHeight: 1.35 }}>
                Where each fund sits among its peers on returns, cost, risk and consistency.
              </p>
              <p style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {peersAsOf && <span style={{ ...badge, ...muted, background: 'var(--sur-8)' }}>PEER DATA · {fmtAsOf(peersAsOf)}</span>}
                {res.peersProgress && <span style={{ ...badge, color: 'var(--color-warning)', background: 'oklch(75% 0.15 75 / 14%)' }}>PEER DATA STILL LOADING · {res.peersProgress.done}/{res.peersProgress.total}</span>}
              </p>
              <p style={{ fontSize: 10.5, marginTop: 8, display: 'flex', gap: 5, alignItems: 'flex-start', ...muted }}>
                <Info className="w-3 h-3 flex-shrink-0" style={{ marginTop: 2 }} aria-hidden="true" />
                <span>▲ ▼ ◆ show a position on the peer range (above, below or at the median), not a judgement.</span>
              </p>
            </>
          )}
        </div>

        {res.funds.map(f => <FundBlock key={f.fundKey} fund={f} />)}

        {res.notes.filter(n => n.kind !== 'unavailable').length > 0 && (
          <div style={section}>
            <p style={sub}>Data notes</p>
            <ul style={{ display: 'grid', gap: 5, marginTop: 7, padding: 0 }}>
              {res.notes.filter(n => n.kind !== 'unavailable').map(n => (
                <li key={n.id} style={{ fontSize: 11, lineHeight: 1.5, listStyle: 'none', ...muted }}>{n.message}</li>
              ))}
            </ul>
          </div>
        )}

        {res.status !== 'unavailable' && <Explainer res={res} />}
      </div>
      <p style={{ fontSize: 10.5, marginTop: 8, padding: '0 2px', ...muted }}>{res.disclaimer}</p>
    </section>
  );
}
