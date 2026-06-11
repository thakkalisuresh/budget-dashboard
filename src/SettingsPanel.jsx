import React, { useState, useEffect, useRef } from 'react';
import { X, RotateCcw, Search, Trash2, Pencil, Check, RefreshCw, Plus, Zap, Keyboard, CreditCard, ChevronDown, ChevronRight } from 'lucide-react';
import { DEFAULT_SETTINGS } from './useSettings.js';
import { CARD_REWARDS, getEffectiveRates } from './cardRewards.js';
import { CURRENCIES } from './currency.js';
import { CATEGORIES, getAllCategoryNames } from './sheetsApi.js';
import { newRuleId } from './smartRules.js';
import { schemeTableau10 } from 'd3-scale-chromatic';

// ─── Config ───────────────────────────────────────────────────────────────────

const deepCopy = v => JSON.parse(JSON.stringify(v));

// Defines editable rows for each reward card. readFn reads the current value
// from a card cfg; writeFn returns an updated cfg deep copy with the new value.
const REWARD_RATE_DEFS = {
  'Chase Sapphire Reserve': [
    {
      label: 'Dining', unit: 'x UR',
      readFn: cfg => cfg.mccs?.['5812'] ?? cfg.default,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); ['5812','5813','5814'].forEach(k => { c.mccs[k] = v; }); return c; },
    },
    {
      label: 'Airlines / Hotels — Chase portal', unit: 'x UR',
      readFn: cfg => cfg.mccs?.['4511']?.portal ?? 8,
      writeFn: (cfg, v) => {
        const c = deepCopy(cfg);
        c.mccs['4511'] = { portal: v, direct: cfg.mccs?.['4511']?.direct ?? 4 };
        c.mccs['7011'] = { portal: v, direct: cfg.mccs?.['7011']?.direct ?? 4 };
        c.mccs['CHASE_PORTAL'] = v;
        return c;
      },
    },
    {
      label: 'Airlines / Hotels — direct booking', unit: 'x UR',
      readFn: cfg => cfg.mccs?.['4511']?.direct ?? 4,
      writeFn: (cfg, v) => {
        const c = deepCopy(cfg);
        c.mccs['4511'] = { portal: cfg.mccs?.['4511']?.portal ?? 8, direct: v };
        c.mccs['7011'] = { portal: cfg.mccs?.['7011']?.portal ?? 8, direct: v };
        return c;
      },
    },
    {
      label: 'Everything else', unit: 'x UR',
      readFn: cfg => cfg.default ?? 1,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); c.default = v; return c; },
    },
  ],
  'American Express Blue Cash Preferred': [
    {
      label: 'US Supermarkets', unit: '% cash back',
      hint: '$6,000/yr cap, then 1%',
      readFn: cfg => cfg.mccs?.['5411']?.rate ?? 6,
      writeFn: (cfg, v) => {
        const c = deepCopy(cfg);
        const cap = cfg.mccs?.['5411']?.cap || { annual: 6000, then: 1 };
        c.mccs['5411'] = { rate: v, cap };
        c.mccs['5422'] = { rate: v, cap };
        return c;
      },
    },
    {
      label: 'Streaming', unit: '% cash back',
      readFn: cfg => cfg.mccs?.['7372'] ?? 6,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); c.mccs['7372'] = v; return c; },
    },
    {
      label: 'Gas stations', unit: '% cash back',
      readFn: cfg => cfg.mccs?.['5541'] ?? 3,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); ['5541','5542'].forEach(k => { c.mccs[k] = v; }); return c; },
    },
    {
      label: 'Transit & rideshare', unit: '% cash back',
      readFn: cfg => cfg.mccs?.['4121'] ?? 3,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); ['4121','4111','4131','4784','7523'].forEach(k => { c.mccs[k] = v; }); return c; },
    },
    {
      label: 'Everything else', unit: '% cash back',
      readFn: cfg => cfg.default ?? 1,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); c.default = v; return c; },
    },
  ],
  'Capital One Quicksilver': [
    {
      label: 'Everything', unit: '% cash back',
      readFn: cfg => cfg.default ?? 1.5,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); c.default = v; return c; },
    },
  ],
  'Chase Freedom Unlimited': [
    {
      label: 'Dining & Drugstores', unit: 'x UR',
      readFn: cfg => cfg.mccs?.['5812'] ?? 3,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); ['5812','5813','5814','5912'].forEach(k => { c.mccs[k] = v; }); return c; },
    },
    {
      label: 'Everything else', unit: 'x UR',
      readFn: cfg => cfg.default ?? 1.5,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); c.default = v; return c; },
    },
  ],
  'Bilt Blue Card': [
    {
      label: 'Dining', unit: 'x Bilt',
      readFn: cfg => cfg.mccs?.['5812'] ?? 3,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); ['5812','5813','5814'].forEach(k => { c.mccs[k] = v; }); return c; },
    },
    {
      label: 'Travel', unit: 'x Bilt',
      readFn: cfg => cfg.mccs?.['4511'] ?? 2,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); ['4511','7011'].forEach(k => { c.mccs[k] = v; }); return c; },
    },
    {
      label: 'Everything else', unit: 'x Bilt',
      readFn: cfg => cfg.default ?? 1,
      writeFn: (cfg, v) => { const c = deepCopy(cfg); c.default = v; return c; },
    },
  ],
};

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
    <h3 className="text-[10px] font-black uppercase tracking-[0.18em] mb-3" style={{ color: 'var(--color-text-muted)' }}>
      {children}
    </h3>
  );
}

