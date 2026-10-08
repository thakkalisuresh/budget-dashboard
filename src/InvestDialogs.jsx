import React, { useState, useRef } from 'react';
import { X, Upload, Plus, Check } from 'lucide-react';
import { updateAccount, appendActivity, appendActivities, ACTIVITY_TYPES } from './sheetInvest.js';
import { parseFidelityCsv } from './fidelityCsvParser.js';

export const inputCls = 'w-full rounded-2xl px-4 py-3 text-sm outline-none transition-all';
export const inputStyle = { background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' };
const todayIso = () => new Date().toISOString().slice(0, 10);

export function Sheet({ title, subtitle, onClose, children }) {
  return (
    <>
      <div className="fixed inset-0 z-40 animate-overlay-in" style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }} onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="glass-heavy animate-sheet-up rounded-t-3xl sm:rounded-3xl w-full sm:max-w-md overflow-hidden max-h-[90vh] flex flex-col"
          style={{ border: '1px solid var(--sur-10)', borderBottom: 'none' }}>
          <div className="w-10 h-1 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" style={{ background: 'var(--sur-20)' }} />
          <div className="px-8 pt-6 pb-5 flex items-center justify-between flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
            <div>
              <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>{title}</p>
              {subtitle && <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{subtitle}</p>}
            </div>
            <button onClick={onClose} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="px-8 py-6 space-y-4 overflow-y-auto flex-1" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
            {children}
          </div>
        </div>
      </div>
    </>
  );
}

export function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>{label}</label>
      {children}
    </div>
  );
}

export function ErrorNote({ error }) {
  if (!error) return null;
  return (
    <p className="text-xs font-medium px-4 py-2.5 rounded-xl" style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>
      {error}
    </p>
  );
}

export function SaveButton({ saving, onClick, children, icon: Icon = Check }) {
  return (
    <button onClick={onClick} disabled={saving}
      className="w-full py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2"
      style={{ background: 'var(--color-accent)' }}>
      <Icon className="w-4 h-4" />
      {saving ? 'Saving…' : children}
    </button>
  );
}

// ── Edit balance / APY for one account ──────────────────────────────────────

