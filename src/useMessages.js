import { useEffect, useRef } from 'react';

const MAX_MESSAGES = 30;

// ── Message generators ────────────────────────────────────────────────────────

function buildDigestBody(expenses, totalActual, salaryReceived, daysLeft, overBudget) {
  const spendPct   = salaryReceived > 0 ? Math.round((totalActual / salaryReceived) * 100) : 0;
  const top3       = [...expenses].sort((a, b) => b.actual - a.actual).slice(0, 3);
  const lines      = [];

  lines.push(`Spent $${totalActual.toFixed(2)} of $${salaryReceived.toFixed(2)} income (${spendPct}%).`);

  if (overBudget.length > 0) {
    lines.push(`${overBudget.length} categor${overBudget.length > 1 ? 'ies' : 'y'} over budget: ${overBudget.map(e => e.name).join(', ')}.`);
  } else {
    lines.push('All categories within budget. 🎉');
  }

  if (top3.length > 0) {
    lines.push(`Top spending: ${top3.map(e => `${e.name} $${e.actual.toFixed(0)}`).join(', ')}.`);
  }

  lines.push(`${daysLeft} day${daysLeft !== 1 ? 's' : ''} left this month.`);
  return lines.join(' ');
}

function generateCandidates(expenses, monthName, salaryReceived, totalActual) {
  const now         = new Date();
  const today       = now.toISOString().split('T')[0];
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft    = Math.max(0, daysInMonth - now.getDate());
  // Only flag as over-budget when there's meaningful spending AND a real budget set
  // The 0.5 threshold avoids floating-point noise from sheet formulas
  const overBudget  = expenses.filter(e => e.remaining < -0.5 && e.actual > 0.5 && e.budget > 0);
  const candidates  = [];

  // ── Over-budget alerts (one per category per month) ──
  for (const exp of overBudget) {
    candidates.push({
      id:        `over_budget_${exp.name}_${monthName}`,
      type:      'over_budget',
      title:     `${exp.name} is over budget`,
      body:      `You've spent $${Math.abs(exp.remaining).toFixed(2)} more than your ${exp.name} budget for ${monthName}.`,
      timestamp: now.toISOString(),
      read:      false,
    });
  }

  // ── 80% budget alerts (one per category per month) ──
  const nearBudget = expenses.filter(e =>
    e.budget > 0 &&
    e.actual > 0 &&
    e.remaining >= 0 &&                          // not yet over
    (e.actual / e.budget) >= 0.8                 // at or past 80%
  );
  for (const exp of nearBudget) {
    const pct = Math.round((exp.actual / exp.budget) * 100);
    candidates.push({
      id:        `near_budget_${exp.name}_${monthName}`,
      type:      'near_budget',
      title:     `${exp.name} at ${pct}% of budget`,
      body:      `$${exp.remaining.toFixed(2)} remaining in ${exp.name} for ${monthName}.`,
      timestamp: now.toISOString(),
      read:      false,
    });
  }

  // ── Daily digest (once per calendar day) ──
  candidates.push({
    id:        `digest_${today}_${monthName}`,
    type:      'digest',
    title:     `${monthName} · Daily Digest`,
    body:      buildDigestBody(expenses, totalActual, salaryReceived, daysLeft, overBudget),
    timestamp: now.toISOString(),
    read:      false,
  });

  return candidates;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMessages(settings, updateSettings, expenses, totalActual, salaryReceived, monthName) {
  const generated = useRef(new Set()); // track which monthName+today combos we've run

  useEffect(() => {
    if (!expenses.length || !monthName || salaryReceived <= 0) return;

    const today = new Date().toISOString().split('T')[0];
    const runKey = `${monthName}_${today}`;
    if (generated.current.has(runKey)) return;
    generated.current.add(runKey);

    const existing    = settings.messages || [];
    const existingIds = new Set(existing.map(m => m.id));
    const candidates  = generateCandidates(expenses, monthName, salaryReceived, totalActual);
    const fresh       = candidates.filter(m => !existingIds.has(m.id));
    if (fresh.length === 0) return;

    // Prepend new messages, cap at MAX_MESSAGES
    updateSettings(prev => ({
      ...prev,
      messages: [...fresh, ...(prev.messages || [])].slice(0, MAX_MESSAGES),
    }));
  }, [expenses, monthName, salaryReceived, totalActual]);

  const messages   = settings.messages || [];
  const unreadCount = messages.filter(m => !m.read).length;

  const markAllRead = () =>
    updateSettings(prev => ({
      ...prev,
      messages: (prev.messages || []).map(m => ({ ...m, read: true })),
    }));

  const dismissMessage = (id) =>
    updateSettings(prev => ({
      ...prev,
      messages: (prev.messages || []).filter(m => m.id !== id),
    }));

  const clearAll = () =>
    updateSettings(prev => ({ ...prev, messages: [] }));

  return { messages, unreadCount, markAllRead, dismissMessage, clearAll };
}
