import React, { useState, useEffect, useRef } from 'react';
import { X, RotateCcw, Search, Trash2, Pencil, Check, RefreshCw, Plus, Zap, Keyboard } from 'lucide-react';
import { DEFAULT_SETTINGS } from './useSettings.js';
import { CURRENCIES } from './currency.js';
import { CATEGORIES, getAllCategoryNames } from './sheetsApi.js';
import { newRuleId } from './smartRules.js';
import * as d3 from 'd3';

// ─── Config ───────────────────────────────────────────────────────────────────

const VISIBILITY_ITEMS = [
  { key: 'statCards',      label: 'Summary Cards',         desc: 'The 4 stat cards at the top' },
  { key: 'donutChart',     label: 'Spending Distribution', desc: 'Donut chart with category breakdown' },
  { key: 'barChart',       label: 'Actual vs Budget',      desc: 'Bar chart comparing spend to budget' },
  { key: 'insightCards',   label: 'Insight Cards',         desc: 'Balance without random & budget difference' },
  { key: 'heatmap',        label: 'Spending Calendar',     desc: 'Daily spend intensity heatmap calendar' },
  { key: 'map',            label: 'Spending Map',          desc: 'Map of tagged expense locations (requires geo-tagging)' },
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

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

const SHORTCUT_ACTIONS = [
  { key: 'addExpense',   label: 'Add expense',   desc: 'Open the add expense dialog' },
  { key: 'scanReceipt',  label: 'Scan receipt',  desc: 'Trigger the receipt scanner' },
  { key: 'openSettings', label: 'Open settings', desc: 'Open this settings panel' },
  { key: 'openChat',     label: 'AI agent',      desc: 'Open the AI budget assistant' },
];

function formatCombo(combo) {
  if (!combo) return '—';
  return combo.split('+').map(p => {
    if (p === 'ctrl')  return '⌃';
    if (p === 'shift') return '⇧';
    if (p === 'alt')   return '⌥';
    if (p === 'meta')  return '⌘';
    return p.toUpperCase();
  }).join(' ');
}

function captureCombo(e) {
  const parts = [];
  if (e.ctrlKey)  parts.push('ctrl');
  if (e.altKey)   parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey)  parts.push('meta');
  const key = e.key.toLowerCase();
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) parts.push(key);
  return parts.length > 1 ? parts.join('+') : null; // require at least one modifier
}

