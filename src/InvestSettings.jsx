import React, { useState } from 'react';
import { TrendingUp, Plus, Pencil, Trash2, Check, ExternalLink } from 'lucide-react';
import { newRuleId } from './smartRules.js';
import { investCache } from './useInvestData.js';
import { buildAccountOptions } from './investAccountOptions.js';

// ════════════════════════════════════════════════════════════════════════════
// InvestSettingsSection — the "Investing" block inside SettingsPanel.
// Self-contained so the (large) SettingsPanel only imports + renders it.
// Manages: contribution flow-through rules (vendor → invest account),
// pre-buy flag thresholds, extra ETF symbols, and a link to the sheet.
// ════════════════════════════════════════════════════════════════════════════

// Real Invest accounts come from the Invest tab's cache (no extra fetch); until it
// has been loaded this session the options fall back to the default list.
function cachedAccounts(sheetId) {
  if (!sheetId) return null;
  const mem = investCache.get(sheetId)?.data?.accounts;
  if (mem?.length) return mem;
  try {
    return JSON.parse(localStorage.getItem(`budget_invest_cache_${sheetId}`))?.data?.accounts || null;
  } catch { return null; }
}

const inputCls = 'rounded-xl px-3 py-1.5 text-xs outline-none w-full';
const inputStyle = { background: 'var(--sur-5)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' };

function SectionLabel({ children }) {
  return (
    <h3 className="text-[10px] font-black uppercase tracking-[0.18em] mb-3" style={{ color: 'var(--color-text-muted)' }}>
      {children}
    </h3>
  );
}

