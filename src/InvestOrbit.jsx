import React, { useMemo } from 'react';
import { useCountUp } from './useCountUp.js';

// ════════════════════════════════════════════════════════════════════════════
// InvestOrbit — the portfolio as an orbital system. Net worth at the center,
// HYSAs on the inner ring, the largest equity positions further out. Planet
// diameter is honest to dollar weight (sqrt scale, clamped for legibility);
// ring assignment: ring 1 = savings accounts, ring 2 = top equities, ring 3 =
// the rest (beyond 7 planets total, the tail merges into one "+N" moon).
// Pure CSS rotation (counter-rotated planets stay upright); no WebGL.
// ════════════════════════════════════════════════════════════════════════════

const RINGS = [
  { size: 186, dur: 22 },
  { size: 262, dur: 34 },
  { size: 336, dur: 48 },
];

// Validated categorical palette (dark) as radial gradients for a lit-sphere look.
const SPHERES = [
  ['#8b93f8', '#4f52c9'], // indigo
  ['#f0a03a', '#b36305'], // amber
  ['#1eb8a8', '#0a6e63'], // teal
  ['#f7657f', '#c22b47'], // rose
  ['#2fa3e8', '#026197'], // sky
];
const HYSA_SPHERES = { 'amex-hysa': 0, 'happen-hysa': 2 }; // indigo / teal, matches gauges

function planetSize(value, maxValue) {
  if (!(maxValue > 0) || !(value > 0)) return 22;
  return Math.round(22 + 34 * Math.sqrt(value / maxValue)); // 22–56px
}

/** Distribute n planets around a ring at fixed angles (deg) with a stagger. */
function angles(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => offset + (360 / Math.max(n, 1)) * i);
}

function Planet({ label, value, size, sphere, angle, ringSize, dur, reverse }) {
  const r = ringSize / 2;
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad) * r - size / 2;
  const y = Math.sin(rad) * r - size / 2;
  const [hi, lo] = SPHERES[sphere % SPHERES.length];
  return (
    <div
      className={reverse ? 'invest-spin' : 'invest-spin-rev'}
      title={`${label} · $${Math.round(value).toLocaleString()}`}
      style={{
        '--orbit-dur': `${dur}s`,
        position: 'absolute', left: x, top: y,
        width: size, height: size, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: Math.max(7.5, Math.min(10, size / 4.6)),
        fontWeight: 900, color: '#fff', letterSpacing: '0.02em',
        background: `radial-gradient(circle at 32% 28%, ${hi}, ${lo})`,
        boxShadow: 'inset -4px -6px 12px rgba(0,0,0,.45), 0 6px 18px rgba(0,0,0,.5)',
      }}
    >
      {label}
    </div>
  );
}

export function InvestOrbit({ hysaAccounts, positions, totalInvested, dayChange, savingsPct, currencySymbol = '$' }) {
  const animatedTotal = useCountUp(totalInvested, 1200);

  const ringPlanets = useMemo(() => {
    const all = [
      ...positions.map((p, i) => ({
        label: p.symbol, value: p.value, sphere: i % SPHERES.length, kind: 'equity',
      })),
    ].sort((a, b) => b.value - a.value);

    const ring1 = hysaAccounts.map((a, i) => ({
      label: a.name.split(' ')[0].toUpperCase(),
      value: a.balance,
      sphere: HYSA_SPHERES[a.id] ?? (i * 2) % SPHERES.length,
    }));
    const ring2 = all.slice(0, 3);
    const rest = all.slice(3);
    const ring3 = rest.slice(0, 3);
    if (rest.length > 3) {
      ring3.push({
        label: `+${rest.length - 3}`,
        value: rest.slice(3).reduce((s, p) => s + p.value, 0),
        sphere: 4,
      });
    }
    const maxValue = Math.max(1, ...ring1.map(p => p.value), ...all.map(p => p.value));
    return { ring1, ring2, ring3, maxValue };
  }, [hysaAccounts, positions]);

  const { ring1, ring2, ring3, maxValue } = ringPlanets;
  const rings = [ring1, ring2, ring3];

  return (
    <div>
      <div style={{ position: 'relative', height: 320, margin: '6px 0 0', perspective: 900 }} aria-hidden="true">
        <div style={{ position: 'absolute', inset: 0, transform: 'rotateX(18deg)', transformStyle: 'preserve-3d' }}>
          {RINGS.map((ring, i) => (
            <div key={i} style={{
              position: 'absolute', top: '50%', left: '50%',
              width: ring.size, height: ring.size, borderRadius: '50%',
              border: '1px dashed var(--sur-15)',
              transform: 'translate(-50%,-50%)',
            }} />
          ))}

          {/* Center: total invested */}
          <div style={{
            position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
            width: 116, height: 116, borderRadius: '50%',
            background: 'radial-gradient(circle at 34% 30%, var(--sur-12), var(--color-surface) 68%)',
            border: '1px solid var(--sur-20)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 46px oklch(65% 0.18 var(--accent-hue) / 28%), inset 0 0 24px oklch(65% 0.18 var(--accent-hue) / 14%)',
          }}>
            <b className="tabular-nums" style={{ fontSize: 16.5, fontWeight: 900, color: 'var(--color-text)' }}>
              {currencySymbol}{Math.round(animatedTotal).toLocaleString()}
            </b>
            <span style={{
              fontSize: 8.5, fontWeight: 800, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: 'var(--color-text-muted)', marginTop: 2,
            }}>invested</span>
          </div>

          {/* Orbiting planets */}
          {rings.map((planets, ringIdx) => (
            <div
              key={ringIdx}
              className={ringIdx % 2 === 1 ? 'invest-spin-rev' : 'invest-spin'}
              style={{
                '--orbit-dur': `${RINGS[ringIdx].dur}s`,
                position: 'absolute', top: '50%', left: '50%', transformStyle: 'preserve-3d',
              }}
            >
              {planets.map((p, i) => (
                <Planet
                  key={p.label + i}
                  {...p}
                  size={planetSize(p.value, maxValue)}
                  angle={angles(planets.length, ringIdx * 47)[i]}
                  ringSize={RINGS[ringIdx].size}
                  dur={RINGS[ringIdx].dur}
                  reverse={ringIdx % 2 === 1}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="tabular-nums" style={{
        textAlign: 'center', fontSize: 11, color: 'var(--color-text-muted)',
        fontWeight: 600, margin: '24px 0 4px', position: 'relative', zIndex: 3,
      }}>
        <span style={{ color: dayChange >= 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {dayChange >= 0 ? '▲' : '▼'} {currencySymbol}{Math.abs(dayChange).toFixed(0)} today
        </span>
        {' · '}savings {Math.round(savingsPct)}% · equities {Math.round(100 - savingsPct)}%
      </p>
    </div>
  );
}
