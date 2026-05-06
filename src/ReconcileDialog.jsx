import React, { useState, useRef, useCallback, useMemo } from 'react';
import { X, Upload, FileText, AlertCircle, CheckCircle2, ShieldCheck, ChevronDown, ChevronUp, RefreshCw, Check, SkipForward, HelpCircle } from 'lucide-react';
import { parseStatementFile } from './csvParsers.js';
import { runDeduplication } from './reconcileDedup.js';
import { getAllCategoryNames, fetchDetailRows, updateVendorAmounts, fuzzyNamesMatch } from './sheetsApi.js';
import { addOrUpdateExpense } from './useExpense.js';

const BANK_LABELS = { chase: 'Chase', amex: 'American Express', generic: 'Generic' };
const BANK_COLORS = {
  chase:   'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
  amex:    'bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300',
  generic: 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300',
};
const TYPE_COLORS = {
  purchase: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
  credit:   'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
  transfer: 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300',
};

function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch { return iso; }
}

// ── File row in upload list ───────────────────────────────────────────────────

function FileRow({ file, result, onRemove }) {
  const [expanded, setExpanded] = useState(false);
  const counts = result ? {
    purchase: result.transactions.filter(t => t.type === 'purchase').length,
    credit:   result.transactions.filter(t => t.type === 'credit').length,
    transfer: result.transactions.filter(t => t.type === 'transfer').length,
  } : null;

  return (
    <div className="bg-slate-50 dark:bg-slate-700/50 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <FileText className="w-4 h-4 text-slate-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{file.name}</p>
          {result && !result.error && (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className={`text-[10px] font-black px-2 py-0.5 rounded-full ${BANK_COLORS[result.bank] || BANK_COLORS.generic}`}>
                {BANK_LABELS[result.bank] || 'Generic'}
              </span>
              <span className="text-[10px] text-slate-400">{result.transactions.length} transactions</span>
              {counts.credit > 0   && <span className="text-[10px] text-amber-500">{counts.credit} credit{counts.credit > 1 ? 's' : ''}</span>}
              {counts.transfer > 0 && <span className="text-[10px] text-violet-500">{counts.transfer} transfer{counts.transfer > 1 ? 's' : ''}</span>}
            </div>
          )}
          {result?.error && (
            <p className="text-xs text-rose-500 mt-0.5 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {result.error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {result && !result.error && (
            <button onClick={() => setExpanded(v => !v)}
              className="p-1.5 rounded-xl text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors">
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          )}
          <button onClick={onRemove}
            className="p-1.5 rounded-xl text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded transaction preview */}
      {expanded && result && !result.error && (
        <div className="border-t border-slate-200 dark:border-slate-600 max-h-48 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-600 bg-white/50 dark:bg-slate-800/50">
                <th className="text-left px-4 py-2 font-black text-slate-400 uppercase tracking-wider">Date</th>
                <th className="text-left px-4 py-2 font-black text-slate-400 uppercase tracking-wider">Vendor</th>
                <th className="text-right px-4 py-2 font-black text-slate-400 uppercase tracking-wider">Amount</th>
                <th className="text-left px-4 py-2 font-black text-slate-400 uppercase tracking-wider">Type</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700/50">
              {result.transactions.map(t => (
                <tr key={t.id} className="hover:bg-white/70 dark:hover:bg-slate-700/30">
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">{formatDate(t.date)}</td>
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-200 max-w-[160px] truncate" title={t.rawVendor}>{t.vendor}</td>
                  <td className="px-4 py-2 text-right font-bold text-slate-900 dark:text-slate-100 tabular-nums">${t.amount.toFixed(2)}</td>
                  <td className="px-4 py-2">
                    <span className={`text-[10px] font-black px-2 py-0.5 rounded-full capitalize ${TYPE_COLORS[t.type] || ''}`}>
                      {t.type}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main dialog ───────────────────────────────────────────────────────────────

// ── Status config ─────────────────────────────────────────────────────────────

// ── Review sub-components ─────────────────────────────────────────────────────

function ReviewSection({ title, count, dot, children, defaultOpen = true, actionLabel, onSelectAll, onSkipAll }) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className="border border-slate-100 dark:border-slate-700 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
          <span className="text-sm font-black text-slate-700 dark:text-slate-200">{title}</span>
          <span className="text-xs font-bold text-slate-400 bg-white dark:bg-slate-800 px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-600">{count}</span>
        </div>
        <div className="flex items-center gap-2">
          {open && onSelectAll && (
            <button onClick={e => { e.stopPropagation(); onSelectAll(); }}
              className="text-[10px] font-black text-emerald-600 dark:text-emerald-400 hover:underline px-1">
              All in
            </button>
          )}
          {open && onSkipAll && (
            <button onClick={e => { e.stopPropagation(); onSkipAll(); }}
              className="text-[10px] font-black text-slate-400 hover:text-slate-600 hover:underline px-1">
              Skip all
            </button>
          )}
          {open ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
        </div>
      </button>
      {open && <div className="divide-y divide-slate-50 dark:divide-slate-700/50">{children}</div>}
    </div>
  );
}

function CategorySelect({ value, onChange, categories }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 rounded-xl px-2 py-1.5 text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer max-w-[130px]"
    >
      {categories.map(c => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

function ActionToggle({ action, options, onChange }) {
  return (
    <div className="flex rounded-xl overflow-hidden border border-slate-200 dark:border-slate-600 flex-shrink-0">
      {options.map(opt => (
        <button key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1.5 text-[10px] font-black transition-colors ${
            action === opt.value
              ? opt.activeClass
              : 'bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          }`}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// New transaction row
function NewRow({ tx, decision, onChange, categories }) {
  return (
    <div className={`px-4 py-3 flex flex-col gap-2 transition-opacity ${decision?.action === 'skip' ? 'opacity-40' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          <input
            type="text"
            value={decision?.vendor ?? tx.vendor}
            onChange={e => onChange({ vendor: e.target.value })}
            disabled={decision?.action === 'skip'}
            className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-800 dark:text-slate-100 rounded-xl px-3 py-1.5 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-50"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <CategorySelect value={decision?.category ?? tx.suggestedCategory ?? 'Misc'} onChange={v => onChange({ category: v })} categories={categories} />
            <span className="text-xs text-slate-400">{formatDate(tx.date)}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2 flex-shrink-0">
          <span className="text-sm font-black text-slate-900 dark:text-slate-100 tabular-nums">${tx.amount.toFixed(2)}</span>
          <ActionToggle
            action={decision?.action ?? 'import'}
            onChange={v => onChange({ action: v })}
            options={[
              { value: 'import', label: '✓ Import', activeClass: 'bg-emerald-500 text-white' },
              { value: 'skip',   label: 'Skip',     activeClass: 'bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300' },
            ]}
          />
        </div>
      </div>
    </div>
  );
}

// Credit row
function CreditRow({ tx, decision, onChange }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{tx.vendor}</p>
        <p className="text-xs text-slate-400 mt-0.5">
          {tx.matchedVendor
            ? <>Matches <span className="font-bold text-slate-600 dark:text-slate-300">{tx.matchedVendor}</span> in {tx.matchedCategory}</>
            : 'No matching expense found'}
          {' · '}{formatDate(tx.date)}
        </p>
      </div>
      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <span className="text-sm font-black text-amber-600 dark:text-amber-400 tabular-nums">+${tx.amount.toFixed(2)}</span>
        <ActionToggle
          action={decision?.action ?? 'ignore'}
          onChange={v => onChange({ action: v })}
          options={[
            { value: 'apply',  label: 'Apply',  activeClass: 'bg-amber-500 text-white', disabled: !tx.matchedVendor },
            { value: 'ignore', label: 'Ignore', activeClass: 'bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300' },
          ].filter(o => !o.disabled || o.value !== 'apply' || tx.matchedVendor)}
        />
      </div>
    </div>
  );
}

// Transfer row
function TransferRow({ tx, decision, onChange, categories }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{tx.vendor}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {decision?.action === 'import' && (
            <CategorySelect value={decision?.category ?? 'Misc'} onChange={v => onChange({ category: v })} categories={categories} />
          )}
          <span className="text-xs text-slate-400">{formatDate(tx.date)}</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <span className="text-sm font-black text-slate-900 dark:text-slate-100 tabular-nums">${tx.amount.toFixed(2)}</span>
        <ActionToggle
          action={decision?.action ?? 'skip'}
          onChange={v => onChange({ action: v })}
          options={[
            { value: 'import', label: 'As expense', activeClass: 'bg-violet-500 text-white' },
            { value: 'skip',   label: 'Skip',        activeClass: 'bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300' },
          ]}
        />
      </div>
    </div>
  );
}

// Cross-month row
function CrossMonthRow({ tx, decision, onChange, categories }) {
  return (
    <div className="px-4 py-3 flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-slate-700 dark:text-slate-200 truncate">{tx.vendor}</p>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {decision?.action === 'import' && (
            <CategorySelect value={decision?.category ?? tx.suggestedCategory ?? 'Misc'} onChange={v => onChange({ category: v })} categories={categories} />
          )}
          <span className="text-xs text-slate-400">{formatDate(tx.date)}</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <span className="text-sm font-black text-slate-900 dark:text-slate-100 tabular-nums">${tx.amount.toFixed(2)}</span>
        <ActionToggle
          action={decision?.action ?? 'skip'}
          onChange={v => onChange({ action: v })}
          options={[
            { value: 'import', label: 'Import', activeClass: 'bg-blue-500 text-white' },
            { value: 'skip',   label: 'Skip',   activeClass: 'bg-slate-200 dark:bg-slate-600 text-slate-600 dark:text-slate-300' },
          ]}
        />
      </div>
    </div>
  );
}

// ── CSV export help accordion ─────────────────────────────────────────────────

const CSV_BANKS = [
  {
    id: 'chase',
    name: 'Chase',
    color: 'text-blue-600 dark:text-blue-400',
    activeBg: 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800/40',
    steps: [
      'Sign in at chase.com and select your account',
      'Click the "Download account activity" icon near the top of the transactions list',
      'Set your desired date range',
      'For file type, select "Spreadsheet (Excel, CSV)"',
      'Click Download',
    ],
  },
  {
    id: 'amex',
    name: 'Amex',
    color: 'text-sky-600 dark:text-sky-400',
    activeBg: 'bg-sky-50 dark:bg-sky-900/30 border-sky-200 dark:border-sky-800/40',
    steps: [
      'Sign in at americanexpress.com and select your card',
      'Click the "Statements & Activity" tab',
      'Click "Download Transactions"',
      'Choose your date range (up to 2 years back)',
      'Select CSV as the file format',
      'Click Download',
    ],
  },
];

function CsvHelpAccordion() {
  const [open, setOpen]         = useState(false);
  const [activeBank, setActiveBank] = useState('chase');
  const bank = CSV_BANKS.find(b => b.id === activeBank);

  return (
    <div className="border border-slate-200 dark:border-slate-700 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
      >
        <div className="flex items-center gap-2 text-slate-600 dark:text-slate-300">
          <HelpCircle className="w-4 h-4 text-slate-400" />
          <span className="text-xs font-bold">How to export your CSV from your bank</span>
        </div>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
          : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
      </button>

      {open && (
        <div className="px-4 pb-4 pt-3 space-y-3">
          {/* Bank tabs */}
          <div className="flex gap-2">
            {CSV_BANKS.map(b => (
              <button
                key={b.id}
                onClick={() => setActiveBank(b.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-black border transition-all ${
                  activeBank === b.id
                    ? `${b.activeBg} ${b.color}`
                    : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-600 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                }`}
              >
                {b.name}
              </button>
            ))}
          </div>

          {/* Steps */}
          <ol className="space-y-2">
            {bank.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-3 text-xs">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-black mt-0.5 ${bank.activeBg} ${bank.color}`}>
                  {i + 1}
                </span>
                <span className="text-slate-600 dark:text-slate-300 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const STATUS_CONFIG = {
  new:            { label: 'New',           color: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',  dot: 'bg-emerald-500' },
  already_logged: { label: 'Already logged', color: 'bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400',           dot: 'bg-slate-400' },
  credit:         { label: 'Credit',         color: 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',          dot: 'bg-amber-500' },
  transfer:       { label: 'Transfer',       color: 'bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300',      dot: 'bg-violet-500' },
  cross_month:    { label: 'Other month',    color: 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',              dot: 'bg-blue-500' },
};

// ── Credit application helper ─────────────────────────────────────────────────

function applyCredit(amounts, creditAmount) {
  // Try to remove an exact-matching amount first
  const exactIdx = amounts.findIndex(a => Math.abs(a - creditAmount) < 0.01);
  if (exactIdx >= 0) return amounts.filter((_, i) => i !== exactIdx);
  // No exact match — subtract from total
  const newTotal = amounts.reduce((a, b) => a + b, 0) - creditAmount;
  return newTotal <= 0 ? [] : [parseFloat(newTotal.toFixed(2))];
}

function initDecisions(annotated) {
  const d = {};
  for (const tx of annotated) {
    if (tx.status === 'new')
      d[tx.id] = { action: 'import', vendor: tx.vendor, category: tx.suggestedCategory || 'Misc' };
    else if (tx.status === 'credit')
      d[tx.id] = { action: tx.matchedVendor ? 'apply' : 'ignore' };
    else if (tx.status === 'transfer')
      d[tx.id] = { action: 'skip', category: 'Misc' };
    else if (tx.status === 'cross_month')
      d[tx.id] = { action: 'skip', category: tx.suggestedCategory || 'Misc' };
  }
  return d;
}

export function ReconcileDialog({ monthName, sheetId, accessToken, onClose, onComplete, smartRules = [] }) {
  const [step, setStep]             = useState('upload'); // 'upload'|'deduping'|'deduped'|'review'|'importing'|'done'
  const [files, setFiles]           = useState([]);
  const [dragging, setDragging]     = useState(false);
  const [parsing, setParsing]       = useState(false);
  const [annotated, setAnnotated]   = useState([]);
  const [dedupError, setDedupError] = useState('');
  const [decisions, setDecisions]   = useState({});
  const [importProgress, setImportProgress] = useState({ current: 0, total: 0 });
  const [importSummary, setImportSummary]   = useState(null); // { imported, creditsApplied, skipped, failed }
  const fileInputRef                = useRef(null);

  const categories = useMemo(() => getAllCategoryNames(), []);

  const allTransactions = files.flatMap(f => f.result?.transactions || []);
  const hasAnyError     = files.some(f => f.result?.error);
  const hasFiles        = files.length > 0;
  const hasResults      = files.some(f => f.result && !f.result.error);

  const processFiles = useCallback(async (newFiles) => {
    setParsing(true);
    const parsed = await Promise.all(
      Array.from(newFiles).map(async file => {
        const text = await file.text();
        const result = parseStatementFile(text, file.name);
        return { file, result };
      })
    );
    setFiles(prev => {
      // Deduplicate by filename
      const existing = new Set(prev.map(f => f.file.name));
      const fresh = parsed.filter(p => !existing.has(p.file.name));
      return [...prev, ...fresh];
    });
    setParsing(false);
  }, []);

  const handleFileInput = (e) => {
    if (e.target.files?.length) processFiles(e.target.files);
    e.target.value = '';
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const csvFiles = Array.from(e.dataTransfer.files).filter(f =>
      f.name.toLowerCase().endsWith('.csv') || f.type === 'text/csv'
    );
    if (csvFiles.length) processFiles(csvFiles);
  };

  const removeFile = (fileName) =>
    setFiles(prev => prev.filter(f => f.file.name !== fileName));

  const handleContinue = async () => {
    setStep('deduping');
    setDedupError('');
    try {
      const result = await runDeduplication(allTransactions, sheetId, accessToken, monthName, smartRules);
      setAnnotated(result);
      setStep('deduped');
    } catch (e) {
      setDedupError(e.message || 'Failed to check existing transactions.');
      setStep('upload');
    }
  };

  const handleReview = () => {
    setDecisions(initDecisions(annotated));
    setStep('review');
  };

  const updateDecision = (id, patch) =>
    setDecisions(prev => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const setAllInGroup = (ids, action) =>
    setDecisions(prev => {
      const next = { ...prev };
      ids.forEach(id => { next[id] = { ...next[id], action }; });
      return next;
    });

  const handleConfirmImport = async () => {
    const actionable = annotated.filter(tx => {
      const d = decisions[tx.id];
      return d?.action === 'import' || d?.action === 'apply';
    });
    setImportProgress({ current: 0, total: actionable.length });
    setStep('importing');

    let imported = 0, creditsApplied = 0, skipped = 0, failed = 0;

    for (const tx of annotated) {
      const d = decisions[tx.id];
      if (!d || (d.action !== 'import' && d.action !== 'apply')) {
        skipped++;
        continue;
      }
      try {
        if (d.action === 'import') {
          const category = d.category || tx.suggestedCategory || 'Misc';
          const vendor   = (d.vendor || tx.vendor).trim();
          await addOrUpdateExpense(category, vendor, tx.amount, accessToken, sheetId, monthName, 'import');
          imported++;
        } else if (d.action === 'apply' && tx.matchedCategory && tx.matchedVendor) {
          const rows = await fetchDetailRows(tx.matchedCategory, accessToken, sheetId);
          const row  = rows.find(r => fuzzyNamesMatch(r.description, tx.matchedVendor));
          if (row) {
            const prevTotal  = row.amounts.reduce((a, b) => a + b, 0);
            const newAmounts = applyCredit(row.amounts, tx.amount);
            await updateVendorAmounts(tx.matchedCategory, row.rowIndex, newAmounts, accessToken, sheetId, tx.matchedVendor, prevTotal);
            creditsApplied++;
          } else {
            skipped++;
          }
        }
      } catch (e) {
        console.warn('Import failed for', tx.vendor, e);
        failed++;
      }
      setImportProgress(prev => ({ ...prev, current: prev.current + 1 }));
    }

    setImportSummary({ imported, creditsApplied, skipped, failed });
    setStep('done');
  };

  // Upload step summary counts
  const uploadCounts = {
    purchase: allTransactions.filter(t => t.type === 'purchase').length,
    credit:   allTransactions.filter(t => t.type === 'credit').length,
    transfer: allTransactions.filter(t => t.type === 'transfer').length,
  };

  // Dedup step summary counts
  const dedupCounts = Object.fromEntries(
    Object.keys(STATUS_CONFIG).map(s => [s, annotated.filter(t => t.status === s).length])
  );

  // Review step groups
  const newTxs        = annotated.filter(t => t.status === 'new');
  const creditTxs     = annotated.filter(t => t.status === 'credit');
  const transferTxs   = annotated.filter(t => t.status === 'transfer');
  const crossTxs      = annotated.filter(t => t.status === 'cross_month');
  const loggedTxs     = annotated.filter(t => t.status === 'already_logged');

  const importCount = Object.values(decisions).filter(d =>
    d.action === 'import' || d.action === 'apply'
  ).length;

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
        <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-lg border border-slate-100 dark:border-slate-700 overflow-hidden max-h-[90vh] flex flex-col">
          <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />

          {/* Header */}
          <div className="flex items-center justify-between px-6 pt-6 pb-5 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
            <div>
              <p className="text-base font-black text-slate-800 dark:text-slate-100">Reconcile {monthName}</p>
              <p className="text-xs text-slate-400 mt-0.5">Upload bank statements to match against your logged expenses</p>
            </div>
            <button onClick={onClose} className="p-2 rounded-xl text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

            {/* ── Step: deduping ── */}
            {step === 'deduping' && (
              <div className="flex flex-col items-center justify-center py-16 gap-5">
                <RefreshCw className="w-10 h-10 text-indigo-400 animate-spin" />
                <div className="text-center">
                  <p className="text-base font-black text-slate-700 dark:text-slate-200">Checking your logged expenses…</p>
                  <p className="text-xs text-slate-400 mt-1">Comparing {allTransactions.length} bank transactions against your sheets</p>
                </div>
              </div>
            )}

            {/* ── Step: deduped summary ── */}
            {step === 'deduped' && (
              <div className="space-y-3">
                <p className="text-xs font-black uppercase tracking-widest text-slate-400">Results</p>
                {Object.entries(STATUS_CONFIG).map(([status, cfg]) => {
                  const count = dedupCounts[status] || 0;
                  if (count === 0) return null;
                  return (
                    <div key={status} className="flex items-center justify-between bg-slate-50 dark:bg-slate-700/50 rounded-2xl px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
                        <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{cfg.label}</span>
                      </div>
                      <span className={`text-xs font-black px-2.5 py-1 rounded-full ${cfg.color}`}>{count}</span>
                    </div>
                  );
                })}
                {dedupCounts.already_logged > 0 && (
                  <p className="text-xs text-slate-400 px-1">
                    {dedupCounts.already_logged} transaction{dedupCounts.already_logged !== 1 ? 's' : ''} already in your sheets — will be skipped automatically.
                  </p>
                )}
              </div>
            )}

            {/* ── Step: importing ── */}
            {step === 'importing' && (
              <div className="flex flex-col items-center justify-center py-16 gap-5">
                <RefreshCw className="w-10 h-10 text-indigo-400 animate-spin" />
                <div className="text-center">
                  <p className="text-base font-black text-slate-700 dark:text-slate-200">Importing…</p>
                  <p className="text-xs text-slate-400 mt-1">{importProgress.current} of {importProgress.total} done</p>
                </div>
                {/* Progress bar */}
                <div className="w-48 h-1.5 bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-300"
                    style={{ width: importProgress.total > 0 ? `${(importProgress.current / importProgress.total) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            )}

            {/* ── Step: done ── */}
            {step === 'done' && importSummary && (
              <div className="flex flex-col items-center py-10 gap-6">
                <div className="w-16 h-16 bg-emerald-100 dark:bg-emerald-900/30 rounded-2xl flex items-center justify-center">
                  <CheckCircle2 className="w-8 h-8 text-emerald-500" />
                </div>
                <div className="text-center">
                  <p className="text-lg font-black text-slate-800 dark:text-slate-100">Reconciliation complete</p>
                  <p className="text-sm text-slate-400 mt-1">{monthName}</p>
                </div>
                <div className="w-full space-y-2">
                  {importSummary.imported > 0 && (
                    <div className="flex items-center justify-between bg-emerald-50 dark:bg-emerald-900/20 rounded-2xl px-4 py-3">
                      <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300">Transactions imported</span>
                      <span className="text-sm font-black text-emerald-700 dark:text-emerald-300">{importSummary.imported}</span>
                    </div>
                  )}
                  {importSummary.creditsApplied > 0 && (
                    <div className="flex items-center justify-between bg-amber-50 dark:bg-amber-900/20 rounded-2xl px-4 py-3">
                      <span className="text-sm font-bold text-amber-700 dark:text-amber-300">Credits applied</span>
                      <span className="text-sm font-black text-amber-700 dark:text-amber-300">{importSummary.creditsApplied}</span>
                    </div>
                  )}
                  {importSummary.skipped > 0 && (
                    <div className="flex items-center justify-between bg-slate-50 dark:bg-slate-700/50 rounded-2xl px-4 py-3">
                      <span className="text-sm font-bold text-slate-500 dark:text-slate-400">Skipped</span>
                      <span className="text-sm font-black text-slate-500 dark:text-slate-400">{importSummary.skipped}</span>
                    </div>
                  )}
                  {importSummary.failed > 0 && (
                    <div className="flex items-center justify-between bg-rose-50 dark:bg-rose-900/20 rounded-2xl px-4 py-3">
                      <span className="text-sm font-bold text-rose-600 dark:text-rose-400">Failed (check console)</span>
                      <span className="text-sm font-black text-rose-600 dark:text-rose-400">{importSummary.failed}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Step: review ── */}
            {step === 'review' && (
              <div className="space-y-3">
                {/* Summary pill */}
                <div className="flex items-center justify-between bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/40 rounded-2xl px-4 py-2.5">
                  <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                    {importCount} transaction{importCount !== 1 ? 's' : ''} will be imported
                  </span>
                  {loggedTxs.length > 0 && (
                    <span className="text-xs text-slate-400">{loggedTxs.length} already logged — skipped</span>
                  )}
                </div>

                {/* New transactions */}
                <ReviewSection
                  title="New transactions" count={newTxs.length} dot="bg-emerald-500" defaultOpen
                  onSelectAll={() => setAllInGroup(newTxs.map(t => t.id), 'import')}
                  onSkipAll={()   => setAllInGroup(newTxs.map(t => t.id), 'skip')}
                >
                  {newTxs.map(tx => (
                    <NewRow key={tx.id} tx={tx} decision={decisions[tx.id]}
                      onChange={p => updateDecision(tx.id, p)} categories={categories} />
                  ))}
                </ReviewSection>

                {/* Credits */}
                <ReviewSection title="Credits / Refunds" count={creditTxs.length} dot="bg-amber-500" defaultOpen>
                  {creditTxs.map(tx => (
                    <CreditRow key={tx.id} tx={tx} decision={decisions[tx.id]}
                      onChange={p => updateDecision(tx.id, p)} />
                  ))}
                </ReviewSection>

                {/* Transfers */}
                <ReviewSection
                  title="Transfers / Payments" count={transferTxs.length} dot="bg-violet-500" defaultOpen
                  onSkipAll={() => setAllInGroup(transferTxs.map(t => t.id), 'skip')}
                >
                  {transferTxs.map(tx => (
                    <TransferRow key={tx.id} tx={tx} decision={decisions[tx.id]}
                      onChange={p => updateDecision(tx.id, p)} categories={categories} />
                  ))}
                </ReviewSection>

                {/* Cross-month */}
                <ReviewSection
                  title="Other month" count={crossTxs.length} dot="bg-blue-500" defaultOpen
                  onSkipAll={() => setAllInGroup(crossTxs.map(t => t.id), 'skip')}
                >
                  {crossTxs.map(tx => (
                    <CrossMonthRow key={tx.id} tx={tx} decision={decisions[tx.id]}
                      onChange={p => updateDecision(tx.id, p)} categories={categories} />
                  ))}
                </ReviewSection>

                {/* Already logged — collapsed by default */}
                <ReviewSection title="Already logged" count={loggedTxs.length} dot="bg-slate-400" defaultOpen={false}>
                  {loggedTxs.map(tx => (
                    <div key={tx.id} className="px-4 py-3 flex items-center justify-between opacity-50">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-slate-600 dark:text-slate-400 truncate">{tx.matchedVendor || tx.vendor}</p>
                        <p className="text-xs text-slate-400">{tx.matchedCategory} · {formatDate(tx.date)}</p>
                      </div>
                      <span className="text-sm font-black text-slate-500 tabular-nums">${tx.amount.toFixed(2)}</span>
                    </div>
                  ))}
                </ReviewSection>
              </div>
            )}

            {/* ── Step: upload ── */}
            {step === 'upload' && (
              <>
                {/* Privacy notice */}
                <div className="flex items-start gap-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800/40 rounded-2xl px-4 py-3">
                  <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-emerald-700 dark:text-emerald-300 font-medium leading-relaxed">
                    Your files are read <strong>locally in your browser</strong> and never uploaded to any server. Nothing leaves your device.
                  </p>
                </div>

                {/* How to export CSV — collapsible */}
                <CsvHelpAccordion />

                {/* Drop zone */}
                <div
                  onDragOver={e => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`relative border-2 border-dashed rounded-2xl p-8 text-center cursor-pointer transition-all ${
                    dragging
                      ? 'border-indigo-400 bg-indigo-50 dark:bg-indigo-900/20'
                      : 'border-slate-200 dark:border-slate-600 hover:border-indigo-300 dark:hover:border-indigo-600 hover:bg-slate-50 dark:hover:bg-slate-700/30'
                  }`}
                >
                  <input ref={fileInputRef} type="file" accept=".csv,text/csv" multiple onChange={handleFileInput} className="sr-only" />
                  <Upload className={`w-8 h-8 mx-auto mb-3 transition-colors ${dragging ? 'text-indigo-500' : 'text-slate-300 dark:text-slate-600'}`} />
                  <p className="text-sm font-bold text-slate-600 dark:text-slate-300">
                    Drop CSV files here, or <span className="text-indigo-500">browse</span>
                  </p>
                  <p className="text-xs text-slate-400 mt-1.5">Chase, Amex, or any bank CSV · Multiple files supported</p>
                  {parsing && (
                    <div className="absolute inset-0 bg-white/70 dark:bg-slate-800/70 rounded-2xl flex items-center justify-center">
                      <p className="text-sm font-bold text-indigo-500 animate-pulse">Parsing…</p>
                    </div>
                  )}
                </div>

                {/* File list */}
                {hasFiles && (
                  <div className="space-y-2">
                    {files.map(({ file, result }) => (
                      <FileRow
                        key={file.name}
                        file={file}
                        result={result}
                        onRemove={() => removeFile(file.name)}
                      />
                    ))}
                  </div>
                )}

                {/* Summary bar */}
                {hasResults && (
                  <div className="bg-slate-50 dark:bg-slate-700/50 rounded-2xl px-4 py-3 flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                      <span className="text-sm font-black text-slate-700 dark:text-slate-200">
                        {allTransactions.length} transactions across {files.filter(f => !f.result?.error).length} file{files.filter(f => !f.result?.error).length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs font-bold">
                      <span className="text-emerald-600 dark:text-emerald-400">{uploadCounts.purchase} purchases</span>
                      {uploadCounts.credit > 0   && <span className="text-amber-600 dark:text-amber-400">{uploadCounts.credit} credits</span>}
                      {uploadCounts.transfer > 0 && <span className="text-violet-600 dark:text-violet-400">{uploadCounts.transfer} transfers</span>}
                    </div>
                  </div>
                )}

                {dedupError && (
                  <div className="flex items-center gap-2 text-rose-500 text-xs font-bold">
                    <AlertCircle className="w-4 h-4 flex-shrink-0" /> {dedupError}
                  </div>
                )}
              </>
            )}

          </div>

          {/* Footer */}
          <div className="px-6 pb-6 flex gap-3 flex-shrink-0 border-t border-slate-100 dark:border-slate-700 pt-4"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>
            {step === 'importing' ? (
              <div className="flex-1 py-3 text-center text-xs text-slate-400 font-medium">Please wait…</div>
            ) : step === 'done' ? (
              <button
                onClick={() => { onComplete?.(); onClose(); }}
                className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 transition-all shadow-lg">
                Done — refresh dashboard
              </button>
            ) : step === 'deduping' ? (
              <div className="flex-1 py-3 text-center text-xs text-slate-400 font-medium">Please wait…</div>
            ) : step === 'deduped' ? (
              <>
                <button onClick={() => setStep('upload')}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  ← Back
                </button>
                <button onClick={handleReview}
                  disabled={dedupCounts.new === 0 && dedupCounts.credit === 0 && dedupCounts.transfer === 0 && dedupCounts.cross_month === 0}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
                  Review → {(dedupCounts.new + dedupCounts.credit + dedupCounts.transfer + dedupCounts.cross_month) > 0
                    ? `(${dedupCounts.new + dedupCounts.credit + dedupCounts.transfer + dedupCounts.cross_month})`
                    : ''}
                </button>
              </>
            ) : step === 'review' ? (
              <>
                <button onClick={() => setStep('deduped')}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  ← Back
                </button>
                <button onClick={handleConfirmImport} disabled={importCount === 0}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
                  Import {importCount > 0 ? `${importCount} transaction${importCount !== 1 ? 's' : ''}` : ''} →
                </button>
              </>
            ) : (
              <>
                <button onClick={onClose}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                  Cancel
                </button>
                <button onClick={handleContinue} disabled={!hasResults}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-lg">
                  Check against sheets → {allTransactions.length > 0 ? `(${allTransactions.length})` : ''}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
