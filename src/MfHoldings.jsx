import { useMemo, useState } from 'react';
import { Landmark, AlertTriangle } from 'lucide-react';
import { useMfNav } from './useMfNav.js';
import { buildMfView, mappedCodes, fmtMfMoney, fmtMfPct } from './investMfView.js';
import { MfSchemePicker } from './MfSchemePicker.jsx';
import { MOCK_MF_NAV } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

const label = { fontSize: 10, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-muted)' };
const badge = { fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', padding: '2px 5px', borderRadius: 5, whiteSpace: 'nowrap' };

/** ▲/▼ + sign + colour, so direction never rides on colour alone. */
function Delta({ value, pct, cur }) {
  if (value == null) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>;
  const up = value >= 0;
  return (
    <span className="tabular-nums" style={{ color: up ? 'var(--color-success)' : 'var(--color-danger)', fontWeight: 800 }}>
      {up ? '▲' : '▼'} {fmtMfMoney(Math.abs(value), cur)} <span style={{ fontWeight: 700 }}>({fmtMfPct(pct)})</span>
    </span>
  );
}

function Stat({ k, v }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4, whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--color-text-muted)' }}>{k}</span>
      <b className="tabular-nums" style={{ color: 'var(--color-text-secondary)', fontWeight: 700 }}>{v}</b>
    </span>
  );
}

function CurrencyToggle({ value, onChange }) {
  return (
    <div role="group" aria-label="Display currency" style={{ display: 'inline-flex', borderRadius: 10, padding: 2, background: 'var(--sur-6)', border: '1px solid var(--sur-10)' }}>
      {['INR', 'USD'].map(c => (
        <button key={c} onClick={() => onChange(c)} aria-pressed={value === c}
          style={{
            fontSize: 10.5, fontWeight: 800, padding: '3px 9px', borderRadius: 8,
            background: value === c ? 'var(--color-accent)' : 'transparent',
            color: value === c ? '#fff' : 'var(--color-text-muted)',
          }}>
          {c === 'INR' ? '₹ INR' : '$ USD'}
        </button>
      ))}
    </div>
  );
}