function ShortcutRow({ actionKey, label, desc, value, onSave, onReset, defaultValue }) {
  const [listening, setListening] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!listening) return;
    const handler = (e) => {
      e.preventDefault();
      if (e.key === 'Escape') { setListening(false); return; }
      const combo = captureCombo(e);
      if (combo) { onSave(combo); setListening(false); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [listening]);

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5">{desc}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {listening ? (
          <span className="text-xs font-bold text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 px-3 py-1.5 rounded-xl border border-indigo-200 dark:border-indigo-700/40 animate-pulse">
            Press keys… Esc to cancel
          </span>
        ) : (
          <>
            <button
              ref={ref}
              onClick={() => setListening(true)}
              className="text-xs font-black text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 hover:text-indigo-600 dark:hover:text-indigo-400 px-3 py-1.5 rounded-xl border border-slate-200 dark:border-slate-600 transition-colors font-mono tracking-wide"
              title="Click to rebind"
            >
              {formatCombo(value)}
            </button>
            {value !== defaultValue && (
              <button
                onClick={onReset}
                title="Reset to default"
                className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-slate-500 dark:hover:text-slate-400 transition-colors"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SettingsPanel({ settings, updateSettings, expenses, onClose, currencySymbol, pinHash, onSetPin, onClearPin, pushHook }) {
  const allCategories = getAllCategoryNames();
  const vis = settings.visibility;
  const [currencySearch, setCurrencySearch]     = useState('');
  const [editingRecIdx, setEditingRecIdx]       = useState(null);
  const [recDraft, setRecDraft]                 = useState({ category: '', vendor: '', amount: '' });

  // Smart Rules state
  const [editingRuleId, setEditingRuleId]       = useState(null);
  const [ruleDraft, setRuleDraft]               = useState({ pattern: '', category: '' });
  const [addingRule, setAddingRule]             = useState(false);
  const [newRuleDraft, setNewRuleDraft]         = useState({ pattern: '', category: '' });

  const smartRules        = settings.smartRules || [];
  const recurringExpenses = settings.recurringExpenses || [];

  const startEditRec = (i) => {
    const r = recurringExpenses[i];
    setRecDraft({ category: r.category, vendor: r.vendor, amount: String(r.amount) });
    setEditingRecIdx(i);
  };

  const saveEditRec = () => {
    const amt = parseFloat(recDraft.amount);
    if (!recDraft.vendor.trim() || !recDraft.category || isNaN(amt) || amt <= 0) return;
    const updated = recurringExpenses.map((r, i) =>
      i === editingRecIdx ? { category: recDraft.category, vendor: recDraft.vendor.trim(), amount: amt } : r
    );
    updateSettings(prev => ({ ...prev, recurringExpenses: updated }));
    setEditingRecIdx(null);
  };

  const deleteRec = (i) => {
    updateSettings(prev => ({
      ...prev,
      recurringExpenses: (prev.recurringExpenses || []).filter((_, j) => j !== i),
    }));
    if (editingRecIdx === i) setEditingRecIdx(null);
  };

  // Smart Rules helpers
  const saveNewRule = () => {
    const pattern = newRuleDraft.pattern.trim();
    if (!pattern || !newRuleDraft.category) return;
    updateSettings(prev => ({
      ...prev,
      smartRules: [...(prev.smartRules || []), { id: newRuleId(), pattern, category: newRuleDraft.category }],
    }));
    setNewRuleDraft({ pattern: '', category: '' });
    setAddingRule(false);
  };

  const saveEditRule = () => {
    const pattern = ruleDraft.pattern.trim();
    if (!pattern || !ruleDraft.category) return;
    updateSettings(prev => ({
      ...prev,
      smartRules: (prev.smartRules || []).map(r =>
        r.id === editingRuleId ? { ...r, pattern, category: ruleDraft.category } : r
      ),
    }));
    setEditingRuleId(null);
  };

  const deleteRule = (id) =>
    updateSettings(prev => ({
      ...prev,
      smartRules: (prev.smartRules || []).filter(r => r.id !== id),
    }));

  const inputCls = "bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-xl px-3 py-1.5 text-xs outline-none focus:ring-2 focus:ring-indigo-500/30 w-full";

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

          {/* ── Geo-tagging ──────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Location</SectionLabel>
            <div className="space-y-2">
              <Toggle
                on={settings.geoTagEnabled || false}
                onToggle={() => updateSettings(prev => ({ ...prev, geoTagEnabled: !prev.geoTagEnabled }))}
                label="Geo-tag expenses"
                desc="Show a 📍 button when adding expenses to capture approximate location"
              />
              {settings.geoTagEnabled && (
                <Toggle
                  on={settings.geoPrivacyBlur !== false}
                  onToggle={() => updateSettings(prev => ({ ...prev, geoPrivacyBlur: prev.geoPrivacyBlur === false }))}
                  label="Privacy blur"
                  desc="Round coordinates to nearest ~500m to reduce location precision"
                />
              )}
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

          {/* ── Security ────────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Security</SectionLabel>
            <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
              <div className="px-4 py-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-100">App PIN Lock</p>
                  <p className="text-xs text-slate-400 mt-0.5">{pinHash ? 'PIN is set — app locks when backgrounded' : 'Lock the app with a 4-digit PIN'}</p>
                </div>
                {pinHash ? (
                  <button onClick={onClearPin} className="px-3 py-1.5 rounded-xl text-xs font-bold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 transition-colors">
                    Remove PIN
                  </button>
                ) : (
                  <button onClick={onSetPin} className="px-3 py-1.5 rounded-xl text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors">
                    Set PIN
                  </button>
                )}
              </div>
              {pinHash && (
                <div className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Lock timeout</p>
                    <p className="text-xs text-slate-400 mt-0.5">How long before the app re-locks</p>
                  </div>
                  <select
                    value={localStorage.getItem('budget_pin_timeout') || String(10 * 60 * 1000)}
                    onChange={e => localStorage.setItem('budget_pin_timeout', e.target.value)}
                    className="bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 rounded-xl px-3 py-1.5 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer"
                  >
                    <option value={String(2  * 60 * 1000)}>2 minutes</option>
                    <option value={String(5  * 60 * 1000)}>5 minutes</option>
                    <option value={String(10 * 60 * 1000)}>10 minutes</option>
                    <option value={String(30 * 60 * 1000)}>30 minutes</option>
                    <option value={String(60 * 60 * 1000)}>1 hour</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* ── Push Notifications ───────────────────────────────────────── */}
          {pushHook?.supported && (
            <div>
              <SectionLabel>Push Notifications</SectionLabel>
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
                {/* Toggle */}
                <div className="px-4 py-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold text-slate-800 dark:text-slate-100">Daily digest</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {pushHook.permission === 'denied'
                        ? 'Blocked in browser — enable in site settings'
                        : pushHook.subscribed
                          ? 'Sends a daily budget summary to this device'
                          : 'Get a daily budget summary on this device'}
                    </p>
                  </div>
                  <button
                    onClick={() => pushHook.subscribed ? pushHook.unsubscribe() : pushHook.subscribe()}
                    disabled={pushHook.loading || pushHook.permission === 'denied'}
                    className={`relative w-11 h-6 rounded-full transition-colors ${
                      pushHook.subscribed ? 'bg-indigo-600' : 'bg-slate-200 dark:bg-slate-600'
                    } disabled:opacity-40 flex-shrink-0`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${pushHook.subscribed ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>

                {/* Time picker — only when subscribed */}
                {pushHook.subscribed && (
                  <div className="px-4 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Notification time</p>
                      <p className="text-xs text-slate-400 mt-0.5">What time to send the daily digest</p>
                    </div>
                    <select
                      value={settings.pushHour ?? 20}
                      onChange={e => {
                        const h = Number(e.target.value);
                        updateSettings(prev => ({ ...prev, pushHour: h }));
                        pushHook.updatePreferredHour(h);
                      }}
                      className="bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 rounded-xl px-3 py-1.5 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer"
                    >
                      {[18,19,20,21,22].map(h => {
                        const ampm  = h >= 12 ? 'PM' : 'AM';
                        const label = `${h > 12 ? h - 12 : h}:00 ${ampm}`;
                        return <option key={h} value={h}>{label}</option>;
                      })}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Recurring Expenses ───────────────────────────────────────── */}
          <div>
            <SectionLabel>Recurring Expenses</SectionLabel>
            {recurringExpenses.length === 0 ? (
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-6 text-center">
                <p className="text-xs text-slate-400">No recurring expenses set.</p>
                <p className="text-xs text-slate-400 mt-1">Add them via the Add Expense dialog.</p>
              </div>
            ) : (
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
                {recurringExpenses.map((r, i) => (
                  <div key={i} className="px-4 py-3">
                    {editingRecIdx === i ? (
                      /* Edit mode */
                      <div className="space-y-2">
                        <select
                          value={recDraft.category}
                          onChange={e => setRecDraft(d => ({ ...d, category: e.target.value }))}
                          className={inputCls}
                        >
                          <option value="">Category…</option>
                          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input
                          type="text"
                          value={recDraft.vendor}
                          onChange={e => setRecDraft(d => ({ ...d, vendor: e.target.value }))}
                          placeholder="Vendor name"
                          className={inputCls}
                        />
                        <input
                          type="number"
                          step="0.01"
                          value={recDraft.amount}
                          onChange={e => setRecDraft(d => ({ ...d, amount: e.target.value }))}
                          placeholder="Amount"
                          className={inputCls}
                        />
                        <div className="flex gap-2 pt-1">
                          <button
                            onClick={() => setEditingRecIdx(null)}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-slate-500 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={saveEditRec}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1"
                          >
                            <Check className="w-3 h-3" /> Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* View mode */
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-800 dark:text-slate-100 truncate">{r.vendor}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{r.category} · {currencySymbol}{r.amount.toFixed(2)}/mo</p>
                        </div>
                        <button
                          onClick={() => startEditRec(i)}
                          className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteRec(i)}
                          className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Smart Rules ─────────────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>Smart Rules</SectionLabel>
              <button
                onClick={() => { setAddingRule(true); setNewRuleDraft({ pattern: '', category: allCategories[0] || '' }); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors"
              >
                <Plus className="w-3 h-3" /> Add rule
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-3 -mt-2">Auto-fill category when vendor name matches. Most specific rule wins.</p>

            {/* Add new rule form */}
            {addingRule && (
              <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/40 rounded-2xl p-4 mb-3 space-y-3">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">If vendor name contains</label>
                  <input
                    autoFocus
                    type="text"
                    placeholder="e.g. Netflix, Amazon Fresh…"
                    value={newRuleDraft.pattern}
                    onChange={e => setNewRuleDraft(d => ({ ...d, pattern: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && saveNewRule()}
                    className={inputCls}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Then use category</label>
                  <select
                    value={newRuleDraft.category}
                    onChange={e => setNewRuleDraft(d => ({ ...d, category: e.target.value }))}
                    className={inputCls}
                  >
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveNewRule} disabled={!newRuleDraft.pattern.trim() || !newRuleDraft.category}
                    className="flex-1 py-2 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors disabled:opacity-40">
                    Save rule
                  </button>
                  <button onClick={() => setAddingRule(false)}
                    className="flex-1 py-2 rounded-xl text-xs font-bold text-slate-500 dark:text-slate-400 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {smartRules.length === 0 && !addingRule ? (
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl px-4 py-6 text-center">
                <Zap className="w-5 h-5 text-slate-300 dark:text-slate-600 mx-auto mb-2" />
                <p className="text-xs text-slate-400">No rules yet.</p>
                <p className="text-xs text-slate-400 mt-0.5">Rules auto-fill the category when adding or importing expenses.</p>
              </div>
            ) : smartRules.length > 0 && (
              <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
                {smartRules.map(rule => (
                  <div key={rule.id} className="px-4 py-3">
                    {editingRuleId === rule.id ? (
                      <div className="space-y-2">
                        <input type="text" value={ruleDraft.pattern}
                          onChange={e => setRuleDraft(d => ({ ...d, pattern: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && saveEditRule()}
                          className={inputCls} autoFocus placeholder="Vendor contains…" />
                        <select value={ruleDraft.category}
                          onChange={e => setRuleDraft(d => ({ ...d, category: e.target.value }))}
                          className={inputCls}>
                          {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <div className="flex gap-2">
                          <button onClick={saveEditRule}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-colors">
                            Save
                          </button>
                          <button onClick={() => setEditingRuleId(null)}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-slate-500 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 transition-colors">
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-slate-500 dark:text-slate-400">
                            contains <span className="font-black text-slate-700 dark:text-slate-200">"{rule.pattern}"</span>
                          </p>
                          <p className="text-xs text-slate-400">→ <span className="font-bold text-indigo-500">{rule.category}</span></p>
                        </div>
                        <button onClick={() => { setRuleDraft({ pattern: rule.pattern, category: rule.category }); setEditingRuleId(rule.id); }}
                          className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteRule(rule.id)}
                          className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Keyboard Shortcuts ──────────────────────────────────────── */}
          <div>
            <SectionLabel>Keyboard Shortcuts</SectionLabel>
            <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-2xl overflow-hidden divide-y divide-slate-50 dark:divide-slate-700/50">
              {SHORTCUT_ACTIONS.map(({ key, label, desc }) => {
                const current = (settings.keyboardShortcuts || {})[key] || DEFAULT_SETTINGS.keyboardShortcuts[key];
                const defaultVal = DEFAULT_SETTINGS.keyboardShortcuts[key];
                return (
                  <ShortcutRow
                    key={key}
                    actionKey={key}
                    label={label}
                    desc={desc}
                    value={current}
                    defaultValue={defaultVal}
                    onSave={combo => updateSettings(prev => ({
                      ...prev,
                      keyboardShortcuts: { ...(prev.keyboardShortcuts || {}), [key]: combo },
                    }))}
                    onReset={() => updateSettings(prev => ({
                      ...prev,
                      keyboardShortcuts: { ...(prev.keyboardShortcuts || {}), [key]: defaultVal },
                    }))}
                  />
                );
              })}
            </div>
            <p className="text-xs text-slate-400 mt-2 px-1">Click a binding to rebind. Must include at least one modifier key (Ctrl, Alt, Shift).</p>
          </div>

        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 dark:border-slate-700 space-y-2">
          <button
            onClick={() => updateSettings({ ...DEFAULT_SETTINGS })}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset to defaults
          </button>
          <button
            onClick={async () => {
              try {
                const cacheNames = await caches.keys();
                await Promise.all(cacheNames.map(name => caches.delete(name)));
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.all(registrations.map(reg => reg.unregister()));
              } catch { /* ignore if SW not supported */ }
              window.location.reload(true);
            }}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Clear Cache & Refresh
          </button>
          <p className="text-center text-[10px] text-slate-300 dark:text-slate-600 font-mono mt-2">
            v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).replace(',', '')}
          </p>
        </div>

      </div>
    </>
  );
}
