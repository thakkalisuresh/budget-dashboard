import React, { useState, useMemo } from 'react';
import * as d3 from 'd3';
import { PieChart as PieChartIcon } from 'lucide-react';

export function DonutChart({ expenses, totalActual, currencySymbol, isDark, categoryColors, donutLegendCount }) {
  const [hoveredSlice, setHoveredSlice] = useState(null);

  const chartExpenses = useMemo(
    () => [...expenses].filter(d => d.actual > 0).sort((a, b) => b.actual - a.actual),
    [expenses]
  );

  const getCategoryColor = (name, idx) =>
    categoryColors?.[name] || d3.schemeTableau10[idx % 10];

  const width = 200, height = 200;
  const radius = Math.min(width, height) / 2;
  const pie = d3.pie().value(d => d.actual).sort(null);
  const arc      = d3.arc().innerRadius(radius * 0.65).outerRadius(radius);
  const arcHover = d3.arc().innerRadius(radius * 0.62).outerRadius(radius * 1.05);
  const arcs = pie(chartExpenses);
  const pct = hoveredSlice
    ? ((hoveredSlice.actual / totalActual) * 100).toFixed(1)
    : null;

  return (
    <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] border border-slate-100 dark:border-slate-700 p-5 sm:p-8">
      <h2 className="text-sm font-black flex items-center gap-2 mb-5 sm:mb-8 text-slate-800 dark:text-slate-100 uppercase tracking-widest">
        <PieChartIcon className="w-4 h-4 text-indigo-500" /> Distribution
      </h2>

      <div className="relative flex justify-center items-center py-4">
        <svg width={width} height={height} className="overflow-visible">
          <g transform={`translate(${width / 2}, ${height / 2})`}>
            {arcs.map((d, i) => {
              const isHovered = hoveredSlice?.name === d.data.name;
              return (
                <path
                  key={i}
                  d={isHovered ? arcHover(d) : arc(d)}
                  fill={getCategoryColor(d.data.name, i)}
                  stroke={isDark ? '#1e293b' : '#fff'}
                  strokeWidth="2"
                  className="cursor-pointer transition-all duration-200"
                  style={{ opacity: hoveredSlice && !isHovered ? 0.45 : 1 }}
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
            <>
              <span className="text-[9px] uppercase tracking-widest text-slate-400 font-bold text-center leading-tight max-w-[80px] truncate">{hoveredSlice.name}</span>
              <span className="text-base font-black text-slate-800 dark:text-slate-100 mt-0.5">{currencySymbol}{hoveredSlice.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              <span className="text-[10px] font-bold text-slate-400">{pct}%</span>
            </>
          ) : (
            <>
              <span className="text-[10px] uppercase tracking-widest text-slate-400 font-bold">Total</span>
              <span className="text-lg font-black text-slate-800 dark:text-slate-100">{currencySymbol}{totalActual.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-3">
        <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">
          Top categories · <span className="text-indigo-400">customise in settings</span>
        </p>
        {chartExpenses.slice(0, donutLegendCount).map((d, i) => (
          <div key={i} className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-sm flex-shrink-0 ring-1 ring-black/10" style={{ backgroundColor: getCategoryColor(d.name, i) }} />
              <span className="font-bold text-slate-800 dark:text-slate-200 truncate max-w-[130px]">{d.name}</span>
            </div>
            <span className="font-black text-slate-900 dark:text-slate-100 ml-2">{currencySymbol}{d.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
