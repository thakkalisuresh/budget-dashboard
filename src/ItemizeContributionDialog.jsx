import React, { useState } from 'react';
import { Check, Plus, Trash2 } from 'lucide-react';
import { Sheet, Field, ErrorNote, SaveButton, inputCls, inputStyle } from './InvestDialogs.jsx';
import { appendActivities } from './sheetInvest.js';
import { investCache } from './useInvestData.js';
import { itemizeNote, itemizeRemainder, lineCost } from './investItemize.js';

// CVD-safe palette (shared with the invest charts) — teal under, rose over.
const UNDER = '#0d9488';
const OVER  = '#f43f5e';
const todayIso = () => new Date().toISOString().slice(0, 10);
const emptyRow = (date) => ({ symbol: '', qty: '', price: '', date: date || todayIso() });
const fmt = (sym, n) => `${sym}${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ════════════════════════════════════════════════════════════════════════════
// ItemizeContributionDialog — pre-filled multi-BUY entry for one brokerage cash
// DEPOSIT. The user says what they bought (ticker · shares · price); each row
// becomes a BUY activity linked back to the deposit via note "itemize:<uuid>",
// so FIFO lots + overlap/concentration light up for that money. Leftover cash
// is allowed (stays in the sweep); over-allocating only warns.
// ════════════════════════════════════════════════════════════════════════════
export function ItemizeContributionDialog({ pending, sheetId, accessToken, onClose, onSaved, currencySymbol = '$' }) {
  const [rows, setRows] = useState([emptyRow(pending.date)]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const remainder = itemizeRemainder(pending.amount, rows);
  const over = remainder < -0.005;

  const setRow = (i, patch) =>
    setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows(rs => [...rs, emptyRow(pending.date)]);
  const removeRow = (i) => setRows(rs => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs));

  const save = async () => {
    setError('');
    // A row is "blank" when fully empty — skip it. A partially-filled row is an error.
    const isBlank = (r) => !r.symbol.trim() && !String(r.qty).trim() && !String(r.price).trim();
    const active = rows.filter(r => !isBlank(r));
    if (!active.length) { setError('Add at least one buy, or dismiss the nudge instead.'); return; }
    for (const r of active) {
      const q = parseFloat(r.qty), p = parseFloat(r.price);
      if (!r.symbol.trim()) { setError('Every row needs a ticker symbol.'); return; }
      if (!(q > 0) || !(p > 0)) { setError(`Enter shares and price for ${r.symbol.trim().toUpperCase()}.`); return; }
    }

    setSaving(true);
    try {
      const activities = active.map(r => {
        const q = parseFloat(r.qty), p = parseFloat(r.price);
        return {
          date: r.date || pending.date || todayIso(),
          accountId: pending.accountId,
          type: 'BUY',
          symbol: r.symbol.trim(),
          qty: q,
          price: p,
          amount: +(q * p).toFixed(2),
          note: itemizeNote(pending.uuid),
        };
      });
      await appendActivities(sheetId, accessToken, activities);
      // Invalidate caches so derived lots appear on next tab open (matches flow-through).
      investCache.delete(sheetId);
      try { localStorage.removeItem(`budget_invest_cache_${sheetId}`); } catch { /* ignore */ }
      onSaved?.(activities.length);
      onClose();
    } catch (e) {
      setError(e.message || 'Failed to save the buys.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title="Itemize contribution"
      subtitle={`${fmt(currencySymbol, pending.amount)} to ${pending.accountName}${pending.date ? ` · ${pending.date}` : ''}`}
      onClose={onClose}
    >
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="rounded-2xl p-3 space-y-3 motion-safe:transition-all"
            style={{ background: 'var(--sur-3)', border: '1px solid var(--sur-10)' }}>
            <div className="flex items-center gap-2">
              <input
                type="text" value={r.symbol}
                onChange={e => setRow(i, { symbol: e.target.value.toUpperCase() })}
                className={`${inputCls} flex-1`} style={inputStyle}
                placeholder="VOO" autoCapitalize="characters"
                aria-label="Ticker symbol"
              />
              <button
                onClick={() => removeRow(i)} disabled={rows.length === 1}
                className="p-2.5 rounded-xl transition-colors hover:bg-[var(--sur-5)] disabled:opacity-30"
                style={{ color: 'var(--color-text-muted)' }}
                aria-label="Remove row"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Shares">
                <input type="number" step="any" min="0" value={r.qty}
                  onChange={e => setRow(i, { qty: e.target.value })}
                  className={inputCls} style={inputStyle} placeholder="10" />
              </Field>
              <Field label="Price / share">
                <input type="number" step="0.01" min="0" value={r.price}
                  onChange={e => setRow(i, { price: e.target.value })}
                  className={inputCls} style={inputStyle} placeholder="512.40" />
              </Field>
            </div>
            <Field label="Date">
              <input type="date" value={r.date}
                onChange={e => setRow(i, { date: e.target.value || pending.date || todayIso() })}
                className={inputCls} style={inputStyle} />
            </Field>
            <p className="text-[11px] tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
              Line total {fmt(currencySymbol, lineCost(r))}
            </p>
          </div>
        ))}
      </div>

      <button onClick={addRow}
        className="w-full py-2.5 rounded-2xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors"
        style={{ background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)', border: '1px solid var(--color-accent-border)' }}>
        <Plus className="w-3.5 h-3.5" /> Add another buy
      </button>

      {/* Running remainder */}
      <div className="rounded-2xl px-4 py-3 flex items-center justify-between"
        style={{ background: 'var(--sur-5)', border: `1px solid ${over ? OVER : 'var(--sur-10)'}` }}>
        <span className="text-[11px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>
          {over ? 'Over deposit' : 'Left as cash'}
        </span>
        <span className="text-sm font-black tabular-nums" style={{ color: over ? OVER : UNDER }}>
          {fmt(currencySymbol, Math.abs(remainder))}
        </span>
      </div>
      {over && (
        <p className="text-[11px]" style={{ color: 'var(--color-warning)' }}>
          Your buys exceed the {fmt(currencySymbol, pending.amount)} deposit. That's fine if you added cash — the lots still post.
        </p>
      )}

      <ErrorNote error={error} />
      <SaveButton saving={saving} onClick={save} icon={Check}>Save buys</SaveButton>
    </Sheet>
  );
}
