import React, { useState, useMemo, useLayoutEffect, useRef } from 'react';
import { pie, arc } from 'd3-shape';
import { schemeTableau10 } from 'd3-scale-chromatic';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function DonutChart({ expenses, totalActual, currencySymbol, isDark, categoryColors, donutLegendCount }) {
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const [legendMounted, setLegendMounted] = useState(false);

  const chartExpenses = useMemo(
    () => [...expenses].filter(d => d.actual > 0).sort((a, b) => b.actual - a.actual),
    [expenses]
  );

  const dataKey = useMemo(() => chartExpenses.map(e => `${e.name}:${e.actual}`).join(','), [chartExpenses]);

  const getCategoryColor = (name, idx) =>
    categoryColors?.[name] || schemeTableau10[idx % 10];

  const width = 200, height = 200;
  const radius = Math.min(width, height) / 2;
  const pieFn = useMemo(() => pie().value(d => d.actual).sort(null), []);
  const arcFn = useMemo(() => arc().innerRadius(radius * 0.65).outerRadius(radius), [radius]);
  const arcs = useMemo(() => pieFn(chartExpenses), [pieFn, chartExpenses]);

  const pct = hoveredSlice
    ? ((hoveredSlice.actual / totalActual) * 100).toFixed(1)
    : null;

  // ── Imperative arc morphing ─────────────────────────────────────────────────
  const pathRefs    = useRef(new Map()); // name -> SVGPathElement
  const prevArcs    = useRef(new Map()); // name -> { startAngle, endAngle } (settled)
  const currentArcs = useRef(new Map()); // name -> { startAngle, endAngle } (current displayed, updated each tick)
  const tweenId     = useRef(null);
  const arcsRef     = useRef(arcs);
  const arcFnRef    = useRef(arcFn);
  arcsRef.current   = arcs;
  arcFnRef.current  = arcFn;

  useLayoutEffect(() => {
    if (tweenId.current) cancelAnimationFrame(tweenId.current);

    const targetArcs = arcsRef.current;
    const arcFnLocal = arcFnRef.current;

    // Starting arc per slice: prefer current displayed state (mid-tween resume),
    // then previously settled state, then zero-sweep at the new endAngle.
    const startByName = new Map();
    targetArcs.forEach(d => {
      const cur  = currentArcs.current.get(d.data.name);
      const prev = prevArcs.current.get(d.data.name);
      startByName.set(d.data.name, cur || prev || { startAngle: d.endAngle, endAngle: d.endAngle });
    });

    // Snap to starting state synchronously so React's empty d doesn't flash
    targetArcs.forEach(d => {
      const node = pathRefs.current.get(d.data.name);
      if (!node) return;
      const s = startByName.get(d.data.name);
      node.setAttribute('d', arcFnLocal({ ...d, startAngle: s.startAngle, endAngle: s.endAngle }));
      currentArcs.current.set(d.data.name, { startAngle: s.startAngle, endAngle: s.endAngle });
    });

    const finalize = () => {
      prevArcs.current.clear();
      currentArcs.current.clear();
      targetArcs.forEach(d => {
        const final = { startAngle: d.startAngle, endAngle: d.endAngle };
        prevArcs.current.set(d.data.name, final);
        currentArcs.current.set(d.data.name, final);
      });
    };

    if (prefersReducedMotion()) {
      targetArcs.forEach(d => {
        const node = pathRefs.current.get(d.data.name);
        if (node) node.setAttribute('d', arcFnLocal(d));
      });
      finalize();
      return;
    }

    const duration = 700;
    const t0 = performance.now();
    const tick = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 4);
      targetArcs.forEach(d => {
        const node = pathRefs.current.get(d.data.name);
        if (!node) return;
        const s = startByName.get(d.data.name);
        const sa = s.startAngle + (d.startAngle - s.startAngle) * eased;
        const ea = s.endAngle   + (d.endAngle   - s.endAngle)   * eased;
        node.setAttribute('d', arcFnLocal({ ...d, startAngle: sa, endAngle: ea }));
        currentArcs.current.set(d.data.name, { startAngle: sa, endAngle: ea });
      });
      if (p < 1) {
        tweenId.current = requestAnimationFrame(tick);
      } else {
        finalize();
      }
    };
    tweenId.current = requestAnimationFrame(tick);

    return () => {
      if (tweenId.current) cancelAnimationFrame(tweenId.current);
    };
  }, [dataKey]);

  // Legend fades in once after first paint, and on data change
  useLayoutEffect(() => {
    setLegendMounted(false);
    const id = requestAnimationFrame(() => setLegendMounted(true));
    return () => cancelAnimationFrame(id);
  }, [dataKey]);

  return (
    <div className="animate-enter bg-white dark:bg-slate-800 rounded-[1.25rem] shadow-[0_4px_20px_rgb(0,0,0,0.04)] dark:shadow-[0_4px_20px_rgb(0,0,0,0.2)] border border-slate-100 dark:border-slate-700 p-5 sm:p-8">
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-5 sm:mb-8">
        Spending distribution
      </h2>

      <div className="relative flex justify-center items-center py-4">
        <svg width={width} height={height} className="overflow-visible">
          <g transform={`translate(${width / 2}, ${height / 2})`}>
            {arcs.map((d, i) => {
              const isHovered = hoveredSlice?.name === d.data.name;
              const isDimmed  = hoveredSlice && !isHovered;
              return (
                <path
                  ref={(el) => {
                    if (el) pathRefs.current.set(d.data.name, el);
                    else pathRefs.current.delete(d.data.name);
                  }}
                  key={d.data.name}
                  fill={getCategoryColor(d.data.name, i)}
                  stroke={isDark ? '#1e293b' : '#fff'}
                  strokeWidth="2"
                  style={{
                    opacity: isDimmed ? 0.4 : 1,
                    transform: isHovered ? 'scale(1.04)' : 'scale(1)',
                    transformOrigin: 'center',
                    transformBox: 'fill-box',
                    transition: `opacity 200ms ease, transform 250ms var(--ease-out)`,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={() => setHoveredSlice(d.data)}
                  onMouseLeave={() => setHoveredSlice(null)}
                  onClick={() => setHoveredSlice(prev => prev?.name === d.data.name ? null : d.data)}
                />
              );
            })}
          </g>
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          {hoveredSlice ? (
            <div className="animate-fade-in text-center">
              <span className="text-[10px] font-semibold text-slate-400 block truncate max-w-[80px]">{hoveredSlice.name}</span>
              <span className="text-base font-black text-slate-800 dark:text-slate-100 mt-0.5 block tabular-nums">
                {currencySymbol}{hoveredSlice.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
              <span className="text-[10px] font-semibold text-slate-400 block">{pct}%</span>
            </div>
          ) : (
            <div className="text-center">
              <span className="text-[10px] font-semibold text-slate-400 block">Total</span>
              <span className="text-lg font-black text-slate-800 dark:text-slate-100 block tabular-nums">
                {currencySymbol}{totalActual.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-2.5">
        <p className="text-[10px] font-semibold text-slate-400 mb-3">
          Top categories
        </p>
        {chartExpenses.slice(0, donutLegendCount).map((d, i) => (
          <div
            key={d.name}
            className="flex items-center justify-between text-xs"
            style={{
              opacity: legendMounted ? 1 : 0,
              transform: legendMounted ? 'none' : 'translateX(-6px)',
              transition: `opacity var(--dur-normal) var(--ease-out), transform var(--dur-normal) var(--ease-out)`,
              transitionDelay: `${120 + i * 40}ms`,
            }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="w-2.5 h-2.5 rounded-sm flex-shrink-0"
                style={{ backgroundColor: getCategoryColor(d.name, i) }}
              />
              <span className="font-medium text-slate-700 dark:text-slate-300 truncate max-w-[130px]">{d.name}</span>
            </div>
            <span className="font-bold text-slate-900 dark:text-slate-100 ml-2 tabular-nums">
              {currencySymbol}{d.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
