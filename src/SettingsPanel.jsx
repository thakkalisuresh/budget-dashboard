import React, { useState } from 'react';
import { X, RotateCcw, Search } from 'lucide-react';
import { DEFAULT_SETTINGS } from './useSettings.js';
import { CURRENCIES } from './currency.js';
import * as d3 from 'd3';

// ─── Config ───────────────────────────────────────────────────────────────────

const VISIBILITY_ITEMS = [
  { key: 'statCards',      label: 'Summary Cards',         desc: 'The 4 stat cards at the top' },
  { key: 'donutChart',     label: 'Spending Distribution', desc: 'Donut chart with category breakdown' },
  { key: 'barChart',       label: 'Actual vs Budget',      desc: 'Bar chart comparing spend to budget' },
  { key: 'insightCards',   label: 'Insight Cards',         desc: 'Balance without random & budget difference' },
  { key: 'nonMonthlyTile', label: 'Non-Monthly Expenses',  desc: 'Random non-monthly expenses note' },
  { key: 'budgetRules',    label: '50/30/20 Rules',        desc: 'Budget rule breakdown section' },
];

const BAR_SORT_OPTIONS = [
  { value: 'amount',    label: 'By amount spent' },
  { value: 'name',      label: 'Alphabetical' },
  { value: 'remaining', label: 'By remaining budget' },
];

const LEGEND_COUNT_OPTIONS = [3, 5, 10];

const COLOR_SCHEMES = [
  { value: 'default', label: 'Indigo',   primary: '#6366f1' },
  { value: 'rose',    label: 'Rose',     primary: '#f43f5e' },
  { value: 'emerald', label: 'Emerald',  primary: '#10b981' },
  { value: 'amber',   label: 'Amber',    primary: '#f59e0b' },
  { value: 'sky',     label: 'Sky',      primary: '#0ea5e9' },
  { value: 'violet',  label: 'Violet',   primary: '#8b5cf6' },
];

const FONT_SIZE_OPTIONS = [
  { value: 'sm',      label: 'Small' },
  { value: 'base',    label: 'Default' },
  { value: 'lg',      label: 'Large' },
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <h3 className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400 mb-3">
      {children}
    </h3>
  );
}

