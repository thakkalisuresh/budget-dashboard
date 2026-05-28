import React, { useState, useEffect, useMemo, useRef } from 'react';
import { getAllCategoryNames, fetchDetailRows } from './sheetsApi.js';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function parseMonthLabel(label) {
  if (!label) return null;
  const m = label.match(/(\w+)\s+(\d{4})/);
  if (!m) return null;
  const idx = MONTH_NAMES.findIndex(mo => mo.toLowerCase() === m[1].toLowerCase());
  if (idx === -1) return null;
  return { year: parseInt(m[2]), month: idx };
}

async function fetchDailyTotals(sheetId, accessToken, year, month) {
  const categories = getAllCategoryNames();
  const dailyMap = {};
  await Promise.all(
    categories.map(async (cat) => {
      try {
        const rows = await fetchDetailRows(cat, accessToken, sheetId);
        rows.forEach(row => {
          if (!row.date) return;
          const [y, mo] = row.date.split('-').map(Number);
          if (y !== year || mo - 1 !== month) return;
          const sum = (row.amounts || []).reduce((a, b) => a + b, 0);
          dailyMap[row.date] = (dailyMap[row.date] || 0) + sum;
        });
      } catch { /* skip failed categories */ }
    })
  );
  return dailyMap;
}

function buildCalendar(year, month) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const mo = String(month + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    cells.push(`${year}-${mo}-${dd}`);
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// 5-level color buckets — light and dark mode variants
function cellColor(amount, maxAmount, isDark) {
  if (!amount || amount === 0) {
    return isDark ? '#1e293b' : '#f1f5f9'; // slate-800 / slate-100
  }
  const t = Math.min(amount / maxAmount, 1);
  // Light mode: slate-100 → emerald steps
  // Dark mode:  slate-800 → emerald steps (brighter)
  if (isDark) {
    if (t < 0.25) return '#064e3b'; // emerald-900
    if (t < 0.5)  return '#065f46'; // emerald-800
    if (t < 0.75) return '#059669'; // emerald-600
    return '#34d399';               // emerald-400
  } else {
    if (t < 0.25) return '#d1fae5'; // emerald-100
    if (t < 0.5)  return '#6ee7b7'; // emerald-300
    if (t < 0.75) return '#10b981'; // emerald-500
    return '#065f46';               // emerald-800
  }
}

export function SpendingHeatmap({ sheetId, accessToken, currencySymbol = '$', monthName = '', isDark = false }) {
  const base = useMemo(() => parseMonthLabel(monthName), [monthName]);
  const [offset, setOffset] = useState(0);
  const [cache, setCache] = useState({});
  const [loading, setLoading] = useState(false);
  const [tooltip, setTooltip] = useState(null); // { dateKey, x, y }
  const containerRef = useRef(null);

  const target = useMemo(() => {
    if (!base) return null;
    let m = base.month + offset;
    let y = base.year;
    while (m < 0)  { m += 12; y--; }
    while (m > 11) { m -= 12; y++; }
    return { year: y, month: m };
  }, [base, offset]);

  const cacheKey = target ? `${sheetId}_${target.year}_${target.month}` : null;

  useEffect(() => {
    if (!target || !cacheKey || cache[cacheKey] !== undefined) return;
    let cancelled = false;
    setLoading(true);
    fetchDailyTotals(sheetId, accessToken, target.year, target.month)
      .then(data => { if (!cancelled) setCache(prev => ({ ...prev, [cacheKey]: data })); })
      .catch(() => { if (!cancelled) setCache(prev => ({ ...prev, [cacheKey]: {} })); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cacheKey, sheetId, accessToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const dailyTotals = cache[cacheKey] || {};
  const cells = useMemo(() => target ? buildCalendar(target.year, target.month) : [], [target]);
  const maxAmount = useMemo(
    () => Math.max(1, ...Object.values(dailyTotals)),
    [dailyTotals]
  );

  const CELL = 30;
  const GAP = 4;
  const numWeeks = cells.length / 7;
  const svgW = 7 * CELL + 6 * GAP;
  const svgH = numWeeks * CELL + (numWeeks - 1) * GAP;

  const labelMonth = target
    ? `${MONTH_NAMES[target.month]} ${target.year}`
    : monthName;

  function handleMouseEnter(e, dateKey) {
    if (!dateKey) return;
    const rect = containerRef.current?.getBoundingClientRect();
    const cellRect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      dateKey,
      x: cellRect.left - (rect?.left ?? 0) + CELL / 2,
      y: cellRect.top  - (rect?.top  ?? 0) - 8,
    });
  }

  const tooltipAmount = tooltip ? (dailyTotals[tooltip.dateKey] || 0) : 0;
  const tooltipDate   = tooltip
    ? new Date(tooltip.dateKey + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : '';
  const tooltipTxCount = tooltip
    ? Object.entries(dailyTotals).filter(([k]) => k === tooltip.dateKey).length
    : 0;

  if (!base) return null;

  return (
    <div
      className="bg-white dark:bg-slate-900 rounded-[1.25rem] border border-slate-100 dark:border-slate-800 p-5 sm:p-6 space-y-4"
      ref={containerRef}
      onMouseLeave={() => setTooltip(null)}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-black text-slate-700 dark:text-slate-300 uppercase tracking-wide">
          Spending Calendar
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOffset(o => o - 1)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs font-bold text-slate-500 dark:text-slate-400 min-w-[96px] text-center">
            {labelMonth}
          </span>
          <button
            onClick={() => setOffset(o => o + 1)}
            disabled={offset >= 0}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Day-of-week labels */}
      <div
        className="grid text-center"
        style={{ gridTemplateColumns: `repeat(7, ${CELL}px)`, gap: GAP }}
      >
        {DAY_LABELS.map(d => (
          <div key={d} className="text-[10px] font-bold text-slate-400 dark:text-slate-600">{d}</div>
        ))}
      </div>

      {/* Grid */}
      <div className="relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60 dark:bg-slate-900/60 rounded-xl z-10">
            <div className="w-5 h-5 border-2 border-slate-300 dark:border-slate-600 border-t-emerald-500 rounded-full animate-spin" />
          </div>
        )}
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(7, ${CELL}px)`, gap: GAP }}
        >
          {cells.map((dateKey, i) => {
            const amount = dateKey ? (dailyTotals[dateKey] || 0) : null;
            const color  = dateKey ? cellColor(amount, maxAmount, isDark) : 'transparent';
            const isToday = dateKey === new Date().toISOString().slice(0, 10);
            return (
              <div
                key={i}
                style={{
                  width: CELL,
                  height: CELL,
                  backgroundColor: color,
                  outline: isToday ? '2px solid #10b981' : undefined,
                  outlineOffset: isToday ? '-2px' : undefined,
                }}
                className={`rounded-md transition-opacity ${dateKey ? 'cursor-pointer hover:opacity-75' : ''}`}
                onMouseEnter={dateKey ? (e) => handleMouseEnter(e, dateKey) : undefined}
              />
            );
          })}
        </div>

        {/* Tooltip */}
        {tooltip && (
          <div
            className="absolute z-20 pointer-events-none -translate-x-1/2 -translate-y-full"
            style={{ left: tooltip.x, top: tooltip.y }}
          >
            <div className="bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-bold px-2.5 py-1.5 rounded-lg shadow-lg whitespace-nowrap">
              {tooltipDate}
              {tooltipAmount > 0
                ? ` · ${currencySymbol}${tooltipAmount.toFixed(2)}`
                : ' · No spend'}
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 pt-1">
        <span className="text-[10px] text-slate-400 dark:text-slate-600 font-semibold">Less</span>
        {[0, 0.2, 0.5, 0.75, 1].map((t, i) => (
          <div
            key={i}
            className="w-3.5 h-3.5 rounded-sm"
            style={{ backgroundColor: cellColor(t === 0 ? 0 : t * maxAmount, maxAmount, isDark) }}
          />
        ))}
        <span className="text-[10px] text-slate-400 dark:text-slate-600 font-semibold">More</span>
      </div>
    </div>
  );
}