function FundRow({ f, cur, first, canPick, onPick }) {
  const digits = cur === 'USD' ? 2 : 2;
  const dim = f.units === 0;
  return (
    <div style={{ padding: '13px 16px', borderTop: first ? 'none' : '1px solid var(--sur-8)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontSize: 14, fontWeight: 900, color: 'var(--color-text)', lineHeight: 1.25 }}>{f.name}</p>
          <p style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginTop: 5 }}>
            {f.needsMapping && (
              <span style={{ ...badge, color: 'var(--color-warning)', background: 'oklch(75% 0.15 75 / 14%)' }}>NEEDS MAPPING</span>
            )}
            {f.costBasis && (
              <span style={{ ...badge, color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>COST BASIS</span>
            )}
            {canPick && (
              <button onClick={() => onPick(f)} style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--color-accent-text)' }}>
                {f.needsMapping ? 'Pick scheme' : 'Change scheme'}
              </button>
            )}
          </p>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <p className="tabular-nums" style={{ fontSize: 15, fontWeight: 900, color: dim ? 'var(--color-text-muted)' : 'var(--color-text)' }}>
            {dim ? '—' : fmtMfMoney(f.value, cur)}
          </p>
          {!dim && <p style={{ fontSize: 11, marginTop: 2 }}><Delta value={f.gain} pct={f.gainPct} cur={cur} /></p>}
        </div>
      </div>
      <p style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', marginTop: 8, fontSize: 11 }}>
        {dim ? (
          <Stat k="SIP" v={`${fmtMfMoney(f.amountInr, 'INR')}/mo`} />
        ) : (
          <>
            <Stat k="Units" v={f.units.toFixed(3)} />
            <Stat k="Avg" v={fmtMfMoney(f.avgCost, cur, digits)} />
            <Stat k="Invested" v={fmtMfMoney(f.invested, cur)} />
            <Stat k="XIRR" v={fmtMfPct(f.xirr)} />
            {f.nav != null && <Stat k="NAV" v={`₹${f.nav.toFixed(2)}${f.navDate ? ` · ${f.navDate}` : ''}`} />}
          </>
        )}
      </p>
    </div>
  );
}

export function MfHoldings({ user, settings, updateSettings, accounts, activities, sipPlans, sheetId, refresh, isReadOnly = false }) {
  const mfIds = useMemo(() => accounts.filter(a => a.type === 'mf_in').map(a => a.id), [accounts]);

  // Optimistic scheme edits, shown until the refetch after updateSipPlan lands.
  // Tied to the sipPlans array they were made against, so fresh data supersedes them.
  const [edit, setEdit] = useState({ base: null, patches: {} });
  const plans = useMemo(() => {
    const patches = edit.base === sipPlans ? edit.patches : {};
    return sipPlans.map(p => (patches[p.id] ? { ...p, ...patches[p.id], mapped: true } : p));
  }, [sipPlans, edit]);

  // No mapped plan ⇒ no codes ⇒ the hook makes no calls. Mock mode never hits the network.
  const codes = useMemo(() => (DEV_MOCK ? [] : mappedCodes(plans)), [plans]);
  const live = useMfNav(codes, user.accessToken);
  const navs = DEV_MOCK ? MOCK_MF_NAV.navs : live.navs;
  const fx = DEV_MOCK ? MOCK_MF_NAV.fx : live.fx;
  const stale = DEV_MOCK ? false : live.stale;

  const [localCur, setLocalCur] = useState(null);
  const currency = (isReadOnly ? localCur : null) || (settings.mfDisplayCurrency === 'USD' ? 'USD' : 'INR');
  const setCurrency = (c) => {
    if (isReadOnly) setLocalCur(c);
    else updateSettings(prev => ({ ...prev, mfDisplayCurrency: c }));
  };

  const view = useMemo(
    () => buildMfView({ plans, activities, accountIds: mfIds, navs, fx, currency }),
    [plans, activities, mfIds, navs, fx, currency]
  );
  const [picking, setPicking] = useState(null);

  if (!mfIds.length || !plans.length) return null;

  const cur = currency;
  const canPick = !isReadOnly;
  const t = view.total;
  const lastUpdated = live.lastUpdated;

  return (
    <section aria-label="Indian mutual funds" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 2px 10px', gap: 8 }}>
        <p style={{ ...label, display: 'flex', alignItems: 'center', gap: 6 }}><Landmark className="w-3.5 h-3.5" /> Mutual funds · India</p>
        <CurrencyToggle value={cur} onChange={setCurrency} />
      </div>

      <div style={{ borderRadius: 22, overflow: 'hidden', background: 'var(--sur-4)', border: '1px solid var(--sur-10)' }}>
        {view.unmappedCount > 0 && (
          <div role="note" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '11px 16px', background: 'oklch(75% 0.15 75 / 10%)', borderBottom: '1px solid var(--sur-8)', fontSize: 11.5, color: 'var(--color-text-secondary)' }}>
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-warning)', marginTop: 1 }} />
            <span>
              {view.unmappedCount} fund{view.unmappedCount > 1 ? 's need' : ' needs'} a scheme before NAVs and returns can show.
              {canPick ? ' Tap “Pick scheme” on the fund once you know the exact plan.' : ''}
            </span>
          </div>
        )}

        {view.hasActivity && (
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--sur-8)' }}>
            <p style={{ ...label, fontSize: 9 }}>Total value{t.partial ? ' (some at cost)' : ''}</p>
            <p className="tabular-nums" style={{ fontSize: 24, fontWeight: 900, color: 'var(--color-text)', marginTop: 3, letterSpacing: '-0.02em' }}>
              {view.rateMissing ? '—' : fmtMfMoney(t.value, cur)}
            </p>
            <p style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 14px', marginTop: 6, fontSize: 11.5 }}>
              <Delta value={t.gain} pct={t.gainPct} cur={cur} />
              <Stat k="Invested" v={fmtMfMoney(t.invested, cur)} />
              <Stat k="XIRR" v={fmtMfPct(t.xirr)} />
            </p>
            {cur === 'USD' && t.fxGain != null && (
              <p style={{ fontSize: 11, marginTop: 6, color: 'var(--color-text-secondary)' }}>
                Of the gain: {fmtMfMoney(t.marketGain, 'USD')} from fund returns, {fmtMfMoney(t.fxGain, 'USD')} from the INR/USD move.
              </p>
            )}
          </div>
        )}

        {view.hasActivity ? view.amcs.map((g, gi) => (
          <div key={g.amc} style={{ borderTop: gi > 0 ? '1px solid var(--sur-10)' : 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '9px 16px', background: 'var(--sur-6)', fontSize: 10.5, fontWeight: 800, color: 'var(--color-text-muted)' }}>
              <span>{g.amc}</span>
              <span className="tabular-nums">{g.value != null ? fmtMfMoney(g.value, cur) : '—'}{g.gain != null ? ` · ${fmtMfPct(g.gainPct)}` : ''}</span>
            </div>
            {g.funds.map((f, i) => (
              <FundRow key={f.planId} f={f} cur={cur} first={i === 0} canPick={canPick} onPick={() => setPicking(f.planId)} />
            ))}
          </div>
        )) : (
          <div>
            <div style={{ padding: '16px 16px 6px' }}>
              <p style={{ fontSize: 13, fontWeight: 900, color: 'var(--color-text)' }}>Your SIPs start next month</p>
              <p style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 5, color: 'var(--color-text-muted)' }}>
                Nothing is logged yet. Once your first transfer lands and a SIP debits, each fund shows its units,
                value, gain and XIRR here. Map each fund to its exact scheme (Direct or Regular, Growth or IDCW)
                before then so NAVs can load.
              </p>
            </div>
            {view.funds.map((f, i) => (
              <FundRow key={f.planId} f={f} cur={cur} first={i === 0} canPick={canPick} onPick={() => setPicking(f.planId)} />
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '11px 16px', borderTop: '1px solid var(--sur-10)', fontSize: 11.5 }}>
          <span style={{ color: 'var(--color-text-muted)' }}>INR cash in NRO account</span>
          <b className="tabular-nums" style={{ color: 'var(--color-text)' }}>
            {fmtMfMoney(view.cash.display, cur)}
          </b>
        </div>
      </div>

      <p style={{ fontSize: 10.5, marginTop: 8, padding: '0 2px', color: stale ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
        {view.basis}.
        {stale ? ' NAV refresh is behind; showing the last values.' : lastUpdated || DEV_MOCK ? ' NAVs are end-of-day from AMFI.' : ''}
      </p>

      {picking && (() => {
        const plan = plans.find(p => p.id === picking);
        return plan ? (
          <MfSchemePicker plan={plan} sheetId={sheetId} accessToken={user.accessToken}
            onClose={() => setPicking(null)}
            onSaved={(id, patch) => {
              setEdit(e => ({ base: sipPlans, patches: { ...(e.base === sipPlans ? e.patches : {}), [id]: patch } }));
              refresh?.();
            }} />
        ) : null;
      })()}
    </section>
  );
}