function Toggle({ on, onToggle, label, desc }) {
  return (
    <button
      onClick={onToggle}
      className={`w-full flex items-center justify-between gap-3 px-4 py-3.5 rounded-2xl border transition-all text-left ${
        on
          ? 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-600'
          : 'bg-slate-50 dark:bg-slate-800/40 border-slate-100 dark:border-slate-700/50 opacity-55'
      }`}
    >
      <div className="min-w-0">
        <p className={`text-sm font-bold truncate ${on ? 'text-slate-800 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500'}`}>
          {label}
        </p>
        <p className="text-xs text-slate-400 mt-0.5 truncate">{desc}</p>
      </div>
      {/* Pill toggle */}
      <div className={`flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200 ${on ? 'bg-indigo-500' : 'bg-slate-200 dark:bg-slate-600'}`}>
        <div className={`w-4 h-4 bg-white rounded-full mt-1 shadow-sm transition-transform duration-200 ${on ? 'translate-x-5' : 'translate-x-1'}`} />
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SettingsPanel({ settings, updateSettings, expenses, onClose, currencySymbol }) {
  const vis = settings.visibility;
  const [currencySearch, setCurrencySearch] = useState('');

  const toggleVis = (key) =>
    updateSettings(prev => ({
      ...prev,
      visibility: { ...prev.visibility, [key]: !prev.visibility[key] },
    }));

  const getCategoryColor = (name, idx) =>
    settings.categoryColors?.[name] || d3.schemeTableau10[idx % 10];

  const updateCategoryColor = (name, color) =>
    updateSettings(prev => ({
      ...prev,
      categoryColors: { ...prev.categoryColors, [name]: color },
    }));

  const chartExpenses = (expenses || [])
    .filter(e => e.actual > 0)
    .sort((a, b) => b.actual - a.actual);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/30 dark:bg-black/50 z-40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 w-[85vw] max-w-sm bg-white dark:bg-slate-900 shadow-2xl flex flex-col border-l border-slate-100 dark:border-slate-700"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
          <div>
            <h2 className="text-base font-black text-slate-800 dark:text-slate-100">Customize Dashboard</h2>
            <p className="text-xs text-slate-400 mt-0.5">Saved to your account automatically</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">

            {/* ── Currency ────────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Currency</SectionLabel>
            <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden">
              {/* Selected currency display */}
              <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 flex items-center gap-3">
                <span className="text-xl">{CURRENCIES.find(c => c.code === (settings.currency || 'USD'))?.flag}</span>
                <div>
                  <p className="text-sm font-black text-slate-800 dark:text-slate-100">
                    {CURRENCIES.find(c => c.code === (settings.currency || 'USD'))?.label}
                  </p>
                  <p className="text-xs text-slate-400">
                    {settings.currency || 'USD'} · {CURRENCIES.find(c => c.code === (settings.currency || 'USD'))?.symbol}
                  </p>
                </div>
              </div>

              {/* Search */}
              <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-700">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search currency…"
                    value={currencySearch}
                    onChange={e => setCurrencySearch(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-slate-700/60 rounded-xl pl-8 pr-3 py-2 text-xs outline-none focus:ring-2 focus:ring-indigo-500/30 text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
                  />
                </div>
              </div>

              {/* Currency list */}
              <div className="max-h-48 overflow-y-auto divide-y divide-slate-50 dark:divide-slate-700/40">
                {CURRENCIES
                  .filter(c => {
                    const q = currencySearch.toLowerCase();
                    return !q || c.label.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || c.symbol.includes(q);
                  })
                  .map(c => {
                    const selected = (settings.currency || 'USD') === c.code;
                    return (
                      <button
                        key={c.code}
                        onClick={() => updateSettings(prev => ({ ...prev, currency: c.code }))}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                          selected
                            ? 'bg-indigo-50 dark:bg-indigo-900/30'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-700/30'
                        }`}
                      >
                        <span className="text-base w-6 flex-shrink-0">{c.flag}</span>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs font-bold truncate ${selected ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-700 dark:text-slate-200'}`}>
                            {c.label}
                          </p>
                          <p className="text-[10px] text-slate-400">{c.code}</p>
                        </div>
                        <span className={`text-sm font-black flex-shrink-0 ${selected ? 'text-indigo-600 dark:text-indigo-400' : 'text-slate-400'}`}>
                          {c.symbol}
                        </span>
                        {selected && (
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 flex-shrink-0" />
                        )}
                      </button>
                    );
                  })}
              </div>
            </div>
          </div>

          {/* ── Appearance ──────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Appearance</SectionLabel>
            <div className="space-y-4">

              {/* Theme */}
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-4">
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3">Default theme</p>
                <div className="flex gap-2">
                  {[
                    { value: 'dark',   label: '🌙 Dark'  },
                    { value: 'light',  label: '☀️ Light' },
                    { value: 'system', label: '💻 System' },
                  ].map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, theme: value }))}
                      className={`flex-1 py-2 rounded-xl text-xs font-black transition-all ${
                        settings.theme === value
                          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Color scheme */}
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-4">
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3">Accent color</p>
                <div className="flex gap-2 flex-wrap">
                  {COLOR_SCHEMES.map(({ value, label, primary }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, colorScheme: value }))}
                      title={label}
                      className={`w-8 h-8 rounded-full transition-all ring-offset-2 dark:ring-offset-slate-800 ${
                        settings.colorScheme === value
                          ? 'ring-2 ring-offset-2 scale-110'
                          : 'hover:scale-105 opacity-70 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: primary,
                        ringColor: primary,
                      }}
                    />
                  ))}
                </div>
                <p className="text-xs text-slate-400 mt-2">
                  {COLOR_SCHEMES.find(c => c.value === settings.colorScheme)?.label || 'Indigo'} selected
                </p>
              </div>

              {/* Font size */}
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-4">
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3">Font size</p>
                <div className="flex gap-2">
                  {FONT_SIZE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, fontSize: value }))}
                      className={`flex-1 py-2 rounded-xl text-xs font-black transition-all ${
                        settings.fontSize === value
                          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

            </div>
          </div>

          {/* ── Dashboard sections ───────────────────────────────────────── */}
          <div>
            <SectionLabel>Dashboard Sections</SectionLabel>
            <div className="space-y-2">
              {VISIBILITY_ITEMS.map(({ key, label, desc }) => (
                <Toggle
                  key={key}
                  on={vis[key]}
                  onToggle={() => toggleVis(key)}
                  label={label}
                  desc={desc}
                />
              ))}
            </div>
          </div>

          {/* ── Chart preferences ────────────────────────────────────────── */}
          <div>
            <SectionLabel>Chart Preferences</SectionLabel>
            <div className="space-y-4">

              {/* Donut legend count */}
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-4">
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3">Distribution legend items</p>
                <div className="flex gap-2">
                  {LEGEND_COUNT_OPTIONS.map(n => (
                    <button
                      key={n}
                      onClick={() => updateSettings(prev => ({ ...prev, donutLegendCount: n }))}
                      className={`flex-1 py-2 rounded-xl text-xs font-black transition-all ${
                        settings.donutLegendCount === n
                          ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30'
                          : 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'
                      }`}
                    >
                      {n === 10 ? 'All' : `Top ${n}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bar chart sort */}
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-4">
                <p className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3">Bar chart sort order</p>
                <div className="space-y-1">
                  {BAR_SORT_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, barSortOrder: value }))}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left ${
                        settings.barSortOrder === value
                          ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400'
                          : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50'
                      }`}
                    >
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-colors ${
                        settings.barSortOrder === value
                          ? 'border-indigo-500 bg-indigo-500'
                          : 'border-slate-300 dark:border-slate-500'
                      }`} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* ── Category colors ──────────────────────────────────────────── */}
          {chartExpenses.length > 0 && (
            <div>
              <SectionLabel>Category Colors</SectionLabel>
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
                {chartExpenses.map((exp, i) => (
                  <label
                    key={exp.name}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors group"
                  >
                    <div
                      className="w-5 h-5 rounded-md flex-shrink-0 ring-1 ring-black/10 group-hover:scale-110 transition-transform"
                      style={{ backgroundColor: getCategoryColor(exp.name, i) }}
                    />
                    <span className="flex-1 text-sm font-bold text-slate-700 dark:text-slate-200 truncate">
                      {exp.name}
                    </span>
                    <span className="text-xs text-slate-400 tabular-nums">
                      {currencySymbol}{exp.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-[10px] text-slate-300 dark:text-slate-600 group-hover:text-slate-400 transition-colors">
                      Edit ›
                    </span>
                    <input
                      type="color"
                      className="sr-only"
                      value={getCategoryColor(exp.name, i)}
                      onChange={e => updateCategoryColor(exp.name, e.target.value)}
                    />
                  </label>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 dark:border-slate-700">
          <button
            onClick={() => updateSettings({ ...DEFAULT_SETTINGS })}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to defaults
          </button>
        </div>

      </div>
    </>
  );
}
