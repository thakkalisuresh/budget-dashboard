import React from 'react';
import { Pencil } from 'lucide-react';
import { useCountUp } from './useCountUp.js';

function FormattedValue({ value, currencySymbol }) {
  const animated = useCountUp(value);
  const isNeg = animated < 0;
  const abs = Math.abs(animated).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return <>{isNeg ? '-' : ''}{currencySymbol}{abs}</>;
}

// ── Compact 2×2 grid card (mobile Phase 7) ─────────────────────────────────
export function StatCardCompact({ title, value, subtext, onEdit, currencySymbol = '$', enterDelay = 0 }) {
  const isNeg = value < 0;

  return (
    <div
      className="animate-enter rounded-2xl p-4 flex flex-col gap-2 min-w-0"
      style={{
        '--enter-delay': `${enterDelay}ms`,
        background: 'var(--color-surface)',
        border: '1px solid oklch(100% 0 0 / 8%)',
      }}
    >
      <div className="flex items-start justify-between gap-1">
        <p
          className="text-[10px] font-bold tracking-widest uppercase leading-tight"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {title}
        </p>
        {onEdit && (
          <button
            onClick={onEdit}
            title="Edit"
            className="p-0.5 rounded transition-colors duration-150 flex-shrink-0 -mt-0.5"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>

      <p
        className="text-xl font-black tabular-nums leading-none tracking-tight"
        style={{ color: isNeg ? 'var(--color-danger)' : 'var(--color-text)' }}
      >
        <FormattedValue value={value} currencySymbol={currencySymbol} />
      </p>

      {subtext && (
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full self-start"
          style={isNeg
            ? { background: 'oklch(62% 0.22 25 / 15%)', color: 'var(--color-danger)' }
            : { background: 'oklch(72% 0.17 145 / 15%)', color: 'var(--color-success)' }
          }
        >
          {subtext}
        </span>
      )}
    </div>
  );
}

// ── Hero stat (desktop, full-width) ────────────────────────────────────────
function HeroStat({ title, value, subtext, onEdit, currencySymbol, enterDelay }) {
  const isNeg = value < 0;
  return (
    <div className="animate-enter py-6 px-2" style={{ '--enter-delay': `${enterDelay}ms` }}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-slate-400 tracking-widest uppercase">{title}</p>
        {onEdit && (
          <button
            onClick={onEdit}
            title="Edit"
            className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors duration-150 active:scale-95"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      <p
        className="font-extrabold tabular-nums leading-none tracking-tight text-slate-900 dark:text-white"
        style={{ fontSize: 'clamp(2.5rem, 5vw, 3.5rem)' }}
      >
        <FormattedValue value={value} currencySymbol={currencySymbol} />
      </p>
      {subtext && (
        <div className="mt-4">
          <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
            isNeg
              ? 'bg-rose-100 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400'
              : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
          }`}>
            {subtext}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Inline row card (desktop 3-col strip) ──────────────────────────────────
function InlineStat({ title, value, subtext, onEdit, currencySymbol, valueColor, enterDelay }) {
  const isNeg = value < 0;
  const numColor = valueColor || (isNeg
    ? 'text-rose-500 dark:text-rose-400'
    : 'text-slate-900 dark:text-white');

  return (
    <div
      className="animate-enter bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-800 px-5 py-4 flex items-center justify-between gap-6"
      style={{ '--enter-delay': `${enterDelay}ms` }}
    >
      <div className="min-w-0">
        <p className="text-xs font-semibold text-slate-400 tracking-wide truncate">{title}</p>
        {subtext && <p className="text-[11px] text-slate-400 mt-0.5">{subtext}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <p className={`text-lg font-extrabold tabular-nums ${numColor}`}>
          <FormattedValue value={value} currencySymbol={currencySymbol} />
        </p>
        {onEdit && (
          <button
            onClick={onEdit}
            title="Edit"
            className="p-1 rounded text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 transition-colors duration-150 active:scale-95"
          >
            <Pencil className="w-3 h-3" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Public StatCard — keeps the old API intact for desktop ─────────────────
export function StatCard({ title, value, subtext, onEdit, currencySymbol = '$', hero = false, valueColor, enterDelay = 0 }) {
  if (hero) return <HeroStat title={title} value={value} subtext={subtext} onEdit={onEdit} currencySymbol={currencySymbol} enterDelay={enterDelay} />;
  return <InlineStat title={title} value={value} subtext={subtext} onEdit={onEdit} currencySymbol={currencySymbol} valueColor={valueColor} enterDelay={enterDelay} />;
}
