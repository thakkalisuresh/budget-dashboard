import { useEffect, useMemo, useState } from 'react';
import { Landmark, CalendarClock, ArrowRightLeft, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { Sheet, Field, ErrorNote, SaveButton, inputCls, inputStyle } from './InvestDialogs.jsx';
import { fetchSipPlans, appendActivities } from './sheetInvest.js';
import { investCache } from './useInvestData.js';
import { fetchMfHistory, fetchInrPerUsd } from './mfNavApi.js';
import {
  MF_ACCOUNT_ID, DEFAULT_BUFFER_PCT, FX_WARN_PCT, impliedFx, fxDeviationPct, pendingInrReceipts, pendingSips,
  planTransfer, cashLowCheck, sipUnits, sipKey, buildInrReceived, buildSipBuy,
} from './investMfNudge.js';
import { inrCashBalance } from './investMf.js';

// ════════════════════════════════════════════════════════════════════════════
// MfNudges — self-contained Indian-MF prompts for the Invest tab: monthly
// transfer planner (+ low-cash warning), "INR received" nudge for in-transit
// USD deposits, and pending-SIP confirm cards. Pure logic lives in
// investMfNudge.js; this file only fetches, renders and writes activities.
// ════════════════════════════════════════════════════════════════════════════

const todayIso = () => new Date().toISOString().slice(0, 10);
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const usd = (n, d = 0) => `$${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const AMBER = '#d97706';

function invalidate(sheetId) {
  investCache.delete(sheetId);
  try { localStorage.removeItem(`budget_invest_cache_${sheetId}`); } catch { /* ignore */ }
}

const cardStyle = { border: '1px solid var(--color-accent-border)', borderRadius: 26, padding: 18, marginBottom: 14 };
const eyebrow = { fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-accent-text)' };
const rowBtn = { background: 'var(--sur-5)', border: '1px solid var(--sur-10)' };

// Session-level live-rate cache: one /api/mf-nav fx call per page load.
let liveRatePromise = null;

export function MfNudges({ sheetId, accessToken, accounts, activities, settings, updateSettings, onSaved, isReadOnly }) {
  const mfAccount = accounts.find(a => a.type === 'mf_in');
  const accountId = mfAccount?.id || MF_ACCOUNT_ID;
  const [plans, setPlans] = useState([]);
  const [rate, setRate] = useState(null); // INR per 1 USD, null = unavailable
  const [showDismissed, setShowDismissed] = useState(false);
  const [inrTarget, setInrTarget] = useState(null);
  const [sipTarget, setSipTarget] = useState(null);

  // Plans are re-read (not cached for the session): after any activity refresh and
  // whenever the tab regains focus, so a scheme mapped elsewhere (picker) is picked up.
  useEffect(() => {
    if (!mfAccount || !sheetId || !accessToken) return undefined;
    let cancelled = false;
    const load = () => fetchSipPlans(sheetId, accessToken).then(p => { if (!cancelled) setPlans(p); }).catch(() => {});
    load();
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; document.removeEventListener('visibilitychange', onVisible); };
  }, [mfAccount?.id, sheetId, accessToken, activities]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!mfAccount || !accessToken) return undefined;
    let cancelled = false;
    liveRatePromise ||= fetchInrPerUsd({ accessToken });
    liveRatePromise.then(r => { if (!cancelled) setRate(r); });
    return () => { cancelled = true; };
  }, [mfAccount?.id, accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissed = settings.mfInrDismissed || [];
  const bufferPct = settings.mfBufferPct ?? DEFAULT_BUFFER_PCT;

  const allReceipts = useMemo(() => pendingInrReceipts(activities, accounts, []), [activities, accounts]);
  const receipts = allReceipts.filter(d => !dismissed.includes(d.uuid));
  const dismissedReceipts = allReceipts.filter(d => dismissed.includes(d.uuid));
  const skippedKeys = settings.mfSipSkipped;
  const sips = useMemo(
    () => pendingSips(plans.filter(p => p.accountId === accountId), activities, { today: todayIso(), skipped: skippedKeys || [] }),
    [plans, activities, skippedKeys, accountId]
  );
  const activePlans = useMemo(() => plans.filter(p => p.active && p.accountId === accountId), [plans, accountId]);
  const cash = useMemo(() => inrCashBalance(activities, accountId), [activities, accountId]);
  const transfer = useMemo(
    () => planTransfer({ plans: activePlans, liveInrPerUsd: rate, bufferPct, cashInr: cash }),
    [activePlans, rate, bufferPct, cash]
  );
  const low = useMemo(() => cashLowCheck(activities, activePlans, accountId), [activities, activePlans, accountId]);

  if (!mfAccount) return null;

  const set = (key, fn) => updateSettings(prev => ({ ...prev, [key]: fn(prev[key] || []) }));
  const dismissInr = (uuid) => set('mfInrDismissed', l => [...l, uuid]);
  const restoreInr = (uuid) => set('mfInrDismissed', l => l.filter(u => u !== uuid));
  const skipSip = (s) => set('mfSipSkipped', l => [...l, sipKey(s.planId, s.month)]);
  const saved = (n) => { invalidate(sheetId); onSaved?.(n); };
  const writable = !isReadOnly;

  return (
    <>
      {activePlans.length > 0 && (
        <div className="glass-heavy" style={cardStyle}>
          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            <ArrowRightLeft className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
            <p style={eyebrow}>This month's transfer</p>
          </div>
          <p className="text-sm font-black tabular-nums" style={{ color: 'var(--color-text)' }}>
            {inr(transfer.targetInr)} <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
              across {activePlans.length} SIP{activePlans.length !== 1 ? 's' : ''}</span>
          </p>
          {transfer.usdLow != null ? (
            <p className="text-sm mt-1 tabular-nums" style={{ color: 'var(--color-text)' }}>
              Send <b>{usd(transfer.usdLow)}–{usd(transfer.usdHigh)}</b>
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}> at ₹{rate.toFixed(2)}/$ + {bufferPct}% buffer</span>
            </p>
          ) : (
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Live rate unavailable — USD estimate hidden.</p>
          )}
          {transfer.cashInr > 0 && transfer.usdSaved != null && (
            <p className="text-xs mt-1 tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
              {inr(transfer.cashInr)} already in account, send ≈ {usd(transfer.usdSaved)} less
            </p>
          )}
          {low.low && (
            <p className="flex items-start gap-1.5 text-xs font-medium mt-2 px-3 py-2 rounded-xl"
              style={{ color: AMBER, background: 'oklch(70% 0.15 70 / 12%)' }}>
              <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
              Only {inr(low.cashInr)} in the NRO account — next SIPs need {inr(low.needInr)} (short {inr(low.shortfallInr)}).
            </p>
          )}
          {writable && (
            <label className="flex items-center gap-2 mt-3 text-[11px]" style={{ color: 'var(--color-text-muted)' }}>
              Buffer
              <input type="number" min="0" max="20" step="0.5" value={bufferPct} aria-label="Transfer buffer percent"
                onChange={e => {
                  const v = Math.max(0, Math.min(20, parseFloat(e.target.value) || 0));
                  updateSettings(prev => ({ ...prev, mfBufferPct: v }));
                }}
                className="w-16 rounded-xl px-2 py-1 text-xs outline-none" style={inputStyle} />
              %
            </label>
          )}
        </div>
      )}

      {writable && (receipts.length > 0 || dismissedReceipts.length > 0) && (
        <div className="glass-heavy" style={cardStyle}>
          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            <Landmark className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
            <p style={eyebrow}>{receipts.length} transfer{receipts.length !== 1 ? 's' : ''} awaiting INR</p>
          </div>
          <div className="space-y-2">
            {receipts.map(d => (
              <div key={d.uuid} className="flex items-center gap-2">
                <button onClick={() => setInrTarget(d)} className="flex-1 text-left rounded-2xl px-4 py-3 transition-all active:scale-[0.99]" style={rowBtn}>
                  <span className="text-sm font-black tabular-nums" style={{ color: 'var(--color-text)' }}>{usd(d.amount, 2)}</span>
                  <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}> sent{d.date ? ` · ${d.date}` : ''}</span>
                  <span className="block text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Tap to record the INR received</span>
                </button>
                <button onClick={() => dismissInr(d.uuid)} className="p-2.5 rounded-xl hover:bg-[var(--sur-5)]"
                  style={{ color: 'var(--color-text-muted)' }} aria-label="Dismiss"><X className="w-4 h-4" /></button>
              </div>
            ))}
          </div>
          {dismissedReceipts.length > 0 && (
            <button onClick={() => setShowDismissed(s => !s)} className="text-[11px] font-bold mt-3" style={{ color: 'var(--color-accent-text)' }}>
              {showDismissed ? 'Hide' : 'Show'} {dismissedReceipts.length} dismissed
            </button>
          )}
          {showDismissed && dismissedReceipts.map(d => (
            <div key={d.uuid} className="flex items-center justify-between mt-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              <span className="tabular-nums">{usd(d.amount, 2)}{d.date ? ` · ${d.date}` : ''}</span>
              <button onClick={() => restoreInr(d.uuid)} className="font-bold" style={{ color: 'var(--color-accent-text)' }}>Restore</button>
            </div>
          ))}
        </div>
      )}

      {writable && sips.length > 0 && (
        <div className="glass-heavy" style={cardStyle}>
          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            <CalendarClock className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
            <p style={eyebrow}>{sips.length} SIP{sips.length !== 1 ? 's' : ''} to confirm</p>
          </div>
          <div className="space-y-2">
            {sips.map(s => (
              <div key={sipKey(s.planId, s.month)} className="flex items-center gap-2">
                <button onClick={() => setSipTarget(s)} className="flex-1 text-left rounded-2xl px-4 py-3 transition-all active:scale-[0.99]" style={rowBtn}>
                  <span className="text-sm font-black" style={{ color: 'var(--color-text)' }}>{s.name}</span>
                  <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-secondary)' }}> · {inr(s.amountInr)} · {monthLabel(s.month)}</span>
                  <span className="block text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Confirm once debited</span>
                </button>
                <button onClick={() => skipSip(s)} className="px-2.5 py-2 rounded-xl text-[11px] font-bold hover:bg-[var(--sur-5)]"
                  style={{ color: 'var(--color-text-muted)' }} aria-label={`Skip ${s.name} ${monthLabel(s.month)}`}>Skip</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {inrTarget && (
        <InrReceivedDialog deposit={inrTarget} rate={rate} sheetId={sheetId} accessToken={accessToken}
          onClose={() => setInrTarget(null)} onSaved={saved} />
      )}
      {sipTarget && (
        <SipConfirmDialog sip={sipTarget} activities={activities} sheetId={sheetId} accessToken={accessToken}
          onClose={() => setSipTarget(null)} onSaved={saved} />
      )}
    </>
  );
}

// ── INR received ─────────────────────────────────────────────────────────────

export function InrReceivedDialog({ deposit, rate, sheetId, accessToken, onClose, onSaved }) {
  const [inrStr, setInrStr] = useState('');
  const [date, setDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const received = parseFloat(inrStr);
  const fx = impliedFx(deposit.amount, received);
  const dev = fx ? fxDeviationPct(fx.inrPerUsd, rate) : null;
  const warn = dev != null && dev > FX_WARN_PCT;

  const save = async () => {
    setError('');
    if (!(received > 0)) { setError('Enter the INR amount credited.'); return; }
    if (!date) { setError('Pick the date it arrived.'); return; }
    setSaving(true);
    try {
      await appendActivities(sheetId, accessToken, [buildInrReceived({ deposit, inrReceived: received, date })]);
      onSaved?.(1);
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="INR received" subtitle={`${usd(deposit.amount, 2)} sent to ${deposit.accountName}${deposit.date ? ` · ${deposit.date}` : ''}`} onClose={onClose}>
      <Field label="INR credited">
        <input type="number" inputMode="decimal" step="any" min="0" value={inrStr} autoFocus
          onChange={e => setInrStr(e.target.value)} className={inputCls} style={inputStyle}
          placeholder={rate ? String(Math.round(deposit.amount * rate)) : '20000'} />
      </Field>
      <Field label="Date received">
        <input type="date" value={date} min={deposit.date || undefined} onChange={e => setDate(e.target.value)} className={inputCls} style={inputStyle} />
      </Field>
      <div className="rounded-2xl px-4 py-3 text-xs tabular-nums space-y-1" style={{ background: 'var(--sur-5)', border: `1px solid ${warn ? AMBER : 'var(--sur-10)'}` }}>
        {fx ? (
          <>
            <p style={{ color: 'var(--color-text)' }}>₹{fx.inrPerUsd.toFixed(2)} per $1 · ${fx.usdPerInr.toFixed(5)} per ₹1</p>
            {rate && <p style={{ color: 'var(--color-text-muted)' }}>Live rate ₹{rate.toFixed(2)}/$</p>}
          </>
        ) : <p style={{ color: 'var(--color-text-muted)' }}>Enter the INR to see the implied FX rate.</p>}
        {warn && (
          <p className="flex items-start gap-1.5 font-medium" style={{ color: AMBER }}>
            <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
            {dev.toFixed(1)}% off the live rate — double-check the amount (you can still save).
          </p>
        )}
      </div>
      <ErrorNote error={error} />
      <SaveButton saving={saving} onClick={save}>Save INR received</SaveButton>
    </Sheet>
  );
}

// ── SIP confirm ──────────────────────────────────────────────────────────────

export function SipConfirmDialog({ sip, activities, sheetId, accessToken, onClose, onSaved }) {
  // A late confirmation defaults to the due date so the BUY lands in the month it satisfies.
  const [date, setDate] = useState(() => (todayIso().startsWith(sip.month) ? todayIso() : sip.dueDate));
  const [amountStr, setAmountStr] = useState(String(sip.amountInr));
  const [navOverride, setNavOverride] = useState(null);
  const [unitsOverride, setUnitsOverride] = useState(null);
  const [result, setResult] = useState(null); // { key, nav, resolvedDate, fellBack, error }
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const reqKey = `${date}#${attempt}`;
  useEffect(() => {
    if (!sip.mapped || !date) return undefined;
    let cancelled = false;
    fetchMfHistory({ code: sip.schemeCode, date, accessToken })
      .then(r => { if (!cancelled) setResult({ key: reqKey, nav: Number(r.nav), resolvedDate: r.resolvedDate, fellBack: !!r.fellBack, error: '' }); })
      .catch(e => { if (!cancelled) setResult({ key: reqKey, nav: null, resolvedDate: '', fellBack: false, error: e.message || 'NAV lookup failed' }); });
    return () => { cancelled = true; };
  }, [sip.mapped, sip.schemeCode, date, accessToken, reqKey]);

  // A result only counts for the request it answered; anything else is "loading".
  const fetched = !sip.mapped ? { status: 'manual', nav: null }
    : result?.key !== reqKey ? { status: 'loading', nav: null }
    : result.error ? { status: 'error', nav: null, error: result.error }
    : { status: 'ok', nav: result.nav, resolvedDate: result.resolvedDate, fellBack: result.fellBack };

  const amount = parseFloat(amountStr);
  const nav = navOverride != null ? parseFloat(navOverride) : fetched.nav;
  const units = unitsOverride != null ? parseFloat(unitsOverride) : sipUnits(amount, nav);

  const save = async () => {
    setError('');
    if (!date) { setError('Pick the debit date.'); return; }
    if (!(amount > 0)) { setError('Enter the INR debited.'); return; }
    if (!(nav > 0)) { setError('Enter the NAV.'); return; }
    if (!(units > 0)) { setError('Enter the units allotted.'); return; }
    setSaving(true);
    try {
      await appendActivities(sheetId, accessToken, [buildSipBuy({ plan: { id: sip.planId, accountId: sip.accountId, amountInr: sip.amountInr }, date, nav, units, amount, activities })]);
      onSaved?.(1);
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={`Confirm ${sip.name}`} subtitle={`${monthLabel(sip.month)} SIP · ${inr(sip.amountInr)}`} onClose={onClose}>
      <Field label="Debit date">
        <input type="date" value={date} onChange={e => { setDate(e.target.value); setNavOverride(null); setUnitsOverride(null); }} className={inputCls} style={inputStyle} />
      </Field>
      <Field label="INR debited">
        <input type="number" inputMode="decimal" step="any" min="0" value={amountStr} onChange={e => setAmountStr(e.target.value)} className={inputCls} style={inputStyle} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="NAV">
          <input type="number" inputMode="decimal" step="any" min="0" aria-label="NAV"
            value={navOverride ?? (fetched.nav != null ? String(fetched.nav) : '')}
            onChange={e => { setNavOverride(e.target.value); setUnitsOverride(null); }}
            className={inputCls} style={inputStyle} placeholder={fetched.status === 'loading' ? '…' : 'NAV'} />
        </Field>
        <Field label="Units">
          <input type="number" inputMode="decimal" step="any" min="0" aria-label="Units"
            value={unitsOverride ?? (units != null ? String(units) : '')}
            onChange={e => setUnitsOverride(e.target.value)}
            className={inputCls} style={inputStyle} placeholder="Units" />
        </Field>
      </div>
      <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
        {fetched.status === 'manual' && 'Scheme not mapped yet — enter the NAV and units from your statement.'}
        {fetched.status === 'loading' && (<span className="flex items-center gap-1.5"><RefreshCw className="w-3 h-3 animate-spin" /> Fetching NAV…</span>)}
        {fetched.status === 'ok' && (fetched.fellBack
          ? `No NAV on ${date}; using ${fetched.resolvedDate}. Override if your statement differs.`
          : `NAV for ${fetched.resolvedDate}. Override if your statement differs.`)}
        {fetched.status === 'error' && (
          <span className="flex items-center gap-2">
            <span style={{ color: 'var(--color-danger)' }}>{fetched.error}</span>
            <button onClick={() => setAttempt(a => a + 1)} className="font-bold" style={{ color: 'var(--color-accent-text)' }}>Retry</button>
            <span>or enter it manually.</span>
          </span>
        )}
      </div>
      <ErrorNote error={error} />
      <SaveButton saving={saving} onClick={save}>Confirm debit</SaveButton>
    </Sheet>
  );
}
