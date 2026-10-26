import { useState, useEffect } from 'react';
import { Search, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { Sheet, Field, ErrorNote, SaveButton, inputCls, inputStyle } from './InvestDialogs.jsx';
import { updateSipPlan } from './sheetInvest.js';
import { searchSeed, mapPatchFor, subPlanHint } from './investMfView.js';
import { MOCK_MF_SEARCH } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';
const DEBOUNCE_MS = 350;
const RETRY_MS = 3000;
const MAX_RETRIES = 6; // the first call can 503 for ~10 s while the AMFI file loads

async function searchSchemes(q, accessToken) {
  if (DEV_MOCK) {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return { results: MOCK_MF_SEARCH.filter(r => words.every(w => r.name.toLowerCase().includes(w))) };
  }
  const res = await fetch('/api/mf-nav', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ action: 'search', q }),
  });
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    if (body?.retryable) return { retry: true };
  }
  if (!res.ok) throw new Error('Search failed. Try again in a moment.');
  return res.json();
}

const planLabel = (p) => (p === 'direct' ? 'Direct' : p === 'regular' ? 'Regular' : 'Plan n/a');
const optionLabel = (o) => (o === 'growth' ? 'Growth' : o === 'idcw' ? 'IDCW' : 'Other option');

/**
 * Map a SipPlan to an AMFI scheme. Writes schemeCode (and optionally the name)
 * via updateSipPlan. Holdings key on the plan id, so re-mapping never touches
 * the activity history — only which NAV the units are valued with.
 */
export function MfSchemePicker({ plan, sheetId, accessToken, onClose, onSaved }) {
  const remap = !!plan.mapped;
  const [q, setQ] = useState(() => searchSeed(plan));
  const [results, setResults] = useState(null);   // null = nothing searched yet
  const [status, setStatus] = useState('idle');   // idle | loading | retrying | error
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState(null);
  const [rename, setRename] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) return undefined;
    let cancelled = false;
    let timer;
    const run = async (attempt) => {
      setStatus(attempt ? 'retrying' : 'loading');
      try {
        const out = await searchSchemes(term, accessToken);
        if (cancelled) return;
        if (out.retry) {
          if (attempt >= MAX_RETRIES) { setStatus('error'); setError('The fund list is still loading. Try again in a moment.'); return; }
          timer = setTimeout(() => run(attempt + 1), RETRY_MS);
          return;
        }
        setResults(out.results || []);
        setError('');
        setStatus('idle');
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setError(e.message || 'Search failed.');
      }
    };
    timer = setTimeout(() => run(0), DEBOUNCE_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, accessToken]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const patch = mapPatchFor(chosen, rename);
      if (!DEV_MOCK) await updateSipPlan(sheetId, accessToken, plan.id, patch);
      onSaved?.(plan.id, patch);
      onClose();
    } catch (e) {
      setError(e.message || 'Could not save the mapping.');
      setSaving(false);
    }
  };

  // Anything below 3 characters shows nothing, whatever an earlier search left behind.
  const searching = q.trim().length >= 3;
  const shown = searching ? results : null;
  const state = searching ? status : 'idle';
  const hint = shown ? subPlanHint(shown) : '';

  return (
    <Sheet title={remap ? 'Change scheme' : 'Pick scheme'} subtitle={plan.name} onClose={onClose}>
      {!chosen ? (
        <>
          <Field label="Search AMFI schemes">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--color-text-muted)' }} />
              <input value={q} onChange={e => setQ(e.target.value)} autoFocus
                className={inputCls} style={{ ...inputStyle, paddingLeft: 40 }}
                placeholder="e.g. ITI Small Cap" aria-label="Search AMFI schemes" />
            </div>
          </Field>

          {(state === 'loading' || state === 'retrying') && (
            <p role="status" className="text-xs font-semibold flex items-center gap-2" style={{ color: 'var(--color-text-muted)' }}>
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              {state === 'retrying' ? 'Loading the fund list, retrying…' : 'Searching…'}
            </p>
          )}
          <ErrorNote error={state === 'error' ? error : ''} />

          {hint && (
            <p className="text-xs font-medium px-4 py-2.5 rounded-xl flex gap-2" style={{ background: 'var(--sur-6)', color: 'var(--color-text-secondary)' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />{hint}
            </p>
          )}

          {shown && !shown.length && state === 'idle' && (
            <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No schemes matched. Try fewer words.</p>
          )}
          {shown?.length > 0 && (
            <ul className="space-y-2" aria-label="Matching schemes">
              {shown.map(r => (
                <li key={r.code}>
                  <button onClick={() => setChosen(r)} className="w-full text-left rounded-2xl px-4 py-3 transition-colors hover:bg-[var(--sur-8)]"
                    style={{ background: 'var(--sur-5)', border: `1px solid ${r.code === plan.schemeCode ? 'var(--color-accent-border)' : 'var(--sur-10)'}` }}>
                    <p className="text-[13px] font-bold leading-snug" style={{ color: 'var(--color-text)' }}>{r.name}</p>
                    <p className="text-[11px] mt-1 flex flex-wrap gap-x-2 gap-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
                      <span>{r.amc}</span>
                      <span>· {planLabel(r.plan)}</span>
                      <span>· {optionLabel(r.option)}</span>
                      <span className="tabular-nums">· NAV {r.nav != null ? `₹${Number(r.nav).toFixed(2)}` : 'n/a'}{r.date ? ` (${r.date})` : ''}</span>
                      {r.code === plan.schemeCode && <span style={{ color: 'var(--color-accent-text)' }}>· current</span>}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div className="rounded-2xl px-4 py-3" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-10)' }}>
            <p className="text-[13px] font-bold leading-snug" style={{ color: 'var(--color-text)' }}>{chosen.name}</p>
            <p className="text-[11px] mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {chosen.amc} · {planLabel(chosen.plan)} · {optionLabel(chosen.option)} · code {chosen.code}
            </p>
          </div>
          {remap && (
            <p className="text-xs font-medium px-4 py-2.5 rounded-xl flex gap-2" role="alert"
              style={{ background: 'oklch(75% 0.15 75 / 12%)', color: 'var(--color-text)' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
              Units and cost stay as logged; only the NAV used to value them changes. A wrong scheme will mis-value this fund.
            </p>
          )}
          <label className="flex items-start gap-2.5 text-xs font-semibold cursor-pointer" style={{ color: 'var(--color-text)' }}>
            <input type="checkbox" checked={rename} onChange={e => setRename(e.target.checked)} className="mt-0.5" />
            <span>Also rename to “{chosen.name}”</span>
          </label>
          <ErrorNote error={error} />
          <SaveButton saving={saving} onClick={save} icon={Check}>{remap ? 'Confirm change' : 'Map this scheme'}</SaveButton>
          <button onClick={() => setChosen(null)} disabled={saving} className="w-full text-xs font-bold py-2" style={{ color: 'var(--color-text-muted)' }}>
            Back to results
          </button>
        </>
      )}
    </Sheet>
  );
}
