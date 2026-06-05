import React from 'react';

// Semantic color hues for each bucket — these are intentional, not accent-derived
const CATS = [
  {
    key: 'needs', label: '50% — Needs', targetPct: 0.50, icon: '🏠',
    hue: 220,   // blue
    bar: 'oklch(62% 0.18 220)',
    barUnder: null,
    overflow: 'oklch(62% 0.22 25)',
  },
  {
    key: 'wants', label: '30% — Wants', targetPct: 0.30, icon: '🎯',
    hue: 55,    // amber
    bar: 'oklch(78% 0.16 75)',
    barUnder: null,
    overflow: 'oklch(62% 0.22 25)',
  },
  {
    key: 'savings', label: '20% — Savings', targetPct: 0.20, icon: '💰',
    hue: 145,   // emerald
    bar: 'oklch(72% 0.17 145)',
    barUnder: 'oklch(78% 0.16 75)',
    overflow: 'oklch(55% 0.18 145)',
  },
];

export function BudgetRules({ data, loading, currencySymbol = '$' }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="rounded-[2rem] p-8 h-72 skeleton" />
        ))}
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="space-y-6 animate-enter">
      <div>
        <p className="text-xl font-black" style={{ color: 'var(--color-text)' }}>50 / 30 / 20 Budget Rule</p>
        <p className="text-sm mt-1" style={{ color: 'var(--color-text-muted)' }}>Our spending based on the 50/30/20 budget rule</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-stretch">
        {CATS.map(cat => {
          const d = data[cat.key];
          const isSavings = cat.key === 'savings';
          const isOver  = d.diff < 0;
          const isUnder = !isOver;

          const ratio = cat.targetPct > 0 ? d.pct / cat.targetPct : 0;
          const baseFillPct = Math.min(ratio, 1) * 100;
          const overflowPct = isOver ? (ratio - 1) * 100 : 0;

          const barColor = isSavings ? (isUnder ? cat.barUnder : cat.bar) : cat.bar;
          const isGood = isSavings ? isOver : isUnder;

          return (
            <div
              key={cat.key}
              className="rounded-[2rem] p-8 flex flex-col"
              style={{
                background: `oklch(65% 0.18 ${cat.hue} / 7%)`,
                border: `1px solid oklch(65% 0.18 ${cat.hue} / 18%)`,
              }}
            >
              {/* Header */}
              <div className="flex items-start justify-between mb-6">
                <div>
                  <span className="text-xl mr-2">{cat.icon}</span>
                  <span
                    className="text-xs font-black uppercase tracking-widest"
                    style={{ color: `oklch(72% 0.16 ${cat.hue})` }}
                  >
                    {cat.label}
                  </span>
                  <p className="text-3xl font-black mt-2 tabular-nums" style={{ color: 'var(--color-text)' }}>
                    {currencySymbol}{d.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </p>
                </div>
                <span
                  className="text-[10px] font-black px-3 py-1.5 rounded-full uppercase tracking-wider mt-1"
                  style={isGood
                    ? { background: 'oklch(72% 0.17 145 / 15%)', color: 'var(--color-success)' }
                    : { background: 'oklch(62% 0.22 25 / 15%)', color: 'var(--color-danger)' }}
                >
                  {isOver ? 'Over' : 'Under'}
                </span>
              </div>

              {/* Progress bar */}
              <div className="mb-6">
                <div className="flex justify-between text-[10px] font-black uppercase tracking-widest mb-2" style={{ color: 'var(--color-text-muted)' }}>
                  <span>Actual <span style={{ color: 'var(--color-text)' }}>{(d.pct * 100).toFixed(1)}%</span></span>
                  <span>Target <span style={{ color: 'var(--color-text)' }}>{(cat.targetPct * 100).toFixed(0)}%</span></span>
                </div>

                <div className="relative h-3 rounded-full overflow-hidden" style={{ background: 'oklch(100% 0 0 / 10%)' }}>
                  <div
                    className="absolute top-0 left-0 h-full rounded-full transition-all duration-700"
                    style={{ width: `${baseFillPct}%`, background: barColor }}
                  />
                  {isOver && (
                    <div
                      className="absolute top-0 right-0 h-full transition-all duration-700"
                      style={{ width: `${overflowPct}%`, background: cat.overflow }}
                    />
                  )}
                </div>
              </div>

              {/* Category items */}
              <div className="flex-1 space-y-2.5 mb-6">
                {d.items.map((item, i) => (
                  <div key={i} className="flex justify-between items-center">
                    <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>{item.name}</span>
                    <span className="text-xs font-black tabular-nums" style={{ color: 'var(--color-text)' }}>
                      {currencySymbol}{item.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="mt-auto pt-4 space-y-1.5" style={{ borderTop: '1px solid oklch(100% 0 0 / 8%)' }}>
                <div className="flex justify-between text-xs">
                  <span style={{ color: 'var(--color-text-muted)' }}>Target amount</span>
                  <span className="font-bold tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
                    {currencySymbol}{d.target.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <div className="flex justify-between text-xs items-center">
                  <span className="font-black" style={{ color: 'var(--color-text)' }}>How much is left to use</span>
                  <span
                    className="font-black tabular-nums"
                    style={{ color: d.diff < 0 ? 'var(--color-danger)' : 'var(--color-success)' }}
                  >
                    {d.diff < 0 ? '-' : '+'}{currencySymbol}{Math.abs(d.diff).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex justify-between text-xs items-center pt-1">
                  <span className="font-black" style={{ color: 'var(--color-text)' }}>% Utilized</span>
                  <span
                    className="font-black tabular-nums"
                    style={{
                      color: d.pct > cat.targetPct
                        ? (isSavings ? 'var(--color-success)' : 'var(--color-danger)')
                        : d.pct / cat.targetPct >= 0.90
                        ? 'var(--color-warning)'
                        : 'var(--color-success)',
                    }}
                  >
                    {(d.pct * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

            </div>
          );
        })}
      </div>
    </div>
  );
}
