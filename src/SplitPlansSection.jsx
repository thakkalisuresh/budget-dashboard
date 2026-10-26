import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { addOrUpdateExpense, todayIso } from './sheetsApi.js';
import {
  computeInstallments, nextDueInstallment, isPlanComplete, markPlaced, removeSplitPlan,
} from './splitPlans.js';

// Settings section listing active installment plans: progress, cancel, and a
// manual "place the next installment into the open month" for when a month
// already exists (the New Month wizard places them automatically otherwise).
export function SplitPlansSection({ splitPlans = [], updateSettings, accessToken, sheetId, months = [], currencySymbol = '$' }) {
  const [busy, setBusy] = useState(null);
  const [err, setErr]   = useState('');

  const monthName = months.find(m => m.sheetId === sheetId)?.name || '';
  const active = splitPlans.filter(p => !isPlanComplete(p));

  const placeNext = async (plan) => {
    const due = nextDueInstallment(plan);
    if (!due || !sheetId) return;
    setBusy(plan.id);
    setErr('');
    try {
      await addOrUpdateExpense(plan.category, due.label, due.amount, accessToken, sheetId, monthName, 'split', todayIso(), plan.card || '');
      updateSettings(prev => ({
        ...prev,
        splitPlans: (prev.splitPlans || []).map(p => p.id === plan.id ? markPlaced(p, due.number) : p),
      }));
    } catch (e) {
      setErr(e.message || 'Could not place the installment.');
    } finally {
      setBusy(null);
    }
  };

  const cancel = (plan) => {
    updateSettings(prev => ({ ...prev, splitPlans: removeSplitPlan(prev.splitPlans || [], plan.id) }));
  };

  return (
    <div>
      <p className="text-[10px] font-black uppercase tracking-widest mb-3" style={{ color: 'var(--color-text-muted)' }}>Installments</p>
      {active.length === 0 ? (
        <div className="rounded-2xl px-4 py-6 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No active splits.</p>
          <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
            Turn on "Split across months" when adding an expense, or use the layers icon on a transaction.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
          {active.map((plan) => {
            const per = computeInstallments(plan.totalAmount, plan.installments)[0] || 0;
            const placedCount = (plan.placed || []).length;
            const due = nextDueInstallment(plan);
            return (
              <div key={plan.id} className="px-4 py-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--sur-8)' }}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{plan.vendor}</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                    {plan.category} · {placedCount}/{plan.installments} placed · {currencySymbol}{per.toFixed(2)}/mo
                  </p>
                </div>
                {due && monthName && (
                  <button
                    onClick={() => placeNext(plan)}
                    disabled={busy === plan.id}
                    className="px-2.5 py-1.5 rounded-xl text-xs font-bold transition-colors disabled:opacity-40 flex items-center gap-1"
                    style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
                    title={`Add ${due.label} to ${monthName}`}
                  >
                    {busy === plan.id ? '…' : <>Place {due.number}/{plan.installments}</>}
                  </button>
                )}
                <button
                  onClick={() => cancel(plan)}
                  className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]"
                  style={{ color: 'var(--color-text-muted)' }}
                  title="Cancel this split (placed rows stay)"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {err && <p className="text-xs mt-2" style={{ color: 'var(--color-danger)' }}>{err}</p>}
    </div>
  );
}
