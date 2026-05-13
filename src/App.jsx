import React, { useState, useMemo, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import {
  TrendingDown, TrendingUp, Wallet, Banknote, Receipt,
} from 'lucide-react';
import { useSheetData } from './useSheetData.js';
import { use503020 } from './use503020.js';
import { hasDetail } from './fetchDetail.js';
import { fetchDetailRows, updateCategoryBudget, writeSalary, fetchNonMonthlyItems, migrateNonMonthlyFromI4 } from './sheetsApi.js';
import { getCurrencySymbol } from './currency.js';
import { useAuth } from './useAuth.js';
import { useOfflineSync } from './useOfflineSync.js';
import { useDragSort } from './useDragSort.js';
import { useMonths } from './useMonths.js';
import { useSettings, DEFAULT_CATEGORY_ORDER } from './useSettings.js';
import { useMessages } from './useMessages.js';
import { usePush } from './usePush.js';
import { DEFAULT_ICONS, EMOJI_DATA } from './categoryIcons.js';
import { usePinLock, PinLockScreen } from './PinLock.jsx';
import { LoginScreen } from './LoginScreen.jsx';
import { ReceiptScanButton } from './ReceiptScanner.jsx';
import { BudgetRules } from './BudgetRules.jsx';

// Heavy components — loaded only when first rendered
const DetailPanel      = lazy(() => import('./DetailPanel.jsx').then(m => ({ default: m.DetailPanel })));
const AddExpenseDialog = lazy(() => import('./AddExpenseDialog.jsx').then(m => ({ default: m.AddExpenseDialog })));
const NewMonthDialog   = lazy(() => import('./NewMonthDialog.jsx').then(m => ({ default: m.NewMonthDialog })));
const ChatAgent        = lazy(() => import('./ChatAgent.jsx').then(m => ({ default: m.ChatAgent })));
import { HistoryTab } from './HistoryTab.jsx';
import { LedgerTab } from './LedgerTab.jsx';
const SettingsPanel    = lazy(() => import('./SettingsPanel.jsx').then(m => ({ default: m.SettingsPanel })));
const AddCategoryDialog    = lazy(() => import('./AddCategoryDialog.jsx').then(m => ({ default: m.AddCategoryDialog })));
const ReconcileDialog      = lazy(() => import('./ReconcileDialog.jsx').then(m => ({ default: m.ReconcileDialog })));
const BulkRecurringDialog  = lazy(() => import('./BulkRecurringDialog.jsx').then(m => ({ default: m.BulkRecurringDialog })));
const DeleteCategoryDialog = lazy(() => import('./DeleteCategoryDialog.jsx').then(m => ({ default: m.DeleteCategoryDialog })));
const RenameCategoryDialog = lazy(() => import('./RenameCategoryDialog.jsx').then(m => ({ default: m.RenameCategoryDialog })));
import { StatCard } from './StatCard.jsx';
import { IconPickerModal } from './IconPickerModal.jsx';
import { CategoryActionSheet } from './CategoryActionSheet.jsx';
import { SpeedDial } from './SpeedDial.jsx';
import { OnboardingWizard } from './OnboardingWizard.jsx';
import { ExpenseTable } from './ExpenseTable.jsx';
import { DonutChart } from './DonutChart.jsx';
import { BudgetBarsChart } from './BudgetBarsChart.jsx';
import { InsightCards } from './InsightCards.jsx';
import { DeleteMonthDialog } from './DeleteMonthDialog.jsx';
import { MonthPickerBar } from './MonthPickerBar.jsx';
import { HeaderBar } from './HeaderBar.jsx';

function App() {
  const { user, denied, loadingAuth, onGoogleSuccess, onGoogleError, signOut, sessionExpired, setSessionExpired } = useAuth();

  if (!user) {
    return <LoginScreen onSuccess={onGoogleSuccess} onError={onGoogleError} loading={loadingAuth} denied={denied} />;
  }

  return <Dashboard user={user} signOut={signOut} sessionExpired={sessionExpired} setSessionExpired={setSessionExpired} onGoogleSuccess={onGoogleSuccess} />;
}

function Dashboard({ user, signOut, sessionExpired, setSessionExpired, onGoogleSuccess }) {
  const pinLock = usePinLock(signOut);
  const { months, loading: monthsLoading, createMonth, deleteMonth, shareAllMonths } = useMonths(user.accessToken);
  const [showNewMonth, setShowNewMonth] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // month to delete
  const [deleteInput, setDeleteInput] = useState('');

  // Default to the last month in the list (most recent), fallback to env var
  const defaultSheetId = import.meta.env.VITE_SHEET_ID;
  const [selectedSheetId, setSelectedSheetId] = useState(defaultSheetId);

  // Compute current month label from system clock
  const currentMonthLabel = useMemo(() => {
    const now = new Date();
    return `${now.toLocaleString('en-US', { month: 'long' })} ${now.getFullYear()}`;
  }, []);

  // When months load, auto-select the current month/year, fallback to most recent
  useEffect(() => {
    if (months.length === 0) return;
    const match = months.find(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());
    setSelectedSheetId(match ? match.sheetId : months[months.length - 1].sheetId);
  }, [months, currentMonthLabel]);

  const selectedMonth = months.find(m => m.sheetId === selectedSheetId);

  // True when the selected month is in the past (reconciliation is only for ended months)
  const isMonthEnded = useMemo(() => {
    if (!selectedMonth) return false;
    const monthStart = new Date(`${selectedMonth.name} 1`);
    const now = new Date();
    return monthStart < new Date(now.getFullYear(), now.getMonth(), 1);
  }, [selectedMonth]);

  const currentMonthMissing = !monthsLoading && months.length > 0 &&
    !months.some(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());

  const { data: liveData, loading, error, lastUpdated, refresh } = useSheetData(selectedSheetId, user.accessToken);
  const { data: rulesData, loading: rulesLoading } = use503020(selectedSheetId, user.accessToken);
  const [data, setData] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', amount: '', remaining: '' });
  const [activeTab, setActiveTab] = useState('budget'); // 'budget' | 'history' | 'ledger'
  const scanTriggerRef = useRef(null);
  const [detail, setDetail] = useState(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [renamingCategory, setRenamingCategory] = useState(null);
  const [deletingCategory, setDeletingCategory] = useState(null);
  const [categoryActionFor, setCategoryActionFor] = useState(null); // mobile ⋯ action sheet
  const [editingBudgetId, setEditingBudgetId] = useState(null);
  const [budgetDraft, setBudgetDraft] = useState('');
  const [editingSalary, setEditingSalary] = useState(false);
  const [salaryDraft, setSalaryDraft] = useState('');
  const [iconPickerFor, setIconPickerFor] = useState(null);
  const [showUserMenu, setShowUserMenu]     = useState(false);
  const [showReconcile, setShowReconcile]       = useState(false);
  const [showBulkRecurring, setShowBulkRecurring] = useState(false);
  const [showMessages, setShowMessages]         = useState(false);
  const [chatOpen, setChatOpen]   = useState(false);
  const [fabOpen, setFabOpen]     = useState(false);
  const userMenuRef = useRef(null);

  // Per-user settings (saved to Google Sheets)
  const isReadOnly = user.role === 'viewer';
  const { settings, updateSettings } = useSettings(user.email, user.accessToken);
  const currencySymbol = getCurrencySymbol(settings.currency || 'USD');
  const categoryIcons  = { ...DEFAULT_ICONS, ...(settings.categoryIcons || {}) };

  // Theme — driven by settings.theme, with a quick-toggle override stored locally
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved) return saved === 'dark';
    return true;
  });

  // Sync theme when settings.theme changes
  useEffect(() => {
    if (!settings.theme || settings.theme === 'system') return;
    const dark = settings.theme === 'dark';
    setIsDark(dark);
  }, [settings.theme]);

  // Font size applied to <html>
  useEffect(() => {
    const sizes = { sm: '14px', base: '16px', lg: '18px' };
    document.documentElement.style.fontSize = sizes[settings.fontSize] || '16px';
  }, [settings.fontSize]);

  // Accent color — injects a <style> block that overrides every indigo-* class
  useEffect(() => {
    // Each scheme: [600, 700, 500, 400, 50(light), 900/30(dark bg), shadow-rgb, 300(border)]
    const SCHEMES = {
      default: { c600:'#4f46e5', c700:'#4338ca', c500:'#6366f1', c400:'#818cf8', c50:'#eef2ff', cdark:'rgba(99,102,241,0.2)',  cshadow:'rgba(99,102,241,0.25)',  c300:'#a5b4fc' },
      rose:    { c600:'#e11d48', c700:'#be123c', c500:'#f43f5e', c400:'#fb7185', c50:'#fff1f2', cdark:'rgba(225,29,72,0.2)',   cshadow:'rgba(225,29,72,0.25)',   c300:'#fda4af' },
      emerald: { c600:'#059669', c700:'#047857', c500:'#10b981', c400:'#34d399', c50:'#ecfdf5', cdark:'rgba(5,150,105,0.2)',   cshadow:'rgba(5,150,105,0.25)',   c300:'#6ee7b7' },
      amber:   { c600:'#d97706', c700:'#b45309', c500:'#f59e0b', c400:'#fbbf24', c50:'#fffbeb', cdark:'rgba(217,119,6,0.2)',   cshadow:'rgba(217,119,6,0.25)',   c300:'#fcd34d' },
      sky:     { c600:'#0284c7', c700:'#0369a1', c500:'#0ea5e9', c400:'#38bdf8', c50:'#f0f9ff', cdark:'rgba(2,132,199,0.2)',   cshadow:'rgba(2,132,199,0.25)',   c300:'#7dd3fc' },
      violet:  { c600:'#7c3aed', c700:'#6d28d9', c500:'#8b5cf6', c400:'#a78bfa', c50:'#f5f3ff', cdark:'rgba(124,58,237,0.2)',  cshadow:'rgba(124,58,237,0.25)',  c300:'#c4b5fd' },
    };
    const s = SCHEMES[settings.colorScheme] || SCHEMES.default;
    let el = document.getElementById('accent-override');
    if (!el) { el = document.createElement('style'); el.id = 'accent-override'; document.head.appendChild(el); }
    el.textContent = `
      .bg-indigo-600, .dark\\:bg-indigo-700  { background-color: ${s.c600} !important; }
      .hover\\:bg-indigo-700:hover           { background-color: ${s.c700} !important; }
      .bg-indigo-50, .dark\\:bg-indigo-900\\/20, .dark\\:bg-indigo-900\\/30 { background-color: ${s.c50} !important; }
      .text-indigo-600, .dark\\:text-indigo-400 { color: ${s.c600} !important; }
      .text-indigo-500                       { color: ${s.c500} !important; }
      .text-indigo-400                       { color: ${s.c400} !important; }
      .border-indigo-300, .dark\\:border-indigo-600 { border-color: ${s.c300} !important; }
      .ring-indigo-500\\/40, .focus\\:ring-indigo-500\\/40:focus { --tw-ring-color: ${s.cshadow} !important; }
      .shadow-indigo-200, .dark\\:shadow-indigo-900\\/30 { --tw-shadow-color: ${s.cshadow} !important; }
      .hover\\:text-indigo-500:hover, .hover\\:text-indigo-600:hover, .dark\\:hover\\:text-indigo-400:hover { color: ${s.c500} !important; }
      .hover\\:bg-indigo-50:hover, .dark\\:hover\\:bg-indigo-900\\/30:hover { background-color: ${s.cdark} !important; }
      .bg-indigo-500 { background-color: ${s.c500} !important; }
      .text-indigo-100 { color: ${s.c50} !important; }
      .text-indigo-300 { color: ${s.c300} !important; }
      .bg-indigo-100\\/50 { background-color: ${s.cdark} !important; }
      .dark\\:bg-indigo-900\\/40 { background-color: ${s.cdark} !important; }
      .hover\\:border-indigo-300:hover, .dark\\:hover\\:border-indigo-600:hover { border-color: ${s.c300} !important; }
    `;
  }, [settings.colorScheme]);


  // Close user menu on outside click
  useEffect(() => {
    if (!showUserMenu) return;
    const handler = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setShowUserMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showUserMenu]);

  // Global keyboard shortcuts — driven by settings.keyboardShortcuts
  useEffect(() => {
    const shortcuts = settings.keyboardShortcuts || {};
    const matches = (e, combo) => {
      if (!combo) return false;
      const parts = combo.toLowerCase().split('+');
      const key   = parts[parts.length - 1];
      return (
        e.key.toLowerCase() === key &&
        e.ctrlKey  === parts.includes('ctrl') &&
        e.shiftKey === parts.includes('shift') &&
        e.altKey   === parts.includes('alt') &&
        e.metaKey  === parts.includes('meta')
      );
    };
    const handler = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (matches(e, shortcuts.addExpense))   { e.preventDefault(); setShowAddDialog(true);      return; }
      if (matches(e, shortcuts.scanReceipt))  { e.preventDefault(); scanTriggerRef.current?.();  return; }
      if (matches(e, shortcuts.openSettings)) { e.preventDefault(); setShowSettings(true);        return; }
      if (matches(e, shortcuts.openChat))     { e.preventDefault(); setChatOpen(true);            return; }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [settings.keyboardShortcuts]);

  // Global Escape key — closes the topmost open panel
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      if (fabOpen)                { setFabOpen(false);           return; }
      if (chatOpen)               { setChatOpen(false);          return; }
      if (iconPickerFor)          { setIconPickerFor(null);      return; }
      if (categoryActionFor)      { setCategoryActionFor(null);  return; }
      if (deletingCategory)       { setDeletingCategory(null);   return; }
      if (renamingCategory)       { setRenamingCategory(null);   return; }
      if (editingSalary)          { setEditingSalary(false);     return; }
      if (editingBudgetId !== null){ setEditingBudgetId(null);   return; }
      if (showAddCategory)        { setShowAddCategory(false);   return; }
      if (showAddDialog)          { setShowAddDialog(false);     return; }
      if (deleteConfirm)          { setDeleteConfirm(null);      return; }
      if (showNewMonth)           { setShowNewMonth(false);      return; }
      if (detail)                 { setDetail(null);             return; }
      if (showSettings)           { setShowSettings(false);      return; }
      if (showUserMenu)           { setShowUserMenu(false);      return; }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [fabOpen, chatOpen, iconPickerFor, categoryActionFor, deletingCategory, renamingCategory, editingSalary, editingBudgetId,
      showAddCategory, showAddDialog, deleteConfirm, showNewMonth, detail, showSettings, showUserMenu]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    // Keep settings in sync when the quick-toggle is used
    updateSettings(prev => ({ ...prev, theme: isDark ? 'dark' : 'light' }));
  }, [isDark]);

  useEffect(() => {
    if (liveData) setData(liveData);
  }, [liveData]);

  const updateItem = (index, rowValues) =>
    setData(prev => prev.map(d => d.index_ === index ? { ...d, row: [...rowValues, ...d.row.slice(rowValues.length)] } : d));
  const deleteItem = (index) => setData(prev => prev.filter(d => d.index_ !== index));
  const insertItem = (_, rowValues) => {
    const newIndex = Math.max(...data.map(d => d.index_)) + 1;
    setData(prev => [...prev, { index_: newIndex, row: rowValues }]);
  };

  const findRowByLabel = (label, colIndex = 0) => data.find(d => d.row[colIndex] === label);

  const salaryReceived = parseFloat(findRowByLabel('Salary Received', 5)?.row[6]) || 0;
  const nonRecurringRow = data.find(d => typeof d.row[8] === 'string' && d.row[8].includes('Balance without random'));
  const nonRecurringRemaining = parseFloat(nonRecurringRow?.row[9]) || 0;
  const potentialDiffRow = findRowByLabel('Difference between budgeted and actual spent', 8);
  const potentialDifference = parseFloat(potentialDiffRow?.row[9]) || 0;
  const notesRow = findRowByLabel('Left from Salary for the Month', 5);


  const expenses = useMemo(() => {
    const order = settings.categoryOrder || DEFAULT_CATEGORY_ORDER;
    const orderMap = Object.fromEntries(order.map((name, i) => [name, i]));
    return data
      .filter(d => {
        const name = d.row[0];
        return name && name !== 'Expense' && name !== 'Total Expenses' && name !== 'Moving Exp' && typeof name === 'string' && name.trim() !== '';
      })
      .map(d => {
        const actual = parseFloat(d.row[1]) || 0;
        const remaining = parseFloat(d.row[2]) || 0;
        return { index_: d.index_, name: d.row[0], actual, remaining, budget: actual + remaining };
      })
      .sort((a, b) => (orderMap[a.name] ?? 999) - (orderMap[b.name] ?? 999));
  }, [data, settings.categoryOrder]);

  const { tableDragOver, tableDragging, handleTableDragStart, handleTableDragOver, handleTableDrop, handleTableDragEnd, handleGripTouchStart } = useDragSort({ expenses, settings, updateSettings, isDark });

  const totalActual = expenses.reduce((s, d) => s + d.actual, 0);
  const totalBudget = expenses.reduce((s, d) => s + d.budget, 0);
  const overallRemaining = totalBudget - totalActual;

  // ── Non-monthly expenses (sheet-backed) ──────────────────────────────────────
  const [nonMonthlyItems, setNonMonthlyItems] = useState([]);
  const [nonMonthlyTick, setNonMonthlyTick]   = useState(0);
  const refreshNonMonthly = useCallback(() => setNonMonthlyTick(t => t + 1), []);
  const migratedSheets = useRef(new Set());
  useEffect(() => {
    if (!selectedSheetId || !user.accessToken) return;
    let cancelled = false;
    (async () => {
      try {
        let items = await fetchNonMonthlyItems(selectedSheetId, user.accessToken);
        // One-time migration from legacy I4 cell for months that predate this feature
        if (items.length === 0 && !migratedSheets.current.has(selectedSheetId)) {
          migratedSheets.current.add(selectedSheetId);
          await migrateNonMonthlyFromI4(selectedSheetId, user.accessToken);
          items = await fetchNonMonthlyItems(selectedSheetId, user.accessToken);
        }
        if (!cancelled) setNonMonthlyItems(items);
      } catch {
        if (!cancelled) setNonMonthlyItems([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSheetId, user.accessToken, nonMonthlyTick]);

  const nonMonthlyTotal = nonMonthlyItems.reduce((s, r) => s + r.amount, 0);
  // "What would the balance be if we hadn't made these one-off purchases?"
  const balanceWithoutNonMonthly = overallRemaining + nonMonthlyTotal;

  // ── Online / Offline ──────────────────────────────────────────────────────────
  const { isOnline } = useOfflineSync({ user, selectedSheetId, refresh, setSessionExpired });

  // ── Messages ──────────────────────────────────────────────────────────────────
  const { messages, unreadCount, markAllRead, dismissMessage, clearAll: clearMessages } =
    useMessages(settings, updateSettings, expenses, totalActual, salaryReceived, selectedMonth?.name);

  // ── Push notifications ────────────────────────────────────────────────────────
  const pushHook = usePush(user.email, settings.pushHour ?? 20);

  // Fire instant push for new budget threshold alerts
  useEffect(() => {
    if (!pushHook.subscribed) return;
    const alertMessages = messages.filter(m =>
      !m.read && (m.type === 'over_budget' || m.type === 'near_budget')
    );
    if (alertMessages.length === 0) return;
    alertMessages.forEach(m => {
      fetch('/api/push-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email, title: m.title, body: m.body }),
      }).catch(() => {});
    });
  }, [messages, pushHook.subscribed]);

  const handleUpdate = (index, name, actual, remaining) => {
    updateItem(index, [name, parseFloat(actual) || 0, parseFloat(remaining) || 0]);
    setEditingId(null);
  };

  const handleInsert = () => {
    if (!newItem.name) return;
    insertItem(undefined, [newItem.name, parseFloat(newItem.amount) || 0, parseFloat(newItem.remaining) || 0]);
    setNewItem({ name: '', amount: '', remaining: '' });
    setIsAdding(false);
  };

  const handleExpenseClick = async (name) => {
    if (!hasDetail(name)) return;
    setDetail({ expense: name, rows: null, loading: true });
    try {
      const rows = await fetchDetailRows(name, user.accessToken, selectedSheetId);
      setDetail({ expense: name, rows, loading: false });
    } catch {
      setDetail({ expense: name, rows: [], loading: false });
    }
  };

  const handleDetailRefresh = async () => {
    if (!detail) return;
    try {
      const rows = await fetchDetailRows(detail.expense, user.accessToken, selectedSheetId);
      setDetail(d => ({ ...d, rows, loading: false }));
      refresh();
    } catch {
      // keep existing rows on failure
    }
  };

  const handleSaveBudget = async (item) => {
    const newBudget = parseFloat(budgetDraft);
    if (isNaN(newBudget) || newBudget < 0) { setEditingBudgetId(null); return; }
    try {
      await updateCategoryBudget(selectedSheetId, user.accessToken, {
        rowNum: item.index_ + 1,
        budget: newBudget,
        categoryName: item.name,
      });
      refresh();
    } catch (e) {
      alert(`Failed to update budget: ${e.message}`);
    } finally {
      setEditingBudgetId(null);
    }
  };

  const handleSaveSalary = async () => {
    const newSalary = parseFloat(salaryDraft);
    if (isNaN(newSalary) || newSalary < 0) { setEditingSalary(false); return; }
    try {
      await writeSalary(selectedSheetId, newSalary, user.accessToken);
      refresh();
    } catch (e) {
      alert(`Failed to update salary: ${e.message}`);
    } finally {
      setEditingSalary(false);
    }
  };

  const handleSetIcon = (categoryName, emoji) => {
    updateSettings(prev => ({
      ...prev,
      categoryIcons: { ...(prev.categoryIcons || {}), [categoryName]: emoji },
    }));
    setIconPickerFor(null);
  };

  // Sorted by actual desc — shared order for donut + legend so colours always match




  return (
    <div className="min-h-screen bg-slate-100 dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans p-4 lg:p-8 transition-colors duration-300"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)',
        paddingLeft: 'calc(env(safe-area-inset-left) + 1rem)',
        paddingRight: 'calc(env(safe-area-inset-right) + 1rem)',
      }}
    >
      <div className="max-w-7xl mx-auto space-y-8 pb-12">

        {/* Read-only banner */}
        {isReadOnly && (
          <div className="flex items-center gap-3 px-4 py-3 bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-700/40 rounded-2xl text-sm font-bold text-violet-800 dark:text-violet-300">
            <span className="text-base">👁</span>
            View-only mode — you can browse but not make changes
          </div>
        )}

        {/* Offline banner */}
        {!isOnline && (
          <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl text-sm font-bold text-amber-800 dark:text-amber-300">
            <span className="text-base">📶</span>
            You're offline — changes will sync when reconnected
          </div>
        )}

        {/* Session expired banner */}
        {isOnline && sessionExpired && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-700/40 rounded-2xl">
            <span className="text-sm font-bold text-rose-700 dark:text-rose-300">Session expired — sign back in to sync changes</span>
            <button
              onClick={() => setSessionExpired(false)}
              className="text-xs font-bold text-rose-500 hover:text-rose-700 dark:hover:text-rose-200 transition-colors"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Page title */}
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
            Budget Dashboard
          </h1>
          {selectedMonth?.name && (
            <p className="text-sm sm:text-base font-semibold text-slate-400 dark:text-slate-500 mt-1 tracking-wide">
              {selectedMonth.name}
            </p>
          )}
        </div>

        {/* Month picker bar */}
        <MonthPickerBar
          selectedSheetId={selectedSheetId}
          setSelectedSheetId={setSelectedSheetId}
          monthsLoading={monthsLoading}
          months={months}
          selectedMonth={selectedMonth}
          onNewMonth={() => setShowNewMonth(true)}
          onDeleteMonth={() => { setDeleteConfirm(selectedMonth); setDeleteInput(''); }}
        />

        {/* Tab switcher */}
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-fit border border-slate-200 dark:border-slate-700">
          {[['budget', 'Dashboard'], ['ledger', 'Ledger'], ['history', 'History']].map(([tab, label]) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2 rounded-xl text-sm font-black transition-all ${
                activeTab === tab
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Missing current month banner */}
        {currentMonthMissing && (
          <div className="flex items-center justify-between gap-4 px-5 py-3.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl">
            <div className="flex items-center gap-3">
              <span className="text-amber-500 text-lg">📅</span>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                No sheet for <span className="font-black">{currentMonthLabel}</span> yet — showing the most recent month instead.
              </p>
            </div>
            <button
              onClick={() => setShowNewMonth(true)}
              className="flex-shrink-0 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-black rounded-xl transition-colors"
            >
              + Create it
            </button>
          </div>
        )}

        {/* Header bar */}
        <HeaderBar
          loading={loading}
          lastUpdated={lastUpdated}
          error={error}
          refresh={refresh}
          shareAllMonths={shareAllMonths}
          isDark={isDark}
          setIsDark={setIsDark}
          showMessages={showMessages}
          setShowMessages={setShowMessages}
          messages={messages}
          unreadCount={unreadCount}
          markAllRead={markAllRead}
          dismissMessage={dismissMessage}
          clearMessages={clearMessages}
          showUserMenu={showUserMenu}
          setShowUserMenu={setShowUserMenu}
          userMenuRef={userMenuRef}
          user={user}
          signOut={signOut}
          setShowSettings={setShowSettings}
          setShowReconcile={setShowReconcile}
          isMonthEnded={isMonthEnded}
          selectedMonth={selectedMonth}
        />

        {/* History tab */}
        {activeTab === 'history' && (
          <HistoryTab sheetId={selectedSheetId} accessToken={user.accessToken} onRefresh={refresh} currencySymbol={currencySymbol} />
        )}

        {/* Ledger tab */}
        {activeTab === 'ledger' && (
          <LedgerTab
            sheetId={selectedSheetId}
            accessToken={user.accessToken}
            currencySymbol={currencySymbol}
            monthName={selectedMonth?.name}
            expenses={expenses}
            salaryReceived={salaryReceived}
            transactionNotes={settings.transactionNotes || {}}
            onUpdateNote={(key, data) => updateSettings(prev => ({
              ...prev,
              transactionNotes: { ...(prev.transactionNotes || {}), [key]: data },
            }))}
          />
        )}

        {/* Loading skeleton */}
        {activeTab === 'budget' && loading && !lastUpdated && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-7 h-40 animate-pulse">
                <div className="h-4 bg-slate-100 dark:bg-slate-700 rounded-xl w-1/2 mb-4" />
                <div className="h-8 bg-slate-100 dark:bg-slate-700 rounded-xl w-3/4" />
              </div>
            ))}
          </div>
        )}

        {/* Stat Cards */}
        {activeTab === 'budget' && settings.visibility.statCards !== false && (!loading || lastUpdated) && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <StatCard title="Income" value={salaryReceived} icon={<Wallet className="text-blue-500" />} color="blue" onEdit={() => { setEditingSalary(true); setSalaryDraft(salaryReceived.toFixed(2)); }} currencySymbol={currencySymbol} />
            <StatCard title="Actual Expenses" value={totalActual} icon={<Receipt className="text-rose-500" />} color="rose" subtext={`Budget: ${currencySymbol}${totalBudget.toFixed(2)}`} currencySymbol={currencySymbol} />
            <StatCard title="Remaining Income" value={salaryReceived - totalActual}
              icon={<Banknote className={salaryReceived > 0 && (salaryReceived - totalActual) / salaryReceived <= 0 ? 'text-rose-500' : salaryReceived > 0 && (salaryReceived - totalActual) / salaryReceived <= 0.15 ? 'text-amber-500' : 'text-emerald-500'} />}
              color={salaryReceived > 0 && (salaryReceived - totalActual) / salaryReceived <= 0 ? 'rose' : salaryReceived > 0 && (salaryReceived - totalActual) / salaryReceived <= 0.15 ? 'amber' : 'emerald'}
              subtext={
                (salaryReceived - totalActual) > 0 ? 'Surplus Position' :
                (salaryReceived - totalActual) === 0 ? 'Break Even' :
                'Deficit Position'
              }
              currencySymbol={currencySymbol} />
            <StatCard title="Budget Variance" value={overallRemaining} icon={overallRemaining >= 0 ? <TrendingUp className="text-emerald-500" /> : <TrendingDown className="text-rose-500" />} color={overallRemaining >= 0 ? 'emerald' : 'rose'} subtext={overallRemaining >= 0 ? 'Under Budget' : 'Over Budget'} currencySymbol={currencySymbol} />
          </div>
        )}

        {/* Main 2-column grid */}
        {activeTab === 'budget' && (!loading || lastUpdated) && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">

            {/* Left column */}
            <div className="lg:col-span-2 space-y-8">

              {/* Expense table */}
              <ExpenseTable
                expenses={expenses}
                currencySymbol={currencySymbol}
                categoryIcons={categoryIcons}
                totalBudget={totalBudget}
                totalActual={totalActual}
                overallRemaining={overallRemaining}
                isAdding={isAdding}
                setIsAdding={setIsAdding}
                newItem={newItem}
                setNewItem={setNewItem}
                onInsert={handleInsert}
                editingId={editingId}
                editingBudgetId={editingBudgetId}
                setEditingBudgetId={setEditingBudgetId}
                budgetDraft={budgetDraft}
                setBudgetDraft={setBudgetDraft}
                onSaveBudget={handleSaveBudget}
                onExpenseClick={handleExpenseClick}
                tableDragOver={tableDragOver}
                tableDragging={tableDragging}
                handleTableDragStart={handleTableDragStart}
                handleTableDragOver={handleTableDragOver}
                handleTableDrop={handleTableDrop}
                handleTableDragEnd={handleTableDragEnd}
                handleGripTouchStart={handleGripTouchStart}
                setIconPickerFor={setIconPickerFor}
                setRenamingCategory={setRenamingCategory}
                setDeletingCategory={setDeletingCategory}
                setCategoryActionFor={setCategoryActionFor}
                onAddCategory={() => setShowAddCategory(true)}
                onAddExpense={() => setShowAddDialog(true)}
                accessToken={user.accessToken}
                sheetId={selectedSheetId}
                monthName={selectedMonth?.name}
                onRefresh={refresh}
                scanTriggerRef={scanTriggerRef}
                smartRules={settings.smartRules || []}
              />

              {/* Insight cards */}
              {settings.visibility.insightCards !== false && (
                <InsightCards
                  nonMonthlyItems={nonMonthlyItems}
                  nonMonthlyTotal={nonMonthlyTotal}
                  balanceWithoutNonMonthly={balanceWithoutNonMonthly}
                  potentialDifference={potentialDifference}
                  currencySymbol={currencySymbol}
                />
              )}


            </div>

            {/* Right column */}
            <div className="space-y-8 lg:sticky lg:top-8">

              {/* Donut chart */}
              {settings.visibility.donutChart !== false && (
                <DonutChart
                  expenses={expenses}
                  totalActual={totalActual}
                  currencySymbol={currencySymbol}
                  isDark={isDark}
                  categoryColors={settings.categoryColors}
                  donutLegendCount={settings.donutLegendCount}
                />
              )}

              {/* Bar chart */}
              {settings.visibility.barChart !== false && (
                <BudgetBarsChart
                  expenses={expenses}
                  currencySymbol={currencySymbol}
                  overallRemaining={overallRemaining}
                  barSortOrder={settings.barSortOrder}
                />
              )}

            </div>
          </div>
        )}

        {/* Budget rules */}
        {activeTab === 'budget' && settings.visibility.budgetRules !== false && (!loading || lastUpdated) && (
          <BudgetRules data={rulesData} loading={rulesLoading} currencySymbol={currencySymbol} />
        )}

      </div>

      {detail && (
        <Suspense fallback={null}><DetailPanel
          expense={detail.expense}
          rows={detail.rows}
          loading={detail.loading}
          onClose={() => setDetail(null)}
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          onRefresh={handleDetailRefresh}
          currencySymbol={currencySymbol}
          monthName={selectedMonth?.name}
          transactionNotes={settings.transactionNotes || {}}
          onUpdateNote={(key, data) => updateSettings(prev => ({
            ...prev,
            transactionNotes: { ...(prev.transactionNotes || {}), [key]: data },
          }))}
          nonMonthlyVendors={nonMonthlyItems.map(i => i.vendor.toLowerCase())}
          onNonMonthlyChanged={refreshNonMonthly}
        /></Suspense>
      )}

      {showAddDialog && !isReadOnly && (
        <Suspense fallback={null}><AddExpenseDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          monthName={selectedMonth?.name}
          categories={expenses.map(e => e.name)}
          onClose={() => setShowAddDialog(false)}
          onSuccess={(result) => {
            if (result?.queued) {
              // Optimistic update: bump the category's actual spend locally
              setData(prev => prev.map(d => {
                if (d.row[0] === result.category) {
                  const newActual    = (parseFloat(d.row[1]) || 0) + result.amount;
                  const newRemaining = (parseFloat(d.row[2]) || 0) - result.amount;
                  return { ...d, row: [d.row[0], newActual, newRemaining, ...d.row.slice(3)] };
                }
                return d;
              }));
            } else {
              refresh();
              refreshNonMonthly();
            }
          }}
          smartRules={settings.smartRules || []}
          onSaveRecurring={item => updateSettings(prev => ({
            ...prev,
            recurringExpenses: [
              ...(prev.recurringExpenses || []).filter(
                r => !(r.category === item.category && r.vendor.toLowerCase() === item.vendor.toLowerCase())
              ),
              item,
            ],
          }))}
          onSaveTransactionNote={(key, data) => updateSettings(prev => ({
            ...prev,
            transactionNotes: { ...(prev.transactionNotes || {}), [key]: data },
          }))}
        /></Suspense>
      )}

      <DeleteMonthDialog
        deleteConfirm={deleteConfirm}
        setDeleteConfirm={setDeleteConfirm}
        deleteInput={deleteInput}
        setDeleteInput={setDeleteInput}
        months={months}
        setSelectedSheetId={setSelectedSheetId}
        deleteMonth={deleteMonth}
      />

      {showNewMonth && (
        <Suspense fallback={null}><NewMonthDialog
          existingMonths={months}
          accessToken={user.accessToken}
          customCategories={settings.customCategories || []}
          recurringExpenses={settings.recurringExpenses || []}
          onClose={() => setShowNewMonth(false)}
          onCreate={async (name) => {
            const newMonth = await createMonth(name);
            setSelectedSheetId(newMonth.sheetId);
            return newMonth;
          }}
        /></Suspense>
      )}

      <Suspense fallback={null}><ChatAgent
        hideButton={!!detail}
        expenses={expenses}
        salaryReceived={salaryReceived}
        totalActual={totalActual}
        totalBudget={totalBudget}
        overallRemaining={overallRemaining}
        monthName={selectedMonth?.name}
        accessToken={user.accessToken}
        sheetId={selectedSheetId}
        onRefresh={refresh}
        nonRecurringRemaining={nonMonthlyTotal > 0 ? balanceWithoutNonMonthly : nonRecurringRemaining}
        potentialDifference={potentialDifference}
        rulesData={rulesData}
        open={chatOpen}
        onOpenChange={setChatOpen}
      /></Suspense>

      {/* Reconcile dialog */}
      {showBulkRecurring && !isReadOnly && (
        <Suspense fallback={null}><BulkRecurringDialog
          recurringExpenses={settings.recurringExpenses || []}
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          monthName={selectedMonth?.name}
          onClose={() => setShowBulkRecurring(false)}
          onSuccess={() => { refresh(); refreshNonMonthly(); }}
        /></Suspense>
      )}

      {showReconcile && (
        <Suspense fallback={null}><ReconcileDialog
          monthName={selectedMonth?.name}
          sheetId={selectedSheetId}
          accessToken={user.accessToken}
          onClose={() => setShowReconcile(false)}
          onComplete={() => refresh()}
          smartRules={settings.smartRules || []}
          reconciledFingerprints={settings.reconciledFingerprints || []}
          onAddFingerprints={fps => updateSettings(prev => ({
            ...prev,
            reconciledFingerprints: [...new Set([...(prev.reconciledFingerprints || []), ...fps])],
          }))}
        /></Suspense>
      )}

      {/* Onboarding wizard — shown once per user */}
      {!settings.hasSeenOnboarding && !isReadOnly && (
        <OnboardingWizard onDone={() => updateSettings(prev => ({ ...prev, hasSeenOnboarding: true }))} />
      )}

      {/* PIN lock overlay */}
      <PinLockScreen
        locked={pinLock.locked}
        setting={pinLock.setting}
        pinHash={pinLock.pinHash}
        onUnlock={async (pin) => {
          // '__biometric__' is the signal that WebAuthn succeeded — unlock directly
          const ok = pin === '__biometric__' ? true : await pinLock.unlock(pin);
          if (ok) pinLock.setLocked(false);
          return ok;
        }}
        onSignOut={signOut}
        onSave={pinLock.savePin}
        onCancel={() => pinLock.setSetting(false)}
      />

      {showSettings && (
        <Suspense fallback={null}><SettingsPanel
          settings={settings}
          updateSettings={updateSettings}
          expenses={expenses}
          onClose={() => setShowSettings(false)}
          currencySymbol={currencySymbol}
          pinHash={pinLock.pinHash}
          onSetPin={() => { setShowSettings(false); pinLock.setSetting(true); }}
          onClearPin={pinLock.clearPin}
          pushHook={pushHook}
        /></Suspense>
      )}

      {iconPickerFor && (
        <IconPickerModal
          categoryName={iconPickerFor}
          currentIcon={categoryIcons[iconPickerFor] || '📁'}
          onPick={emoji => handleSetIcon(iconPickerFor, emoji)}
          onClose={() => setIconPickerFor(null)}
        />
      )}

      {editingSalary && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={() => setEditingSalary(false)} />
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
            <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden">
              <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden" />
              <div className="px-8 pt-6 pb-6 border-b border-slate-100 dark:border-slate-700">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-blue-50 dark:bg-blue-900/30 rounded-2xl flex items-center justify-center">
                    <Wallet className="w-5 h-5 text-blue-500" />
                  </div>
                  <div>
                    <p className="text-base font-black text-slate-800 dark:text-slate-100">Monthly Salary</p>
                    <p className="text-xs text-slate-400 mt-0.5">Update your take-home pay for this month</p>
                  </div>
                </div>
              </div>
              <div className="px-8 py-6">
                <input
                  type="number"
                  value={salaryDraft}
                  onChange={e => setSalaryDraft(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSaveSalary()}
                  autoFocus
                  placeholder="0.00"
                  className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 placeholder:text-slate-300"
                />
              </div>
              <div className="px-8 flex gap-3" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
                <button onClick={() => setEditingSalary(false)} className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">Cancel</button>
                <button onClick={handleSaveSalary} className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition-all shadow-lg">Save</button>
              </div>
            </div>
          </div>
        </>
      )}

      {showAddCategory && (
        <Suspense fallback={null}><AddCategoryDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          onClose={() => setShowAddCategory(false)}
          onSuccess={() => refresh()}
          months={months}
          currentMonthName={selectedMonth?.name || ''}
          onAddCustomCategory={name => updateSettings(prev => ({
            ...prev,
            customCategories: [...new Set([...(prev.customCategories || []), name])],
          }))}
        /></Suspense>
      )}

      <CategoryActionSheet
        categoryActionFor={categoryActionFor}
        setCategoryActionFor={setCategoryActionFor}
        categoryIcons={categoryIcons}
        setIconPickerFor={setIconPickerFor}
        setRenamingCategory={setRenamingCategory}
        setDeletingCategory={setDeletingCategory}
      />

      {renamingCategory && (
        <Suspense fallback={null}><RenameCategoryDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          category={renamingCategory}
          onClose={() => setRenamingCategory(null)}
          onSuccess={() => { refresh(); setRenamingCategory(null); }}
        /></Suspense>
      )}

      {deletingCategory && (
        <Suspense fallback={null}><DeleteCategoryDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          category={deletingCategory}
          onClose={() => setDeletingCategory(null)}
          onSuccess={() => { refresh(); setDeletingCategory(null); }}
        /></Suspense>
      )}

      {!isReadOnly && (
        <SpeedDial
          fabOpen={fabOpen}
          setFabOpen={setFabOpen}
          detail={detail}
          scanTriggerRef={scanTriggerRef}
          onAddExpense={() => setShowAddDialog(true)}
          onOpenChat={() => setChatOpen(true)}
          onBulkRecurring={(settings.recurringExpenses || []).length > 0 ? () => setShowBulkRecurring(true) : null}
        />
      )}
    </div>
  );
}

export default App;