function Toggle({ on, onToggle, label, desc }) {
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between gap-3 px-4 py-3.5 rounded-2xl transition-all text-left"
      style={on
        ? { background: 'var(--sur-5)', border: '1px solid var(--sur-12)' }
        : { background: 'var(--sur-2)', border: '1px solid var(--sur-6)', opacity: 0.55 }
      }
    >
      <div className="min-w-0">
        <p className="text-sm font-bold truncate" style={{ color: on ? 'var(--color-text)' : 'var(--color-text-muted)' }}>
          {label}
        </p>
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>
      </div>
      {/* Pill toggle */}
      <div className="flex-shrink-0 w-10 h-6 rounded-full transition-colors duration-200"
        style={{ background: on ? 'var(--color-accent)' : 'var(--sur-15)' }}>
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
        <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>{label}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {listening ? (
          <span className="text-xs font-bold px-3 py-1.5 rounded-xl animate-pulse"
            style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}>
            Press keys… Esc to cancel
          </span>
        ) : (
          <>
            <button
              ref={ref}
              onClick={() => setListening(true)}
              className="text-xs font-black px-3 py-1.5 rounded-xl transition-colors font-mono tracking-wide hover:bg-[var(--sur-5)]"
              style={{ color: 'var(--color-text)', background: 'var(--sur-8)', border: '1px solid var(--sur-12)' }}
              title="Click to rebind"
            >
              {formatCombo(value)}
            </button>
            {value !== defaultValue && (
              <button onClick={onReset} title="Reset to default"
                className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]"
                style={{ color: 'var(--color-text-muted)' }}>
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

  // Cards state
  const [addingCard, setAddingCard]             = useState(false);
  const [newCardName, setNewCardName]           = useState('');
  const [editingCardIdx, setEditingCardIdx]     = useState(null);
  const [cardNameDraft, setCardNameDraft]       = useState('');

  // Card Rules state
  const [addingCardRule, setAddingCardRule]     = useState(false);
  const [newCardRuleDraft, setNewCardRuleDraft] = useState({ vendorPattern: '', category: '', card: '' });
  const [editingCardRuleId, setEditingCardRuleId] = useState(null);
  const [cardRuleDraft, setCardRuleDraft]       = useState({ vendorPattern: '', category: '', card: '' });

  // Reward Rates state
  const [openRateCard, setOpenRateCard]         = useState(null); // which card is expanded
  const [editingRateRow, setEditingRateRow]     = useState(null); // { card, idx }
  const [rateInputDraft, setRateInputDraft]     = useState('');

  // MCP connector config copy feedback
  const [mcpCopied, setMcpCopied]               = useState(false);
  const mcpConfig = `{
  "mcpServers": {
    "fundient": {
      "type": "http",
      "url": "${window.location.origin}/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_API_KEY" }
    }
  }
}`;
  const copyMcpConfig = () => {
    navigator.clipboard?.writeText(mcpConfig).then(() => {
      setMcpCopied(true);
      setTimeout(() => setMcpCopied(false), 2000);
    }).catch(() => {});
  };

  const smartRules        = settings.smartRules || [];
  const recurringExpenses = settings.recurringExpenses || [];
  const cards             = settings.cards || DEFAULT_SETTINGS.cards;
  const cardRules         = settings.cardRules || [];

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

  // Card list helpers
  const saveNewCard = () => {
    const name = newCardName.trim();
    if (!name || cards.includes(name)) return;
    updateSettings(prev => ({ ...prev, cards: [...(prev.cards || DEFAULT_SETTINGS.cards), name] }));
    setNewCardName('');
    setAddingCard(false);
  };

  const saveEditCard = () => {
    const name = cardNameDraft.trim();
    if (!name) return;
    updateSettings(prev => {
      const updated = [...(prev.cards || DEFAULT_SETTINGS.cards)];
      updated[editingCardIdx] = name;
      return { ...prev, cards: updated };
    });
    setEditingCardIdx(null);
  };

  const deleteCard = (idx) => {
    updateSettings(prev => ({ ...prev, cards: (prev.cards || DEFAULT_SETTINGS.cards).filter((_, i) => i !== idx) }));
    if (editingCardIdx === idx) setEditingCardIdx(null);
  };

  // Card rule helpers
  const saveNewCardRule = () => {
    const pattern = newCardRuleDraft.vendorPattern.trim();
    if (!pattern || !newCardRuleDraft.card) return;
    updateSettings(prev => ({
      ...prev,
      cardRules: [...(prev.cardRules || []), { id: newRuleId(), ...newCardRuleDraft, vendorPattern: pattern }],
    }));
    setNewCardRuleDraft({ vendorPattern: '', category: '', card: '' });
    setAddingCardRule(false);
  };

  const saveEditCardRule = () => {
    const pattern = cardRuleDraft.vendorPattern.trim();
    if (!pattern || !cardRuleDraft.card) return;
    updateSettings(prev => ({
      ...prev,
      cardRules: (prev.cardRules || []).map(r =>
        r.id === editingCardRuleId ? { ...r, ...cardRuleDraft, vendorPattern: pattern } : r
      ),
    }));
    setEditingCardRuleId(null);
  };

  const deleteCardRule = (id) =>
    updateSettings(prev => ({ ...prev, cardRules: (prev.cardRules || []).filter(r => r.id !== id) }));

  const inputCls = "rounded-xl px-3 py-1.5 text-xs outline-none w-full";
  const inputStyle = { background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' };

  const toggleVis = (key) =>
    updateSettings(prev => ({
      ...prev,
      visibility: { ...prev.visibility, [key]: !prev.visibility[key] },
    }));

  const getCategoryColor = (name, idx) =>
    settings.categoryColors?.[name] || schemeTableau10[idx % 10];

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
        className="fixed inset-0 z-40 animate-overlay-in"
        style={{ background: 'oklch(0% 0 0 / 50%)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 w-[85vw] max-w-sm glass-heavy flex flex-col"
        style={{ borderLeft: '1px solid var(--sur-8)', paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 flex-shrink-0" style={{ borderBottom: '1px solid var(--sur-8)' }}>
          <div>
            <h2 className="text-base font-black" style={{ color: 'var(--color-text)' }}>Customize Dashboard</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Saved to your account automatically</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">

            {/* ── Currency ────────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Currency</SectionLabel>
            <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
              {/* Selected currency display */}
              <div className="px-4 py-3 flex items-center gap-3" style={{ borderBottom: '1px solid var(--sur-8)' }}>
                <span className="text-xl">{CURRENCIES.find(c => c.code === (settings.currency || 'USD'))?.flag}</span>
                <div>
                  <p className="text-sm font-black" style={{ color: 'var(--color-text)' }}>
                    {CURRENCIES.find(c => c.code === (settings.currency || 'USD'))?.label}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                    {settings.currency || 'USD'} · {CURRENCIES.find(c => c.code === (settings.currency || 'USD'))?.symbol}
                  </p>
                </div>
              </div>

              {/* Search */}
              <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--sur-8)' }}>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                  <input
                    type="text"
                    placeholder="Search currency…"
                    value={currencySearch}
                    onChange={e => setCurrencySearch(e.target.value)}
                    className="w-full rounded-xl pl-8 pr-3 py-2 text-xs outline-none" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
                  />
                </div>
              </div>

              {/* Currency list */}
              <div className="max-h-48 overflow-y-auto">
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
                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--sur-5)]"
                        style={selected ? { background: 'var(--color-accent-subtle)' } : {}}
                      >
                        <span className="text-base w-6 flex-shrink-0">{c.flag}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold truncate" style={{ color: selected ? 'var(--color-accent-text)' : 'var(--color-text)' }}>
                            {c.label}
                          </p>
                          <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{c.code}</p>
                        </div>
                        <span className="text-sm font-black flex-shrink-0" style={{ color: selected ? 'var(--color-accent-text)' : 'var(--color-text-muted)' }}>
                          {c.symbol}
                        </span>
                        {selected && (
                          <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--color-accent)' }} />
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
              <div className="rounded-2xl px-4 py-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <p className="text-sm font-bold mb-3" style={{ color: 'var(--color-text)' }}>Default theme</p>
                <div className="flex gap-2">
                  {[
                    { value: 'dark',   label: '🌙 Dark'  },
                    { value: 'light',  label: '☀️ Light' },
                    { value: 'system', label: '💻 System' },
                  ].map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, theme: value }))}
                      className="flex-1 py-2 rounded-xl text-xs font-black transition-all"
                      style={settings.theme === value
                        ? { background: 'var(--color-accent)', color: 'white' }
                        : { background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Color scheme */}
              <div className="rounded-2xl px-4 py-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <p className="text-sm font-bold mb-3" style={{ color: 'var(--color-text)' }}>Accent color</p>
                <div className="flex gap-2 flex-wrap">
                  {COLOR_SCHEMES.map(({ value, label, primary }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, colorScheme: value }))}
                      title={label}
                      className={`w-8 h-8 rounded-full transition-all ${
                        settings.colorScheme === value
                          ? 'ring-2 ring-offset-1 scale-110'
                          : 'hover:scale-105 opacity-70 hover:opacity-100'
                      }`}
                      style={{
                        backgroundColor: primary,
                        ringColor: primary,
                      }}
                    />
                  ))}
                </div>
                <p className="text-xs mt-2" style={{ color: 'var(--color-text-muted)' }}>
                  {COLOR_SCHEMES.find(c => c.value === settings.colorScheme)?.label || 'Indigo'} selected
                </p>
              </div>

              {/* Font size */}
              <div className="rounded-2xl px-4 py-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <p className="text-sm font-bold mb-3" style={{ color: 'var(--color-text)' }}>Font size</p>
                <div className="flex gap-2">
                  {FONT_SIZE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, fontSize: value }))}
                      className="flex-1 py-2 rounded-xl text-xs font-black transition-all"
                      style={settings.fontSize === value
                        ? { background: 'var(--color-accent)', color: 'white' }
                        : { background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
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
              <div className="rounded-2xl px-4 py-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <p className="text-sm font-bold mb-3" style={{ color: 'var(--color-text)' }}>Distribution legend items</p>
                <div className="flex gap-2">
                  {LEGEND_COUNT_OPTIONS.map(n => (
                    <button
                      key={n}
                      onClick={() => updateSettings(prev => ({ ...prev, donutLegendCount: n }))}
                      className="flex-1 py-2 rounded-xl text-xs font-black transition-all"
                      style={settings.donutLegendCount === n
                        ? { background: 'var(--color-accent)', color: 'white' }
                        : { background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
                    >
                      {n === 10 ? 'All' : `Top ${n}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* Bar chart sort */}
              <div className="rounded-2xl px-4 py-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <p className="text-sm font-bold mb-3" style={{ color: 'var(--color-text)' }}>Bar chart sort order</p>
                <div className="space-y-1">
                  {BAR_SORT_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      onClick={() => updateSettings(prev => ({ ...prev, barSortOrder: value }))}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-bold transition-all text-left"
                      style={settings.barSortOrder === value
                        ? { background: 'var(--color-accent-subtle)', color: 'var(--color-accent-text)' }
                        : { color: 'var(--color-text)' }}
                    >
                      <div className="w-3.5 h-3.5 rounded-full border-2 flex-shrink-0 transition-colors"
                      style={settings.barSortOrder === value
                        ? { borderColor: 'var(--color-accent)', background: 'var(--color-accent)' }
                        : { borderColor: 'var(--sur-25)', background: 'transparent' }} />
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
              <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                {chartExpenses.map((exp, i) => (
                  <label
                    key={exp.name}
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors group hover:bg-[var(--sur-5)]"
                  >
                    <div
                      className="w-5 h-5 rounded-md flex-shrink-0 ring-1 ring-black/10 group-hover:scale-110 transition-transform"
                      style={{ backgroundColor: getCategoryColor(exp.name, i) }}
                    />
                    <span className="flex-1 text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>
                      {exp.name}
                    </span>
                    <span className="text-xs tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                      {currencySymbol}{exp.actual.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                    <span className="text-[10px] transition-colors" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }}>
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
            <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
              <div className="px-4 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--sur-6)' }}>
                <div>
                  <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>App PIN Lock</p>
                  <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{pinHash ? 'PIN is set — app locks when backgrounded' : 'Lock the app with a 4-digit PIN'}</p>
                </div>
                {pinHash ? (
                  <button onClick={onClearPin} className="px-3 py-1.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-danger)', background: 'oklch(62% 0.22 25 / 10%)' }}>
                    Remove PIN
                  </button>
                ) : (
                  <button onClick={onSetPin} className="px-3 py-1.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}>
                    Set PIN
                  </button>
                )}
              </div>
              {pinHash && (
                <div className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Lock timeout</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>How long before the app re-locks</p>
                  </div>
                  <select
                    value={localStorage.getItem('budget_pin_timeout') || String(10 * 60 * 1000)}
                    onChange={e => localStorage.setItem('budget_pin_timeout', e.target.value)}
                    className="rounded-xl px-3 py-1.5 text-sm font-bold outline-none cursor-pointer" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
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
              <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                {/* Toggle */}
                <div className="px-4 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--sur-6)' }}>
                  <div>
                    <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Daily digest</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
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
                    className="relative w-11 h-6 rounded-full transition-colors disabled:opacity-40 flex-shrink-0"
                    style={{ background: pushHook.subscribed ? 'var(--color-accent)' : 'var(--sur-15)' }}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${pushHook.subscribed ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>

                {/* Time picker — only when subscribed */}
                {pushHook.subscribed && (
                  <div className="px-4 py-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Notification time</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>What time to send the daily digest</p>
                    </div>
                    <select
                      value={settings.pushHour ?? 20}
                      onChange={e => {
                        const h = Number(e.target.value);
                        updateSettings(prev => ({ ...prev, pushHour: h }));
                        pushHook.updatePreferredHour(h);
                      }}
                      className="rounded-xl px-3 py-1.5 text-sm font-bold outline-none cursor-pointer" style={{ background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
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
              <div className="rounded-2xl px-4 py-6 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No recurring expenses set.</p>
                <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>Add them via the Add Expense dialog.</p>
              </div>
            ) : (
              <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
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
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}
                          >
                            Cancel
                          </button>
                          <button
                            onClick={saveEditRec}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-white transition-colors flex items-center justify-center gap-1" style={{ background: 'var(--color-accent)' }}
                          >
                            <Check className="w-3 h-3" /> Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* View mode */
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{r.vendor}</p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{r.category} · {currencySymbol}{r.amount.toFixed(2)}/mo</p>
                        </div>
                        <button
                          onClick={() => startEditRec(i)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => deleteRec(i)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}
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
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
              >
                <Plus className="w-3 h-3" /> Add rule
              </button>
            </div>
            <p className="text-xs mb-3 -mt-2" style={{ color: 'var(--color-text-muted)' }}>Auto-fill category when vendor name matches. Most specific rule wins.</p>

            {/* Add new rule form */}
            {addingRule && (
              <div className="rounded-2xl p-4 mb-3 space-y-3" style={{ background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>If vendor name contains</label>
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
                  <label className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Then use category</label>
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
                    className="flex-1 py-2 rounded-xl text-xs font-bold text-white transition-colors disabled:opacity-40" style={{ background: 'var(--color-accent)' }}>
                    Save rule
                  </button>
                  <button onClick={() => setAddingRule(false)}
                    className="flex-1 py-2 rounded-xl text-xs font-bold transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)', border: '1px solid var(--sur-12)' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {smartRules.length === 0 && !addingRule ? (
              <div className="rounded-2xl px-4 py-6 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <Zap className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No rules yet.</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Rules auto-fill the category when adding or importing expenses.</p>
              </div>
            ) : smartRules.length > 0 && (
              <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
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
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-white transition-colors" style={{ background: 'var(--color-accent)' }}>
                            Save
                          </button>
                          <button onClick={() => setEditingRuleId(null)}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <Zap className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-text)' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                            contains <span className="font-black" style={{ color: 'var(--color-text)' }}>"{rule.pattern}"</span>
                          </p>
                          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>→ <span className="font-bold" style={{ color: 'var(--color-accent-text)' }}>{rule.category}</span></p>
                        </div>
                        <button onClick={() => { setRuleDraft({ pattern: rule.pattern, category: rule.category }); setEditingRuleId(rule.id); }}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteRule(rule.id)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Cards & Payment Methods ─────────────────────────────────── */}
          <div>
            {/* Cards list */}
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>Cards &amp; Payment Methods</SectionLabel>
              <button
                onClick={() => { setAddingCard(true); setNewCardName(''); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
              >
                <Plus className="w-3 h-3" /> Add card
              </button>
            </div>
            <p className="text-xs mb-3 -mt-2" style={{ color: 'var(--color-text-muted)' }}>Cards available for auto-fill and reward tracking.</p>

            <div className="rounded-2xl overflow-hidden mb-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
              {cards.map((card, idx) => (
                <div key={idx} className="px-4 py-3">
                  {editingCardIdx === idx ? (
                    <div className="flex gap-2">
                      <input
                        autoFocus
                        type="text"
                        value={cardNameDraft}
                        onChange={e => setCardNameDraft(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') saveEditCard(); if (e.key === 'Escape') setEditingCardIdx(null); }}
                        className={inputCls}
                      />
                      <button onClick={saveEditCard} className="px-3 py-1.5 rounded-xl text-xs font-bold text-white transition-colors flex-shrink-0" style={{ background: 'var(--color-accent)' }}>
                        <Check className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditingCardIdx(null)} className="px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>
                        ✕
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <CreditCard className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-text)' }} />
                      <p className="flex-1 text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{card}</p>
                      <button
                        onClick={() => { setCardNameDraft(card); setEditingCardIdx(idx); }}
                        className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteCard(idx)}
                        className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {/* Add card inline form */}
              {addingCard && (
                <div className="px-4 py-3 flex gap-2" style={{ background: 'var(--color-accent-subtle)' }}>
                  <input
                    autoFocus
                    type="text"
                    placeholder="Card name…"
                    value={newCardName}
                    onChange={e => setNewCardName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveNewCard(); if (e.key === 'Escape') setAddingCard(false); }}
                    className={inputCls}
                  />
                  <button onClick={saveNewCard} disabled={!newCardName.trim()} className="px-3 py-1.5 rounded-xl text-xs font-bold text-white disabled:opacity-40 transition-colors flex-shrink-0" style={{ background: 'var(--color-accent)' }}>
                    <Check className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => setAddingCard(false)} className="px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex-shrink-0 hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>
                    ✕
                  </button>
                </div>
              )}
            </div>

            {/* Card Rules */}
            <div className="flex items-center justify-between mb-3">
              <SectionLabel>Card Rules</SectionLabel>
              <button
                onClick={() => { setAddingCardRule(true); setNewCardRuleDraft({ vendorPattern: '', category: '', card: cards[0] || '' }); }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
              >
                <Plus className="w-3 h-3" /> Add rule
              </button>
            </div>
            <p className="text-xs mb-3 -mt-2" style={{ color: 'var(--color-text-muted)' }}>Auto-assign a card when vendor and/or category match. Category-specific rules win over vendor-only.</p>

            {addingCardRule && (
              <div className="rounded-2xl p-4 mb-3 space-y-3" style={{ background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>If vendor name contains</label>
                  <input
                    autoFocus
                    type="text"
                    placeholder="e.g. Costco, Whole Foods…"
                    value={newCardRuleDraft.vendorPattern}
                    onChange={e => setNewCardRuleDraft(d => ({ ...d, vendorPattern: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && saveNewCardRule()}
                    className={inputCls}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Category (optional)</label>
                  <select
                    value={newCardRuleDraft.category}
                    onChange={e => setNewCardRuleDraft(d => ({ ...d, category: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="">Any category</option>
                    {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>Use card</label>
                  <select
                    value={newCardRuleDraft.card}
                    onChange={e => setNewCardRuleDraft(d => ({ ...d, card: e.target.value }))}
                    className={inputCls}
                  >
                    <option value="">Select card…</option>
                    {cards.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveNewCardRule} disabled={!newCardRuleDraft.vendorPattern.trim() || !newCardRuleDraft.card}
                    className="flex-1 py-2 rounded-xl text-xs font-bold text-white transition-colors disabled:opacity-40" style={{ background: 'var(--color-accent)' }}>
                    Save rule
                  </button>
                  <button onClick={() => setAddingCardRule(false)}
                    className="flex-1 py-2 rounded-xl text-xs font-bold transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)', border: '1px solid var(--sur-12)' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {cardRules.length === 0 && !addingCardRule ? (
              <div className="rounded-2xl px-4 py-6 text-center" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                <CreditCard className="w-5 h-5 mx-auto mb-2" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }} />
                <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>No card rules yet.</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>Rules auto-assign a card when adding or scanning expenses.</p>
              </div>
            ) : cardRules.length > 0 && (
              <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                {cardRules.map(rule => (
                  <div key={rule.id} className="px-4 py-3">
                    {editingCardRuleId === rule.id ? (
                      <div className="space-y-2">
                        <input type="text" value={cardRuleDraft.vendorPattern}
                          onChange={e => setCardRuleDraft(d => ({ ...d, vendorPattern: e.target.value }))}
                          onKeyDown={e => e.key === 'Enter' && saveEditCardRule()}
                          className={inputCls} autoFocus placeholder="Vendor contains…" />
                        <select value={cardRuleDraft.category}
                          onChange={e => setCardRuleDraft(d => ({ ...d, category: e.target.value }))}
                          className={inputCls}>
                          <option value="">Any category</option>
                          {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <select value={cardRuleDraft.card}
                          onChange={e => setCardRuleDraft(d => ({ ...d, card: e.target.value }))}
                          className={inputCls}>
                          <option value="">Select card…</option>
                          {cards.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <div className="flex gap-2">
                          <button onClick={saveEditCardRule}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold text-white transition-colors" style={{ background: 'var(--color-accent)' }}>
                            Save
                          </button>
                          <button onClick={() => setEditingCardRuleId(null)}
                            className="flex-1 py-1.5 rounded-xl text-xs font-bold transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3">
                        <CreditCard className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-text)' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                            contains <span className="font-black" style={{ color: 'var(--color-text)' }}>"{rule.vendorPattern}"</span>
                            {rule.category && <span style={{ color: 'var(--color-text-muted)' }}> · {rule.category}</span>}
                          </p>
                          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>→ <span className="font-bold" style={{ color: 'var(--color-accent-text)' }}>{rule.card}</span></p>
                        </div>
                        <button onClick={() => { setCardRuleDraft({ vendorPattern: rule.vendorPattern, category: rule.category || '', card: rule.card }); setEditingCardRuleId(rule.id); }}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => deleteCardRule(rule.id)}
                          className="p-1.5 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Reward Rates ────────────────────────────────────────────── */}
          <div>
            <SectionLabel>Reward Rates</SectionLabel>
            <p className="text-xs mb-3 -mt-2" style={{ color: 'var(--color-text-muted)' }}>
              Override earn rates for your reward cards. Changes apply to future calculations.
              {settings.cardRewardRates && <span className="font-bold ml-1" style={{ color: 'var(--color-accent-text)' }}>Customised</span>}
            </p>
            <div className="space-y-2">
              {Object.keys(CARD_REWARDS).map(card => {
                const effectiveRates = getEffectiveRates(settings);
                const cfg = effectiveRates[card];
                const isCustomised = !!(settings.cardRewardRates?.[card]);
                const isOpen = openRateCard === card;
                const rows = REWARD_RATE_DEFS[card] || [];

                const saveRateRow = () => {
                  const val = parseFloat(rateInputDraft);
                  if (isNaN(val) || val < 0) return;
                  const { idx } = editingRateRow;
                  const def = rows[idx];
                  const updatedCfg = def.writeFn(cfg, val);
                  const existing = settings.cardRewardRates ? { ...settings.cardRewardRates } : {};
                  existing[card] = updatedCfg;
                  updateSettings(prev => ({ ...prev, cardRewardRates: existing }));
                  setEditingRateRow(null);
                };

                const resetCard = () => {
                  const existing = settings.cardRewardRates ? { ...settings.cardRewardRates } : {};
                  delete existing[card];
                  updateSettings(prev => ({
                    ...prev,
                    cardRewardRates: Object.keys(existing).length ? existing : null,
                  }));
                };

                return (
                  <div key={card} className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
                    <button
                      onClick={() => { setOpenRateCard(isOpen ? null : card); setEditingRateRow(null); }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--sur-5)]"
                    >
                      <CreditCard className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-text)' }} />
                      <span className="flex-1 text-sm font-bold truncate" style={{ color: 'var(--color-text)' }}>{card}</span>
                      {isCustomised && (
                        <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded-full" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)' }}>
                          Custom
                        </span>
                      )}
                      {isOpen ? <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} /> : <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />}
                    </button>

                    {isOpen && (
                      <div className="" style={{ borderTop: '1px solid var(--sur-8)' }}>
                        {rows.map((def, idx) => {
                          const currentVal = def.readFn(cfg);
                          const isEditing = editingRateRow?.card === card && editingRateRow?.idx === idx;
                          return (
                            <div key={idx} className="px-4 py-2.5 flex items-center gap-3">
                              <div className="flex-1 min-w-0">
                                <p className="text-xs font-bold" style={{ color: 'var(--color-text)' }}>{def.label}</p>
                                {def.hint && <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>{def.hint}</p>}
                              </div>
                              {isEditing ? (
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <input
                                    autoFocus
                                    type="number"
                                    step="0.5"
                                    min="0"
                                    value={rateInputDraft}
                                    onChange={e => setRateInputDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') saveRateRow(); if (e.key === 'Escape') setEditingRateRow(null); }}
                                    className="w-20 px-2 py-1 text-xs font-bold rounded-lg outline-none" style={{ background: 'var(--sur-5)', border: '1px solid var(--color-accent-border)', color: 'var(--color-text)' }}
                                  />
                                  <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--color-text-muted)' }}>{def.unit}</span>
                                  <button onClick={saveRateRow} className="p-1 rounded-lg text-white transition-colors" style={{ background: 'var(--color-accent)' }}>
                                    <Check className="w-3 h-3" />
                                  </button>
                                  <button onClick={() => setEditingRateRow(null)} className="p-1 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1.5 flex-shrink-0">
                                  <span className="text-xs font-black tabular-nums" style={{ color: 'var(--color-text)' }}>{currentVal}{def.unit}</span>
                                  <button
                                    onClick={() => { setEditingRateRow({ card, idx }); setRateInputDraft(String(currentVal)); }}
                                    className="p-1 rounded-lg transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}
                                  >
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {isCustomised && (
                          <div className="px-4 py-2.5">
                            <button
                              onClick={resetCard}
                              className="flex items-center gap-1.5 text-xs font-bold transition-colors" style={{ color: 'var(--color-text-muted)' }}
                            >
                              <RotateCcw className="w-3 h-3" /> Reset to defaults
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Keyboard Shortcuts ──────────────────────────────────────── */}
          <div>
            <SectionLabel>Keyboard Shortcuts</SectionLabel>
            <div className="rounded-2xl overflow-hidden" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
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
            <p className="text-xs mt-2 px-1" style={{ color: 'var(--color-text-muted)' }}>Click a binding to rebind. Must include at least one modifier key (Ctrl, Alt, Shift).</p>
          </div>

          {/* ── MCP Connector (Claude Desktop) ──────────────────────────── */}
          <div>
            <SectionLabel>Claude / MCP Connector</SectionLabel>
            <div className="rounded-2xl px-4 py-4 space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                Connect Claude (Desktop or Web) to query and log expenses by natural language.
                Set a secret <code className="font-mono text-[11px] px-1 py-0.5 rounded" style={{ background: 'var(--sur-8)' }}>MCP_API_KEY</code> environment
                variable in Netlify, then add this to your MCP client config (replace the placeholder with that key):
              </p>
              <pre className="text-[10px] leading-relaxed font-mono rounded-xl p-3 overflow-x-auto whitespace-pre" style={{ background: 'oklch(8% 0.005 var(--accent-hue))', color: 'oklch(90% 0.005 0)' }}>{mcpConfig}</pre>
              <button
                onClick={copyMcpConfig}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold transition-colors" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
              >
                {mcpCopied ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                {mcpCopied ? 'Copied!' : 'Copy config'}
              </button>
              <p className="text-[11px] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
                Exposes tools: <span className="font-mono">get_monthly_summary</span>, <span className="font-mono">get_transactions</span>, <span className="font-mono">get_categories</span>, <span className="font-mono">add_transaction</span>, <span className="font-mono">delete_transaction</span>.
              </p>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-6 py-4 space-y-2" style={{ borderTop: '1px solid var(--sur-8)' }}>
          <button
            onClick={() => updateSettings({ ...DEFAULT_SETTINGS })}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold transition-colors hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}
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
            className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold transition-colors" style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Clear Cache & Refresh
          </button>
          <p className="text-center text-[10px] font-mono mt-2" style={{ color: 'var(--color-text-muted)', opacity: 0.4 }}>
            v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).replace(',', '')}
          </p>
        </div>

      </div>
    </>
  );
}