export function EditAccountDialog({ account, sheetId, accessToken, onClose, onSaved }) {
  const [balance, setBalance] = useState(account.balance ? String(account.balance) : '');
  const [apy, setApy] = useState(account.apy ? String(account.apy) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isHysa = account.type === 'hysa';

  const save = async () => {
    const bal = parseFloat(balance);
    const rate = parseFloat(apy);
    if (isNaN(bal) || bal < 0) { setError('Enter the current balance.'); return; }
    if (isHysa && (isNaN(rate) || rate < 0 || rate > 20)) { setError('Enter the APY as a percentage, e.g. 4.40.'); return; }
    setSaving(true);
    setError('');
    try {
      await updateAccount(sheetId, accessToken, account.id, { balance: bal, ...(isHysa ? { apy: rate } : {}) });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title={account.name} subtitle={isHysa ? 'Balance updates also log a history snapshot' : 'Cash balance at the brokerage'} onClose={onClose}>
      <Field label="Current balance">
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
          <input type="number" step="0.01" min="0" value={balance} onChange={e => setBalance(e.target.value)}
            className={`${inputCls} pl-8`} style={inputStyle} autoFocus placeholder="0.00" />
        </div>
      </Field>
      {isHysa && (
        <Field label="APY %">
          <input type="number" step="0.01" min="0" max="20" value={apy} onChange={e => setApy(e.target.value)}
            className={inputCls} style={inputStyle} placeholder="4.40" />
        </Field>
      )}
      <ErrorNote error={error} />
      <SaveButton saving={saving} onClick={save}>Save</SaveButton>
    </Sheet>
  );
}

// ── Add a single activity ───────────────────────────────────────────────────

const NEEDS_SYMBOL = new Set(['BUY', 'SELL', 'DIVIDEND']);
const NEEDS_QTY = new Set(['BUY', 'SELL']);

export function AddActivityDialog({ accounts, sheetId, accessToken, onClose, onSaved }) {
  const [accountId, setAccountId] = useState(accounts.find(a => a.type === 'brokerage')?.id || accounts[0]?.id || '');
  const [type, setType] = useState('BUY');
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    if (!accountId) { setError('Pick an account.'); return; }
    if (NEEDS_SYMBOL.has(type) && !symbol.trim()) { setError('Enter the ticker symbol.'); return; }
    const q = parseFloat(qty), p = parseFloat(price), amt = parseFloat(amount);
    if (NEEDS_QTY.has(type) && (!(q > 0) || !(p > 0))) { setError('Enter shares and price.'); return; }
    if (!NEEDS_QTY.has(type) && !(amt > 0)) { setError('Enter the amount.'); return; }
    setSaving(true);
    try {
      await appendActivity(sheetId, accessToken, {
        date, accountId, type,
        symbol: NEEDS_SYMBOL.has(type) ? symbol.trim() : '',
        qty: NEEDS_QTY.has(type) ? q : '',
        price: NEEDS_QTY.has(type) ? p : '',
        amount: NEEDS_QTY.has(type) ? +(q * p).toFixed(2) : amt,
        note: 'manual',
      });
      onSaved?.();
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet title="Add activity" subtitle="A buy, sell, dividend, deposit, or interest post" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Account">
          <select value={accountId} onChange={e => setAccountId(e.target.value)} className={`${inputCls} cursor-pointer`} style={inputStyle}>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={type} onChange={e => setType(e.target.value)} className={`${inputCls} cursor-pointer`} style={inputStyle}>
            {ACTIVITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      {NEEDS_SYMBOL.has(type) && (
        <Field label="Symbol">
          <input type="text" value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
            className={inputCls} style={inputStyle} placeholder="VOO" autoCapitalize="characters" />
        </Field>
      )}
      {NEEDS_QTY.has(type) ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Shares">
            <input type="number" step="any" min="0" value={qty} onChange={e => setQty(e.target.value)} className={inputCls} style={inputStyle} placeholder="10" />
          </Field>
          <Field label="Price / share">
            <input type="number" step="0.01" min="0" value={price} onChange={e => setPrice(e.target.value)} className={inputCls} style={inputStyle} placeholder="512.40" />
          </Field>
        </div>
      ) : (
        <Field label="Amount">
          <div className="relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-sm" style={{ color: 'var(--color-text-muted)' }}>$</span>
            <input type="number" step="0.01" min="0" value={amount} onChange={e => setAmount(e.target.value)} className={`${inputCls} pl-8`} style={inputStyle} placeholder="2000.00" />
          </div>
        </Field>
      )}
      <Field label="Date">
        <input type="date" value={date} onChange={e => setDate(e.target.value || todayIso())} className={inputCls} style={inputStyle} />
      </Field>
      <ErrorNote error={error} />
      <SaveButton saving={saving} onClick={save} icon={Plus}>Add activity</SaveButton>
    </Sheet>
  );
}

// ── Fidelity CSV import ─────────────────────────────────────────────────────

export function ImportCsvDialog({ sheetId, accessToken, onClose, onSaved }) {
  const [parsed, setParsed] = useState(null); // { kind, activities, skipped, fileName, error }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    const text = await file.text();
    const result = parseFidelityCsv(text, { accountId: 'fidelity' });
    if (result.error) { setError(result.error); setParsed(null); return; }
    setParsed({ ...result, fileName: file.name });
  };

  const doImport = async () => {
    if (!parsed?.activities?.length) return;
    setSaving(true);
    setError('');
    try {
      await appendActivities(sheetId, accessToken, parsed.activities);
      onSaved?.(parsed.activities.length);
      onClose();
    } catch (e) {
      setError(e.message || 'Import failed.');
    } finally {
      setSaving(false);
    }
  };

  const counts = parsed
    ? parsed.activities.reduce((m, a) => { m[a.type] = (m[a.type] || 0) + 1; return m; }, {})
    : null;

  return (
    <Sheet title="Import Fidelity CSV" subtitle="Positions export seeds lots; activity export imports full history" onClose={onClose}>
      <div
        onClick={() => fileRef.current?.click()}
        className="border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all"
        style={{ borderColor: 'var(--sur-15)', background: 'var(--sur-3)' }}
      >
        <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={handleFile} className="sr-only" />
        <Upload className="w-8 h-8 mx-auto mb-3" style={{ color: 'var(--color-text-muted)' }} />
        <p className="text-sm font-bold" style={{ color: 'var(--color-text-secondary)' }}>
          {parsed ? parsed.fileName : <>Drop or <span style={{ color: 'var(--color-accent-text)' }}>browse</span> a Fidelity CSV</>}
        </p>
        <p className="text-xs mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
          Fidelity → Accounts → Positions or Activity → Download
        </p>
      </div>

      {parsed && (
        <div className="rounded-2xl px-4 py-3 space-y-1" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-10)' }}>
          <p className="text-xs font-black" style={{ color: 'var(--color-text)' }}>
            {parsed.kind === 'positions' ? 'Positions export' : 'Activity export'} · {parsed.activities.length} row{parsed.activities.length !== 1 ? 's' : ''} ready
          </p>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
            {Object.entries(counts).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(' · ')}
            {parsed.skipped > 0 && ` · ${parsed.skipped} skipped`}
          </p>
          {parsed.kind === 'positions' && (
            <p className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
              Seeds one opening lot per symbol at average cost. Import the activity CSV later for true lot history.
            </p>
          )}
        </div>
      )}

      <ErrorNote error={error} />
      <SaveButton saving={saving} onClick={doImport} icon={Upload}>
        {parsed ? `Import ${parsed.activities.length} rows` : 'Pick a file first'}
      </SaveButton>
    </Sheet>
  );
}
