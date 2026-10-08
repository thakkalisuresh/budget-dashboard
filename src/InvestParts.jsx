import React, { useState, useRef, useEffect } from 'react';
import { ChevronLeft, ChevronRight, Pencil, ListPlus, X, Search } from 'lucide-react';
import { goalPct, monthlyInterest, monthsToGoal, horizonLabel, futureValue, FDIC_MAX } from './investMath.js';

// Validated categorical palette (dark surface, CVD ΔE ≥ 12) — fixed order.
export const CHART_COLORS = ['#6366f1', '#d97706', '#0d9488', '#f43f5e', '#0284c7'];
const OTHER_COLOR = 'oklch(55% 0.02 265)';
// Liquid fills per HYSA account — indigo for Amex, teal for Happen (matches orbit).
const HYSA_FILL = { 'amex-hysa': ['#6366f1', '#4f52c9'], 'happen-hysa': ['#0d9488', '#0a6e63'] };
const hysaFill = (id, i) => HYSA_FILL[id] || [CHART_COLORS[i % 5], CHART_COLORS[i % 5]];

const fmtMoney = (n, sym = '$', digits = 0) =>
  `${sym}${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

// ── Ticker tape ──────────────────────────────────────────────────────────────

export function InvestTape({ positions, blendedApyPct, quotesStale }) {
  const items = [
    ...positions.map(p => ({
      label: p.symbol,
      value: p.price ? `$${p.price.toFixed(2)}` : '—',
      delta: p.stale ? null : (p.price && p.value - p.dayChange > 0 ? (p.dayChange / (p.value - p.dayChange)) * 100 : 0),
    })),
    { label: 'HYSA', value: `${blendedApyPct.toFixed(2)}% APY`, delta: null },
  ];
  if (!positions.length) return null;
  const half = items.map((q, i) => (
    <span key={i} className="tabular-nums" style={{ fontSize: 11.5, fontWeight: 800, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
      <b style={{ color: 'var(--color-text)', marginRight: 7 }}>{q.label}</b>
      {q.value}
      {q.delta != null && (
        <span style={{ marginLeft: 5, color: q.delta >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {q.delta >= 0 ? '+' : '−'}{Math.abs(q.delta).toFixed(2)}%
        </span>
      )}
    </span>
  ));
  return (
    <div aria-hidden="true" style={{ display: 'flex', overflow: 'hidden', borderTop: '1px solid var(--sur-8)', borderBottom: '1px solid var(--sur-8)', padding: '9px 0', margin: '0 -1rem' }}>
      <div className="invest-tape-inner" style={{ display: 'flex', gap: 26, paddingLeft: 16, opacity: quotesStale ? 0.55 : 1 }}>
        {half}{half}
      </div>
    </div>
  );
}

// ── Liquid FDIC goal gauge (shared by savings card + account card) ──────────

function LiquidGauge({ pct, fill, height = 118, cap = '$250k FDIC max', children }) {
  const [waveHi, waveLo] = fill;
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setArmed(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <div style={{ position: 'relative', height, borderRadius: 18, overflow: 'hidden', background: 'var(--sur-4)', border: '1px solid var(--sur-10)' }}>
      <div style={{ position: 'absolute', top: 7, left: 0, right: 0, textAlign: 'center', fontSize: 8.5, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-text-muted)', zIndex: 3 }}>
        {cap}
      </div>
      <div style={{ position: 'absolute', top: 20, left: 10, right: 10, borderTop: '1px dashed var(--sur-25)', zIndex: 2 }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 24 }}>
        <div style={{ position: 'absolute', insetInline: 0, bottom: 0, height: armed ? `${Math.max(pct, 1.5)}%` : '0%', overflow: 'hidden', transition: 'height 1.4s cubic-bezier(0.19,1,0.22,1)' }}>
          <svg className="invest-drift" viewBox="0 0 200 22" preserveAspectRatio="none" style={{ position: 'absolute', bottom: 0, left: 0, width: '200%', height: 22 }}>
            <path d="M0,8 Q25,2 50,8 T100,8 T150,8 T200,8 V22 H0 Z" fill={waveHi} />
          </svg>
          <div style={{ position: 'absolute', top: 14, left: 0, right: 0, bottom: 0, background: waveLo }} />
        </div>
      </div>
      <div style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', paddingTop: 10 }}>
        {children}
      </div>
    </div>
  );
}

// ── Savings card: both HYSAs vs the $250k goal + projection ─────────────────

export function InvestSavingsCard({ hysaAccounts, monthlyContribution, currencySymbol, onEditAccount }) {
  const total = hysaAccounts.reduce((s, a) => s + a.balance, 0);
  const weightedApy = total > 0 ? hysaAccounts.reduce((s, a) => s + a.balance * a.apy, 0) / total : 0;
  const interest = hysaAccounts.reduce((s, a) => s + monthlyInterest(a.balance, a.apy), 0);

  // Projection to December from today's pace (deposits attributed per account upstream).
  const monthsToDec = Math.max(1, 12 - new Date().getMonth());
  const decValue = futureValue(total, weightedApy, monthlyContribution, monthsToDec);
  const horizons = hysaAccounts.map(a => monthsToGoal(a.balance, a.apy, a.monthContribution || 0, a.goal || FDIC_MAX));
  const horizonNote = horizons.every(h => !isFinite(h))
    ? 'add deposits to project the FDIC goal'
    : `FDIC goals ${horizons.map(horizonLabel).join(' / ')} out`;

  return (
    <div className="glass-heavy" style={{ border: '1px solid var(--sur-10)', borderRadius: 26, padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>Savings</p>
          <h3 className="tabular-nums" style={{ fontSize: 13, fontWeight: 900, color: 'var(--color-text)' }}>
            {fmtMoney(total, currencySymbol)} across {hysaAccounts.length} HYSA{hysaAccounts.length !== 1 ? 's' : ''}
          </h3>
        </div>
        {interest > 0 && (
          <span className="tabular-nums" style={{ fontSize: 11, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: 'var(--color-success)', background: 'oklch(72% 0.17 145 / 11%)' }}>
            ≈ {fmtMoney(interest, currencySymbol)}/mo interest
          </span>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
        {hysaAccounts.map((a, i) => (
          <button key={a.id} onClick={() => onEditAccount(a)} style={{ all: 'unset', cursor: 'pointer' }} title="Update balance / APY">
            <LiquidGauge pct={goalPct(a.balance, a.goal || FDIC_MAX)} fill={hysaFill(a.id, i)}>
              <b className="tabular-nums" style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-text)', textShadow: '0 1px 8px rgba(0,0,0,.6)' }}>
                {fmtMoney(a.balance, currencySymbol)}
              </b>
              <span style={{ fontSize: 10, color: 'var(--color-text-secondary)', fontWeight: 700, marginTop: 1 }}>
                {a.name.split(' ')[0]} · {a.apy.toFixed(2)}%
              </span>
              <span className="tabular-nums" style={{ fontSize: 10, fontWeight: 800, marginTop: 5, color: hysaFill(a.id, i)[0] }}>
                {goalPct(a.balance, a.goal || FDIC_MAX).toFixed(1)}% there
              </span>
            </LiquidGauge>
          </button>
        ))}
      </div>

      {total > 0 && (
        <div style={{ marginTop: 4 }}>
          <svg viewBox="0 0 360 70" preserveAspectRatio="none" style={{ width: '100%', height: 70, display: 'block', marginTop: 10 }} aria-label="Savings projection">
            <path d="M0,54 C60,50 120,44 180,37 C240,30 300,19 358,8" fill="none" stroke="var(--sur-15)" strokeWidth="1.5" strokeDasharray="3 5" />
            <path className="invest-draw" d="M0,54 C60,50 120,44 180,37" fill="none" stroke="var(--color-accent)" strokeWidth="2.5" />
            <circle cx="180" cy="37" r="4" fill="var(--color-accent)" />
            <text x="188" y="31" fontSize="10" fontWeight="800" fill="var(--color-text)">now</text>
            <text x="354" y="20" textAnchor="end" fontSize="10" fontWeight="800" fill="var(--color-text-muted)">
              {fmtMoney(decValue, currencySymbol)} by Dec
            </text>
          </svg>
          <p style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600 }}>
            On pace at {fmtMoney(monthlyContribution, currencySymbol)}/mo + blended {weightedApy.toFixed(2)}% APY · {horizonNote}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Account card with ‹ › switcher + 3D tilt ────────────────────────────────

export function InvestAccountCard({ hysaAccounts, currencySymbol, rateWatch, onEditAccount }) {
  const [idx, setIdx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const cardRef = useRef(null);
  if (!hysaAccounts.length) return null;
  const a = hysaAccounts[Math.min(idx, hysaAccounts.length - 1)];
  const pct = goalPct(a.balance, a.goal || FDIC_MAX);
  const months = monthsToGoal(a.balance, a.apy, a.monthContribution || 0, a.goal || FDIC_MAX);
  const best = rateWatch[0];
  const beatenBy = best && best.bestApy > a.apy ? best : null;
  const [waveHi, waveLo] = hysaFill(a.id, idx);

  const swap = (dir) => {
    setLeaving(true);
    setTimeout(() => {
      setIdx(i => (i + dir + hysaAccounts.length) % hysaAccounts.length);
      setLeaving(false);
    }, 240);
  };

  const tilt = (e) => {
    const el = cardRef.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = e.touches ? e.touches[0] : e;
    const r = el.getBoundingClientRect();
    const px = (t.clientX - r.left) / r.width - 0.5;
    const py = (t.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(700px) rotateX(${(-py * 8).toFixed(2)}deg) rotateY(${(px * 8).toFixed(2)}deg)`;
  };
  const untilt = () => { if (cardRef.current) cardRef.current.style.transform = 'perspective(700px)'; };

  return (
    <div
      ref={cardRef}
      className="invest-tilt"
      onPointerMove={tilt} onPointerLeave={untilt} onTouchMove={tilt} onTouchEnd={untilt}
      style={{
        borderRadius: 22, padding: 18, marginBottom: 14,
        background: 'linear-gradient(160deg, var(--sur-8), var(--color-surface))',
        border: '1px solid var(--sur-12)',
        boxShadow: '0 18px 40px rgba(0,0,0,.35)',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={() => swap(-1)} aria-label="Previous account"
          style={{ width: 34, height: 34, borderRadius: 12, border: '1px solid var(--sur-15)', background: 'var(--sur-5)', color: 'var(--color-text-secondary)', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ChevronLeft size={16} />
        </button>

        <div style={{ flex: 1, minWidth: 0, opacity: leaving ? 0 : 1, transform: leaving ? 'translateX(-14px)' : 'none', transition: 'opacity .24s, transform .24s' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>{a.name}</p>
              <p className="tabular-nums" style={{ fontSize: 24, fontWeight: 900, color: 'var(--color-text)', letterSpacing: '-0.01em', marginTop: 2 }}>
                {fmtMoney(a.balance, currencySymbol)}
              </p>
            </div>
            <span className="tabular-nums" style={{ fontSize: 12, fontWeight: 900, color: beatenBy ? 'var(--color-warning)' : 'var(--color-accent-text)' }}>
              {a.apy.toFixed(2)}% APY
            </span>
            <button onClick={() => onEditAccount(a)} aria-label={`Edit ${a.name}`}
              style={{ border: 0, background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 4 }}>
              <Pencil size={13} />
            </button>
          </div>

          <div style={{ position: 'relative', height: 88, borderRadius: 16, overflow: 'hidden', background: 'var(--sur-4)', border: '1px solid var(--sur-10)', marginTop: 12 }}>
            <span style={{ position: 'absolute', top: 4, right: 12, fontSize: 8.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-muted)', zIndex: 3 }}>$250k FDIC max</span>
            <div style={{ position: 'absolute', top: 16, left: 10, right: 10, borderTop: '1px dashed var(--sur-25)', zIndex: 2 }} />
            <div style={{ position: 'absolute', insetInline: 0, bottom: 0, height: `${Math.max(pct, 1.5)}%`, overflow: 'hidden', opacity: 0.55, transition: 'height 1.2s cubic-bezier(0.19,1,0.22,1)' }}>
              <svg className="invest-drift" viewBox="0 0 200 22" preserveAspectRatio="none" style={{ position: 'absolute', bottom: 0, left: 0, width: '200%', height: 22 }}>
                <path d="M0,8 Q25,2 50,8 T100,8 T150,8 T200,8 V22 H0 Z" fill={waveHi} />
              </svg>
              <div style={{ position: 'absolute', top: 12, left: 0, right: 0, bottom: 0, background: waveLo }} />
            </div>
            {/* Two facts max — a third line collides with the FDIC caption */}
            <div className="tabular-nums" style={{ position: 'absolute', inset: 0, zIndex: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 800, color: 'var(--color-text)', textShadow: '0 1px 10px rgba(0,0,0,.6)', padding: '18px 14px 0', textAlign: 'center' }}>
              {pct.toFixed(1)}% to FDIC max
              {isFinite(months) && months > 0
                ? ` · ${horizonLabel(months)} at pace`
                : monthlyInterest(a.balance, a.apy) > 0
                  ? ` · ≈${fmtMoney(monthlyInterest(a.balance, a.apy), currencySymbol)}/mo interest`
                  : ''}
            </div>
          </div>
        </div>

        <button onClick={() => swap(1)} aria-label="Next account"
          style={{ width: 34, height: 34, borderRadius: 12, border: '1px solid var(--sur-15)', background: 'var(--sur-5)', color: 'var(--color-text-secondary)', cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ChevronRight size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 5, justifyContent: 'center', marginTop: 12 }}>
        {hysaAccounts.map((_, i) => (
          <i key={i} style={{ width: 6, height: 6, borderRadius: 99, background: i === idx ? 'var(--color-accent)' : 'var(--sur-20)', transition: 'background .3s' }} />
        ))}
      </div>
    </div>
  );
}

// ── Rate watch card ──────────────────────────────────────────────────────────

export function RateWatchCard({ rateWatch, hysaAccounts, currencySymbol, onConfirmProposal, onDismissProposal }) {
  const latest = rateWatch[0];
  const yourBest = Math.max(0, ...hysaAccounts.map(a => a.apy));
  // Held-bank advertised-rate changes the scan proposed. These are NEVER applied
  // automatically — an advertised new-customer rate isn't necessarily yours.
  const proposals = latest?.proposals || [];
  const [pendingId, setPendingId] = useState(null);

  const act = async (fn, p) => {
    if (pendingId) return;
    setPendingId(p.accountId);
    try { await fn?.(p); } finally { setPendingId(null); }
  };

  return (
    <div className="glass-heavy" style={{ border: '1px solid oklch(78% 0.16 75 / 30%)', borderRadius: 26, padding: 18, marginBottom: 14 }}>
      <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-warning)' }}>
        Rate watch{latest ? ` · ${latest.scanDate}` : ''}
      </p>
      {latest ? (
        <>
          <h3 className="tabular-nums" style={{ fontSize: 13, fontWeight: 900, color: 'var(--color-text)', marginTop: 2 }}>
            {latest.bestBank} pays {latest.bestApy.toFixed(2)}% APY
          </h3>
          <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
            {latest.delta > 0 ? (
              <>Beats your best ({yourBest.toFixed(2)}%) by <b style={{ color: 'var(--color-text)' }}>+{latest.delta.toFixed(2)}%</b>.
              {' '}Moving {fmtMoney(hysaAccounts.reduce((s, a) => s + a.balance, 0), currencySymbol)} earns
              {' '}<b style={{ color: 'var(--color-text)' }}>≈ {fmtMoney(hysaAccounts.reduce((s, a) => s + a.balance, 0) * latest.delta / 100, currencySymbol)} more</b> per year.</>
            ) : (
              <>Your {yourBest.toFixed(2)}% is at the top of the market. Nothing to do. 🎉</>
            )}
            {latest.details.length > 1 && ` ${latest.details.length - 1} more option${latest.details.length > 2 ? 's' : ''} in the scan.`}
          </p>
        </>
      ) : (
        <p style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
          The bi-weekly APY scan hasn't run yet — first digest lands on the next 1st or 15th, on Telegram and push.
        </p>
      )}

      {proposals.length > 0 && (onConfirmProposal || onDismissProposal) && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {proposals.map((p) => (
            <div key={p.accountId} style={{ borderTop: '1px solid var(--sur-8)', paddingTop: 10 }}>
              <p style={{ fontSize: 12, color: 'var(--color-text)', lineHeight: 1.5 }}>
                <b>{p.bank}</b> now advertises <b className="tabular-nums">{Number(p.proposedApy).toFixed(2)}%</b>
                {' '}(you have <span className="tabular-nums">{Number(p.currentApy).toFixed(2)}%</span>
                {p.effectiveDate ? `, eff. ${p.effectiveDate}` : ''}). Promo tiers and grandfathering mean this may not be your rate.
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => act(onConfirmProposal, p)}
                  disabled={pendingId === p.accountId}
                  className="tabular-nums"
                  style={{ flex: '1 1 auto', padding: '8px 12px', borderRadius: 14, fontSize: 12, fontWeight: 800, color: '#fff', background: 'var(--color-accent)', border: 'none', cursor: pendingId ? 'default' : 'pointer', opacity: pendingId === p.accountId ? 0.6 : 1 }}>
                  Update to {Number(p.proposedApy).toFixed(2)}%
                </button>
                <button
                  onClick={() => act(onDismissProposal, p)}
                  disabled={pendingId === p.accountId}
                  style={{ padding: '8px 12px', borderRadius: 14, fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)', background: 'var(--sur-8)', border: 'none', cursor: pendingId ? 'default' : 'pointer', opacity: pendingId === p.accountId ? 0.6 : 1 }}>
                  Not my rate
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Itemize-contribution nudge ───────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Format an ISO (YYYY-MM-DD) date as "Oct 7" without timezone drift.
function fmtShortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
}

/**
 * Dismissible card prompting the user to say what a brokerage cash deposit
 * bought. Presentational — state lives in InvestTab. Renders nothing when there
 * are no pending itemizations.
 */
export function ItemizeNudgeCard({ pending, currencySymbol = '$', onItemize, onDismiss }) {
  if (!pending?.length) return null;
  return (
    <div className="glass-heavy" style={{ border: '1px solid var(--color-accent-border)', borderRadius: 26, padding: 18, marginBottom: 14 }}>
      <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
        <ListPlus className="w-4 h-4" style={{ color: 'var(--color-accent-text)' }} />
        <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-accent-text)' }}>
          {pending.length} contribution{pending.length !== 1 ? 's' : ''} to itemize
        </p>
      </div>
      <div className="space-y-2">
        {pending.map(p => (
          <div key={p.uuid} className="flex items-center gap-2">
            <button
              onClick={() => onItemize?.(p)}
              className="flex-1 text-left rounded-2xl px-4 py-3 transition-all active:scale-[0.99]"
              style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-10)' }}
            >
              <span className="text-sm font-black tabular-nums" style={{ color: 'var(--color-text)' }}>
                {fmtMoney(p.amount, currencySymbol)}
              </span>
              <span className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                {' '}to {p.accountName}{p.date ? ` · ${fmtShortDate(p.date)}` : ''}
              </span>
              <span className="block text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                Tap to record what you bought
              </span>
            </button>
            <button
              onClick={() => onDismiss?.(p.uuid)}
              className="p-2.5 rounded-xl transition-colors hover:bg-[var(--sur-5)]"
              style={{ color: 'var(--color-text-muted)' }}
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Equities: Apple-Stocks-style rows ────────────────────────────────────────

/** Today's real range as an 8-point sparkline: open → low/high excursion → last. */
function sparkPoints(q) {
  if (!q || !(q.price > 0)) return null;
  const { open = q.price, high = q.price, low = q.price, price } = q;
  const span = Math.max(high - low, price * 0.0005);
  const y = (v) => 26 - ((v - low) / span) * 22 - 2;
  const up = price >= open;
  const seq = up ? [open, low, open, (open + high) / 2, high, (high + price) / 2, price]
               : [open, high, open, (open + low) / 2, low, (low + price) / 2, price];
  return seq.map((v, i) => `${Math.round((i / (seq.length - 1)) * 84)},${y(v).toFixed(1)}`).join(' ');
}

export function InvestEquityRows({ positions, currencySymbol, lastUpdated, quotesStale, onCheck }) {
  const [flash, setFlash] = useState({});
  const prevPrices = useRef({});

  useEffect(() => {
    const next = {};
    for (const p of positions) {
      const prev = prevPrices.current[p.symbol];
      if (prev != null && p.price !== prev) next[p.symbol] = p.price > prev ? 'tick-up' : 'tick-dn';
      prevPrices.current[p.symbol] = p.price;
    }
    if (Object.keys(next).length) {
      setFlash(next);
      const t = setTimeout(() => setFlash({}), 700);
      return () => clearTimeout(t);
    }
  }, [positions]);

  if (!positions.length) return null;

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 2px 10px' }}>
        <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>Equities · Fidelity</p>
        <span style={{ fontSize: 10.5, fontWeight: 600, color: quotesStale ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
          {quotesStale ? 'rate-limited — showing last' : lastUpdated ? 'delayed ~15 min' : 'loading quotes…'}
        </span>
      </div>
      <div style={{ borderRadius: 22, overflow: 'hidden', background: 'var(--sur-4)', border: '1px solid var(--sur-10)' }}>
        {positions.map((p, i) => {
          const pts = sparkPoints(p.quote);
          const dayPct = p.value - p.dayChange > 0 ? (p.dayChange / (p.value - p.dayChange)) * 100 : 0;
          const up = dayPct >= 0;
          return (
            <div key={p.symbol} style={{ display: 'grid', gridTemplateColumns: '1fr 84px 96px', gap: 10, alignItems: 'center', padding: '13px 16px', borderTop: i > 0 ? '1px solid var(--sur-8)' : 'none' }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: 15, fontWeight: 900, color: 'var(--color-text)', letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.symbol}
                  {p.etf && (
                    <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: '0.08em', padding: '2px 5px', borderRadius: 5, color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' }}>ETF</span>
                  )}
                  {onCheck && (
                    <button onClick={() => onCheck(p.symbol)} aria-label={`Check ${p.symbol} before buying more`} title="Candidate check"
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 3, borderRadius: 6, color: 'var(--color-text-muted)', background: 'var(--sur-6)', border: '1px solid var(--sur-10)' }}>
                      <Search className="w-3 h-3" />
                    </button>
                  )}
                </p>
                <p className="tabular-nums" style={{ fontSize: 11, color: 'var(--color-text-muted)', fontWeight: 600, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.qty.toLocaleString(undefined, { maximumFractionDigits: 3 })} sh · {fmtMoney(p.value, currencySymbol)}
                </p>
              </div>
              {pts ? (
                <svg viewBox="0 0 84 30" style={{ width: 84, height: 30 }} aria-hidden="true">
                  <polyline points={`${pts} 84,30 0,30`} fill={up ? 'var(--color-success)' : 'var(--color-danger)'} opacity="0.14" stroke="none" />
                  <polyline className="invest-draw" points={pts} fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    stroke={up ? 'var(--color-success)' : 'var(--color-danger)'} style={{ strokeDasharray: 220, strokeDashoffset: 220 }} />
                </svg>
              ) : <span style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'center' }}>—</span>}
              <div className={`invest-tick ${flash[p.symbol] || ''}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <b className="tabular-nums" style={{ fontSize: 14.5, fontWeight: 900, color: 'var(--color-text)' }}>
                  {p.stale ? fmtMoney(p.price, currencySymbol, 2) : `$${p.price.toFixed(2)}`}
                </b>
                {p.stale ? (
                  <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--color-text-muted)' }}>cost basis</span>
                ) : (
                  <span className="tabular-nums" style={{ minWidth: 70, textAlign: 'center', fontSize: 12, fontWeight: 800, color: '#fff', padding: '3.5px 8px', borderRadius: 8, background: up ? '#059669' : '#e11d48' }}>
                    {up ? '+' : '−'}{Math.abs(dayPct).toFixed(2)}%
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── ETF / stock split donut with Split ⇄ Holdings toggle ────────────────────

const CIRC = 2 * Math.PI * 60;

export function InvestSplitDonut({ portfolio, currencySymbol }) {
  const [view, setView] = useState('type');
  const { positions, total, etfPct, stockPct } = portfolio;
  if (!(total > 0)) return null;

  let segments, legend, label;
  if (view === 'type') {
    label = 'ETF vs stock';
    segments = [etfPct, stockPct, 0, 0, 0, 0];
    legend = [
      { name: 'ETFs', pct: etfPct, color: CHART_COLORS[0] },
      { name: 'Single stocks', pct: stockPct, color: CHART_COLORS[1] },
    ];
  } else {
    label = 'by holding';
    const top = positions.slice(0, 4);
    const otherPct = Math.max(0, 100 - top.reduce((s, p) => s + p.weight, 0));
    segments = [...top.map(p => p.weight), positions.length > 4 ? otherPct : 0, 0].slice(0, 6);
    legend = [
      ...top.map((p, i) => ({ name: p.symbol, pct: p.weight, color: CHART_COLORS[i] })),
      ...(positions.length > 4 ? [{ name: 'Other', pct: otherPct, color: OTHER_COLOR }] : []),
    ];
  }
  const colors = [...CHART_COLORS, OTHER_COLOR];

  let acc = 0;
  const circles = segments.map((pct, i) => {
    const frac = (pct || 0) / 100;
    const gap = frac > 0 ? 2 : 0;
    const el = (
      <circle key={i} cx="75" cy="75" r="60" fill="none" strokeWidth="14" stroke={colors[i]}
        style={{
          strokeDasharray: `${Math.max(frac * CIRC - gap, 0)} ${CIRC}`,
          strokeDashoffset: -acc * CIRC,
          transition: 'stroke-dasharray 1.1s cubic-bezier(0.19,1,0.22,1), stroke-dashoffset 1.1s cubic-bezier(0.19,1,0.22,1)',
        }} />
    );
    acc += frac;
    return el;
  });

  return (
    <div className="glass-heavy" style={{ border: '1px solid var(--sur-10)', borderRadius: 26, padding: 18, marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>Fidelity</p>
          <h3 className="tabular-nums" style={{ fontSize: 13, fontWeight: 900, color: 'var(--color-text)' }}>
            {fmtMoney(total, currencySymbol)} in {positions.length} holding{positions.length !== 1 ? 's' : ''}
          </h3>
        </div>
        <div style={{ display: 'flex', gap: 4, background: 'var(--sur-8)', borderRadius: 11, padding: 3 }}>
          {[['type', 'Split'], ['holding', 'Holdings']].map(([v, l]) => (
            <button key={v} onClick={() => setView(v)}
              style={{
                border: 0, font: 'inherit', fontSize: 10.5, fontWeight: 800, padding: '5px 10px',
                borderRadius: 8, cursor: 'pointer', transition: 'background .25s, color .25s',
                background: view === v ? 'var(--color-accent)' : 'transparent',
                color: view === v ? '#fff' : 'var(--color-text-secondary)',
              }}>{l}</button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 150, height: 150, flexShrink: 0, position: 'relative' }}>
          <svg width="150" height="150" viewBox="0 0 150 150" style={{ transform: 'rotate(-90deg)' }} role="img" aria-label={`Allocation ${label}`}>
            {circles}
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <b className="tabular-nums" style={{ fontSize: 16, fontWeight: 900, color: 'var(--color-text)' }}>
              {total >= 1000 ? `${currencySymbol}${(total / 1000).toFixed(1)}k` : fmtMoney(total, currencySymbol)}
            </b>
            <span style={{ fontSize: 9.5, color: 'var(--color-text-muted)', fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</span>
          </div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
          {legend.map(li => (
            <div key={li.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700, color: 'var(--color-text-secondary)' }}>
              <span style={{ width: 10, height: 10, borderRadius: 3.5, flexShrink: 0, background: li.color }} />
              {li.name}
              <b className="tabular-nums" style={{ marginLeft: 'auto', color: 'var(--color-text)', fontWeight: 800 }}>{li.pct.toFixed(1)}%</b>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