export function InvestSettingsSection({ settings, updateSettings }) {
  const rules = settings.investAccountRules || [];
  const ACCOUNT_OPTIONS = buildAccountOptions(cachedAccounts(settings.investSheetId), rules);
  const thresholds = settings.preBuyThresholds || { concentrationPct: 25, near52wkPct: 5 };

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ pattern: '', accountId: 'fidelity' });
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({ pattern: '', accountId: 'fidelity' });
  const [etfDraft, setEtfDraft] = useState((settings.investEtfSymbols || []).join(', '));

  const saveRules = (next) => updateSettings(prev => ({ ...prev, investAccountRules: next }));

  const addRule = () => {
    const pattern = draft.pattern.trim();
    if (!pattern) return;
    saveRules([...rules, { id: newRuleId(), pattern, accountId: draft.accountId }]);
    setDraft({ pattern: '', accountId: 'fidelity' });
    setAdding(false);
  };

  const saveEdit = () => {
    const pattern = editDraft.pattern.trim();
    if (!pattern) return;
    saveRules(rules.map(r => (r.id || r.pattern) === editingId ? { ...r, pattern, accountId: editDraft.accountId } : r));
    setEditingId(null);
  };

  const setThreshold = (key, value) => {
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0 || n > 100) return;
    updateSettings(prev => ({ ...prev, preBuyThresholds: { ...(prev.preBuyThresholds || {}), [key]: n } }));
  };

  const saveEtfs = () => {
    const list = [...new Set(etfDraft.split(/[,\s]+/).map(s => s.trim().toUpperCase()).filter(Boolean))];
    updateSettings(prev => ({ ...prev, investEtfSymbols: list }));
    setEtfDraft(list.join(', '));
  };

  const acctName = (id) => ACCOUNT_OPTIONS.find(([v]) => v === id)?.[1] || id;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <SectionLabel>Investing</SectionLabel>
        {settings.investSheetId && (
          <a href={`https://docs.google.com/spreadsheets/d/${settings.investSheetId}`} target="_blank" rel="noreferrer"
            className="flex items-center gap-1 text-[10px] font-bold" style={{ color: 'var(--color-accent-text)' }}>
            Open sheet <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Flow-through rules */}
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Investment-category expenses matching a rule mirror into the Invest tab as deposits.
        </p>
        <button
          onClick={() => { setAdding(true); setDraft({ pattern: '', accountId: 'fidelity' }); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex-shrink-0 ml-2"
          style={{ color: 'var(--color-accent-text)', background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
        >
          <Plus className="w-3 h-3" /> Rule
        </button>
      </div>

      {adding && (
        <div className="rounded-2xl p-4 mb-3 space-y-2" style={{ background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}>
          <input autoFocus type="text" placeholder="If vendor contains… e.g. fidelity" value={draft.pattern}
            onChange={e => setDraft(d => ({ ...d, pattern: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && addRule()} className={inputCls} style={inputStyle} />
          <select value={draft.accountId} onChange={e => setDraft(d => ({ ...d, accountId: e.target.value }))} className={inputCls} style={inputStyle}>
            {ACCOUNT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <div className="flex gap-2">
            <button onClick={addRule} disabled={!draft.pattern.trim()}
              className="flex-1 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-40" style={{ background: 'var(--color-accent)' }}>Save</button>
            <button onClick={() => setAdding(false)}
              className="flex-1 py-2 rounded-xl text-xs font-bold" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>Cancel</button>
          </div>
        </div>
      )}

      <div className="rounded-2xl overflow-hidden mb-4" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
        {rules.length === 0 && !adding && (
          <p className="text-xs text-center py-5" style={{ color: 'var(--color-text-muted)' }}>No flow-through rules.</p>
        )}
        {rules.map(rule => {
          const key = rule.id || rule.pattern;
          return (
            <div key={key} className="px-4 py-3">
              {editingId === key ? (
                <div className="space-y-2">
                  <input type="text" value={editDraft.pattern} autoFocus
                    onChange={e => setEditDraft(d => ({ ...d, pattern: e.target.value }))}
                    onKeyDown={e => e.key === 'Enter' && saveEdit()} className={inputCls} style={inputStyle} />
                  <select value={editDraft.accountId} onChange={e => setEditDraft(d => ({ ...d, accountId: e.target.value }))} className={inputCls} style={inputStyle}>
                    {ACCOUNT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="flex-1 py-1.5 rounded-xl text-xs font-bold text-white" style={{ background: 'var(--color-accent)' }}><Check className="w-3 h-3 mx-auto" /></button>
                    <button onClick={() => setEditingId(null)} className="flex-1 py-1.5 rounded-xl text-xs font-bold" style={{ color: 'var(--color-text-muted)', background: 'var(--sur-8)' }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-accent-text)' }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      contains <span className="font-black" style={{ color: 'var(--color-text)' }}>"{rule.pattern}"</span>
                    </p>
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>→ <span className="font-bold" style={{ color: 'var(--color-accent-text)' }}>{acctName(rule.accountId)}</span></p>
                  </div>
                  <button onClick={() => { setEditDraft({ pattern: rule.pattern, accountId: rule.accountId }); setEditingId(key); }}
                    className="p-1.5 rounded-lg hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button onClick={() => saveRules(rules.filter(r => (r.id || r.pattern) !== key))}
                    className="p-1.5 rounded-lg hover:bg-[var(--sur-5)]" style={{ color: 'var(--color-text-muted)' }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pre-buy thresholds */}
      <div className="rounded-2xl px-4 py-4 mb-4 space-y-3" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
        <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Pre-buy check flags</p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>Single-position concentration cap</p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <input type="number" min="1" max="100" step="1" defaultValue={thresholds.concentrationPct}
              onBlur={e => setThreshold('concentrationPct', e.target.value)}
              className="w-16 px-2 py-1 text-xs font-bold rounded-lg outline-none text-right tabular-nums" style={inputStyle} />
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>%</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>"Near 52-week high" margin</p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <input type="number" min="1" max="100" step="1" defaultValue={thresholds.near52wkPct}
              onBlur={e => setThreshold('near52wkPct', e.target.value)}
              className="w-16 px-2 py-1 text-xs font-bold rounded-lg outline-none text-right tabular-nums" style={inputStyle} />
            <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>%</span>
          </div>
        </div>
      </div>

      {/* Extra ETF symbols */}
      <div className="rounded-2xl px-4 py-4 space-y-2" style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-8)' }}>
        <p className="text-sm font-bold" style={{ color: 'var(--color-text)' }}>Extra ETF symbols</p>
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          Common ETFs are detected automatically. Add any others so the ETF/stock split stays honest.
        </p>
        <div className="flex gap-2">
          <input type="text" value={etfDraft} onChange={e => setEtfDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && saveEtfs()} placeholder="e.g. AVUV, JEPI"
            className={inputCls} style={inputStyle} />
          <button onClick={saveEtfs} className="px-3 py-1.5 rounded-xl text-xs font-bold text-white flex-shrink-0" style={{ background: 'var(--color-accent)' }}>
            <Check className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
