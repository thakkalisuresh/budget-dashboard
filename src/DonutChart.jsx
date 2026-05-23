import React, { useState, useMemo, useEffect, useRef } from 'react';
import { pie, arc } from 'd3-shape';
import { schemeTableau10 } from 'd3-scale-chromatic';

export function DonutChart({ expenses, totalActual, currencySymbol, isDark, categoryColors, donutLegendCount }) {
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Re-trigger entrance when data key changes (month switch)
  const dataKey = useMemo(() => expenses.map(e => e.actual).join(','), [expenses]);
  const prevKey = useRef(dataKey);
  useEffect(() => {
    if (prevKey.current === dataKey) return;
    prevKey.current = dataKey;
    setMounted(false);
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [dataKey]);

  const chartExpenses = useMemo(
    () => [...expenses].filter(d => d.actual > 0).sort((a, b) => b.actual - a.actual),
    [expenses]
  );

  const getCategoryColor = (name, idx) =>
    categoryColors?.[name] || schemeTableau10[idx % 10];

  const width = 200, height = 200;
  const radius = Math.min(width, height) / 2;
  const pieFn    = pie().value(d => d.actual).sort(null);
  const arcFn    = arc().innerRadius(radius * 0.65).outerRadius(radius);
  const arcHover = arc().innerRadius(radius * 0.62).outerRadius(radius * 1.05);
  const arcs = pieFn(chartExpenses);
  const pct = hoveredSlice
    ? ((hoveredSlice.actual / totalActual) * 100).toFixed(1)
    : null;

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
              return (
                <path
                  key={`${d.data.name}-${i}`}
                  d={isHovered ? arcHover(d) : arcFn(d)}
                  fill={getCategoryColor(d.data.name, i)}
                  stroke={isDark ? '#1e293b' : '#fff'}
                  strokeWidth="2"
                  style={{
                    opacity: mounted ? (hoveredSlice && !isHovered ? 0.4 : 1) : 0,
                    transform: mounted ? 'scale(1)' : 'scale(0.85)',
                    transformOrigin: 'center',
                    transformBox: 'fill-box',
                    transition: `opacity 200ms ease, transform ${250 + i * 25}ms var(--ease-out)`,
                    transitionDelay: mounted ? `${i * 30}ms` : '0ms',
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
            key={i}
            className="flex items-center justify-between text-xs"
            style={{
              opacity: mounted ? 1 : 0,
              transform: mounted ? 'none' : 'translateX(-6px)',
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
