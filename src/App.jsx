import React, { useState, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { useSheetData } from './useSheetData.js';
import { use503020 } from './use503020.js';
import { getCurrencySymbol } from './currency.js';
import { useAuth } from './useAuth.js';
import { useOfflineSync } from './useOfflineSync.js';
import { getQueue } from './offlineQueue.js';
import { useDragSort } from './useDragSort.js';
import { useSettings, DEFAULT_CATEGORY_ORDER } from './useSettings.js';
import { useMonthSelection } from './useMonthSelection.js';
import { useBudgetSummary } from './useBudgetSummary.js';
import { useDashboardHandlers } from './useDashboardHandlers.js';
import { useMessages } from './useMessages.js';
import { usePush } from './usePush.js';
import { DEFAULT_ICONS } from './categoryIcons.js';
import { usePinLock, PinLockScreen } from './PinLock.jsx';
import { LoginScreen, OfflineUnlockScreen } from './LoginScreen.jsx';
import { BudgetRules } from './BudgetRules.jsx';
import { useTheme } from './useTheme.js';
import { useNonMonthlyExpenses } from './useNonMonthlyExpenses.js';
import { useEscapeDismiss } from './useEscapeDismiss.js';
import { useGlobalShortcuts } from './useGlobalShortcuts.js';
import { SalaryEditDialog } from './SalaryEditDialog.jsx';

// Heavy components — loaded only when first rendered
const SpendingHeatmap  = lazy(() => import('./SpendingHeatmap.jsx').then(m => ({ default: m.SpendingHeatmap })));
const SpendingMap      = lazy(() => import('./SpendingMap.jsx').then(m => ({ default: m.SpendingMap })));
const DetailPanel      = lazy(() => import('./DetailPanel.jsx').then(m => ({ default: m.DetailPanel })));
const AddExpenseDialog = lazy(() => import('./AddExpenseDialog.jsx').then(m => ({ default: m.AddExpenseDialog })));
const NewMonthDialog   = lazy(() => import('./NewMonthDialog.jsx').then(m => ({ default: m.NewMonthDialog })));
const ChatAgent        = lazy(() => import('./ChatAgent.jsx').then(m => ({ default: m.ChatAgent })));
import { HistoryTab } from './HistoryTab.jsx';
import { LedgerTab, ledgerCache } from './LedgerTab.jsx';
const SettingsPanel    = lazy(() => import('./SettingsPanel.jsx').then(m => ({ default: m.SettingsPanel })));
const CardsTab         = lazy(() => import('./CardsTab.jsx').then(m => ({ default: m.CardsTab })));
const AddCategoryDialog    = lazy(() => import('./AddCategoryDialog.jsx').then(m => ({ default: m.AddCategoryDialog })));
const ReconcileDialog      = lazy(() => import('./ReconcileDialog.jsx').then(m => ({ default: m.ReconcileDialog })));
const BulkRecurringDialog  = lazy(() => import('./BulkRecurringDialog.jsx').then(m => ({ default: m.BulkRecurringDialog })));
const DeleteCategoryDialog = lazy(() => import('./DeleteCategoryDialog.jsx').then(m => ({ default: m.DeleteCategoryDialog })));
const RenameCategoryDialog = lazy(() => import('./RenameCategoryDialog.jsx').then(m => ({ default: m.RenameCategoryDialog })));
import { StatCard } from './StatCard.jsx';
import { IconPickerModal } from './IconPickerModal.jsx';
import { CategoryActionSheet } from './CategoryActionSheet.jsx';
import { EyeOff, WifiOff, CalendarX } from 'lucide-react';
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
  const auth = useAuth();
  const { user, denied, loadingAuth, onGoogleSuccess, onGoogleError,
          pendingOfflineUnlock, unlockOffline, cancelOfflineUnlock } = auth;

  if (pendingOfflineUnlock) {
    return <OfflineUnlockScreen onUnlock={unlockOffline} onSignInInstead={cancelOfflineUnlock} />;
  }

  if (!user) {
    return <LoginScreen onSuccess={onGoogleSuccess} onError={onGoogleError} loading={loadingAuth} denied={denied} />;
  }

  return <Dashboard auth={auth} />;
}

function Dashboard({ auth }) {
  const { user, signOut, sessionExpired, setSessionExpired,
          lockToken, unlockToken, setupEncryption } = auth;
  const pinLock = usePinLock(signOut);

  // Show the lock screen whenever the session is in the "needs PIN" state —
  // covers tab-reload-while-locked AND fresh sign-in when a PIN already exists.
  useEffect(() => {
    if (user?.isLocked && pinLock.pinHash && !pinLock.locked) pinLock.setLocked(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.isLocked, pinLock.pinHash]);

  // When the lock screen shows (background timeout, manual lock), strip the
  // plaintext access token from React state and sessionStorage. The encrypted
  // copy stays so we can restore it on PIN unlock without a full re-auth.
  useEffect(() => {
    if (pinLock.locked) lockToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinLock.locked]);
  const {
    months, monthsLoading, createMonth, deleteMonth, shareAllMonths,
    selectedSheetId, setSelectedSheetId,
    selectedMonth, currentMonthLabel, isMonthEnded, currentMonthMissing,
    showNewMonth, setShowNewMonth,
    deleteConfirm, setDeleteConfirm,
    deleteInput, setDeleteInput,
  } = useMonthSelection(user.accessToken, user.allowedEmails);

  const { data: liveData, loading, error, lastUpdated, refresh } = useSheetData(selectedSheetId, user.accessToken);
  const { data: rulesData, loading: rulesLoading } = use503020(selectedSheetId, user.accessToken);
  const [data, setData] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', amount: '', remaining: '' });
  const [activeTab, setActiveTab] = useState('budget'); // 'budget' | 'history' | 'ledger'
  const scanTriggerRef = useRef(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [renamingCategory, setRenamingCategory] = useState(null);
  const [deletingCategory, setDeletingCategory] = useState(null);
  const [categoryActionFor, setCategoryActionFor] = useState(null); // mobile ⋯ action sheet
  const [showUserMenu, setShowUserMenu]     = useState(false);
  const [refreshKey, setRefreshKey]             = useState(0);
  const [showReconcile, setShowReconcile]       = useState(false);
  const [showBulkRecurring, setShowBulkRecurring] = useState(false);
  const [showMessages, setShowMessages]         = useState(false);
  const [chatOpen, setChatOpen]         = useState(false);
  const [chatInitialQuery, setChatInitialQuery] = useState('');
  const [fabOpen, setFabOpen]           = useState(false);
  const userMenuRef = useRef(null);

  // Per-user settings (saved to Google Sheets)
  const isReadOnly = user.role === 'viewer';
  const { settings, loading: settingsLoading, updateSettings } = useSettings(user.email, user.accessToken);
  const currencySymbol = getCurrencySymbol(settings.currency || 'USD');
  const categoryIcons  = { ...DEFAULT_ICONS, ...(settings.categoryIcons || {}) };

  // Theme (dark/light, font size, accent color) — extracted to useTheme hook
  const { isDark, setIsDark } = useTheme(settings, updateSettings);


  // ── URI automation: handle ?action= deep-links ───────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const action = params.get('action');
    if (!action) return;
    window.history.replaceState({}, '', '/');
    if (action === 'add' && !isReadOnly) {
      setShowAddDialog({
        prefillCategory: params.get('category') || null,
        prefillVendor:   params.get('vendor')   || '',
        prefillAmount:   params.get('amount')   || '',
      });
    } else if (action === 'chat') {
      const q = params.get('q') || '';
      if (q) setChatInitialQuery(q);
      setChatOpen(true);
    } else if (action === 'summary') {
      setActiveTab('budget');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Global keyboard shortcuts — extracted to useGlobalShortcuts hook
  const shortcutActions = useMemo(() => ({
    addExpense:   () => setShowAddDialog(true),
    scanReceipt:  () => scanTriggerRef.current?.(),
    openSettings: () => setShowSettings(true),
    openChat:     () => setChatOpen(true),
  }), []);
  useGlobalShortcuts(settings.keyboardShortcuts, shortcutActions);

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

  // ── Non-monthly expenses (sheet-backed) — extracted to useNonMonthlyExpenses hook
  const { nonMonthlyItems, refreshNonMonthly } = useNonMonthlyExpenses(selectedSheetId, user.accessToken);

  const {
    salaryReceived, nonRecurringRemaining, potentialDifference,
    totalActual, totalBudget, overallRemaining,
    nonMonthlyTotal, balanceWithoutNonMonthly,
  } = useBudgetSummary(data, expenses, nonMonthlyItems);

  // ── Online / Offline ──────────────────────────────────────────────────────────
  const { isOnline, syncedCount, clearSyncedCount } = useOfflineSync({ user, selectedSheetId, refresh, setSessionExpired });

  useEffect(() => {
    if (!syncedCount) return;
    const t = setTimeout(clearSyncedCount, 4000);
    return () => clearTimeout(t);
  }, [syncedCount]);

  const {
    detail, setDetail,
    editingBudgetId, setEditingBudgetId, budgetDraft, setBudgetDraft,
    editingSalary, setEditingSalary,
    iconPickerFor, setIconPickerFor,
    handleExpenseClick, handleDetailRefresh,
    handleSaveBudget, handleSaveSalary, handleSetIcon,
  } = useDashboardHandlers({
    accessToken: user.accessToken,
    sheetId: selectedSheetId,
    monthName: selectedMonth?.name,
    refresh,
    updateSettings,
  });

  // Global Escape key — moved here so all referenced state is declared above
  useEscapeDismiss([
    { active: fabOpen,                dismiss: () => setFabOpen(false) },
    { active: chatOpen,               dismiss: () => setChatOpen(false) },
    { active: iconPickerFor,          dismiss: () => setIconPickerFor(null) },
    { active: categoryActionFor,      dismiss: () => setCategoryActionFor(null) },
    { active: deletingCategory,       dismiss: () => setDeletingCategory(null) },
    { active: renamingCategory,       dismiss: () => setRenamingCategory(null) },
    { active: editingSalary,          dismiss: () => setEditingSalary(false) },
    { active: editingBudgetId !== null, dismiss: () => setEditingBudgetId(null) },
    { active: showAddCategory,        dismiss: () => setShowAddCategory(false) },
    { active: showAddDialog,          dismiss: () => setShowAddDialog(false) },
    { active: deleteConfirm,          dismiss: () => setDeleteConfirm(null) },
    { active: showNewMonth,           dismiss: () => setShowNewMonth(false) },
    { active: detail,                 dismiss: () => setDetail(null) },
    { active: showSettings,           dismiss: () => setShowSettings(false) },
    { active: showUserMenu,           dismiss: () => setShowUserMenu(false) },
  ]);

  // ── Messages ──────────────────────────────────────────────────────────────────
  const { messages, unreadCount, markAllRead, dismissMessage, clearAll: clearMessages } =
    useMessages(settings, updateSettings, expenses, totalActual, salaryReceived, selectedMonth?.name);

  // ── Push notifications ────────────────────────────────────────────────────────
  const pushHook = usePush(user.email, settings.pushHour ?? 20, user.accessToken);

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
        headers: {
          'Content-Type': 'application/json',
          ...(user.accessToken ? { 'Authorization': `Bearer ${user.accessToken}` } : {}),
        },
        body: JSON.stringify({ title: m.title, body: m.body }),
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
      <div className="max-w-7xl mx-auto space-y-6 pb-12">

        {/* Read-only banner */}
        {isReadOnly && (
          <div className="flex items-center gap-3 px-4 py-3 bg-violet-50 dark:bg-violet-900/20 border border-violet-200 dark:border-violet-700/40 rounded-2xl text-sm font-bold text-violet-800 dark:text-violet-300">
            <EyeOff className="w-4 h-4 flex-shrink-0" />
            View-only mode — you can browse but not make changes
          </div>
        )}

        {/* Offline banner */}
        {!isOnline && (
          <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 rounded-2xl text-sm font-bold text-amber-800 dark:text-amber-300">
            <WifiOff className="w-4 h-4 flex-shrink-0" />
            {getQueue().length > 0
              ? `You're offline — ${getQueue().length} expense${getQueue().length === 1 ? '' : 's'} pending sync`
              : "You're offline — changes will sync when reconnected"}
          </div>
        )}

        {/* Sync confirmation toast */}
        {syncedCount > 0 && (
          <div className="flex items-center gap-3 px-4 py-3 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-700/40 rounded-2xl text-sm font-bold text-emerald-800 dark:text-emerald-300">
            <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
            {syncedCount} expense{syncedCount === 1 ? '' : 's'} synced
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

        {/* Screen-reader live region for data updates */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {lastUpdated && selectedMonth?.name ? `${selectedMonth.name} data loaded` : ''}
        </div>

        {/* Page title */}
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 dark:text-white tracking-tight">
            {user.name ? `${user.name.split(' ')[0]}'s Budget` : 'My Budget'}
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
        {(() => {
          const TABS = [['budget', 'Dashboard'], ['ledger', 'Ledger'], ['history', 'History'], ['cards', 'Cards']];
          const tabIdx = TABS.findIndex(([t]) => t === activeTab);
          return (
            <div role="tablist" className="relative flex p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-fit border border-slate-200 dark:border-slate-700">
              {/* Sliding indicator */}
              <div
                aria-hidden="true"
                className="absolute top-1 bottom-1 left-1 rounded-xl bg-white dark:bg-slate-700 shadow-sm pointer-events-none"
                style={{
                  width: `calc((100% - 8px) / ${TABS.length})`,
                  transform: `translateX(calc(${tabIdx} * 100%))`,
                  transition: `transform 150ms var(--ease-out)`,
                }}
              />
              {TABS.map(([tab, label]) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={activeTab === tab}
                  onClick={() => setActiveTab(tab)}
                  className="relative flex-1 px-5 py-2 rounded-xl text-sm font-black transition-colors duration-150 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                  style={activeTab === tab ? { color: 'var(--color-accent)' } : undefined}
                >
                  {label}
                </button>
              ))}
            </div>
          );
        })()}

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
          <HistoryTab sheetId={selectedSheetId} accessToken={user.accessToken} onRefresh={refresh} currencySymbol={currencySymbol} refreshKey={refreshKey} />
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
            refreshKey={refreshKey}
            months={months}
          />
        )}

        {/* Cards tab */}
        {activeTab === 'cards' && (
          <Suspense fallback={null}>
            <CardsTab
              sheetId={selectedSheetId}
              accessToken={user.accessToken}
              currencySymbol={currencySymbol}
              cards={settings.cards || []}
              settings={settings}
            />
          </Suspense>
        )}

        {/* Loading skeleton */}
        {activeTab === 'budget' && loading && !lastUpdated && (
          <div className="space-y-4">
            {/* Hero card skeleton */}
            <div className="bg-white dark:bg-slate-900 rounded-[1.25rem] border border-slate-100 dark:border-slate-800 p-8 sm:p-10">
              <div className="skeleton h-3 w-28 mb-8" />
              <div className="skeleton h-14 w-52" />
              <div className="skeleton h-6 w-16 rounded-full mt-5" />
            </div>
            {/* Stat row skeleton */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="bg-white dark:bg-slate-900 rounded-xl border border-slate-100 dark:border-slate-800 px-5 py-4 flex items-center justify-between">
                  <div className="skeleton h-2.5 w-20" />
                  <div className="skeleton h-5 w-16" />
                </div>
              ))}
            </div>
            {/* Main grid skeleton */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
              <div className="lg:col-span-2 skeleton h-64 rounded-[1.25rem]" />
              <div className="skeleton h-64 rounded-[1.25rem]" />
            </div>
          </div>
        )}

        {/* Stat Cards — keyed on selectedSheetId so entering month triggers re-animation */}
        {activeTab === 'budget' && settings.visibility.statCards !== false && (!loading || lastUpdated) && (
          <div key={`stats-${selectedSheetId}`} className="space-y-4 animate-crossfade-in">
            <StatCard
              hero
              title="Remaining Income"
              value={salaryReceived - totalActual}
              subtext={
                (salaryReceived - totalActual) > 0 ? 'Surplus' :
                (salaryReceived - totalActual) === 0 ? 'Break Even' :
                'Deficit'
              }
              currencySymbol={currencySymbol}
              enterDelay={0}
            />
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatCard
                title="Income"
                value={salaryReceived}
                onEdit={() => setEditingSalary(true)}
                currencySymbol={currencySymbol}
                valueColor="text-slate-900 dark:text-white"
                enterDelay={60}
              />
              <StatCard
                title="Actual Expenses"
                value={totalActual}
                subtext={`of ${currencySymbol}${totalBudget.toFixed(2)} budget`}
                currencySymbol={currencySymbol}
                valueColor="text-slate-900 dark:text-white"
                enterDelay={100}
              />
              <StatCard
                title="Budget Variance"
                value={overallRemaining}
                subtext={overallRemaining >= 0 ? 'Under Budget' : 'Over Budget'}
                currencySymbol={currencySymbol}
                enterDelay={140}
              />
            </div>
          </div>
        )}

        {/* Main 2-column grid — keyed so month switch re-animates content */}
        {activeTab === 'budget' && (!loading || lastUpdated) && (
          <div key={`grid-${selectedSheetId}`} className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start mt-4 animate-crossfade-in">

            {/* Left column */}
            <div className="lg:col-span-2 space-y-4">

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
                onRefresh={() => { ledgerCache.delete(selectedSheetId); setRefreshKey(k => k + 1); refresh(); }}
                scanTriggerRef={scanTriggerRef}
                onSaveRecurring={item => updateSettings(prev => ({
                  ...prev,
                  recurringExpenses: [
                    ...(prev.recurringExpenses || []).filter(
                      r => !(r.category === item.category && r.vendor.toLowerCase() === item.vendor.toLowerCase())
                    ),
                    item,
                  ],
                }))}
                smartRules={settings.smartRules || []}
                cards={settings.cards || []}
                cardRules={settings.cardRules || []}
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

              {/* Spending heatmap calendar */}
              {settings.visibility.heatmap !== false && (
                <Suspense fallback={null}>
                  <SpendingHeatmap
                    sheetId={selectedSheetId}
                    accessToken={user.accessToken}
                    currencySymbol={currencySymbol}
                    monthName={selectedMonth?.name}
                    isDark={isDark}
                  />
                </Suspense>
              )}

              {/* Spending map */}
              {settings.geoTagEnabled && settings.visibility.map !== false && (
                <Suspense fallback={null}>
                  <SpendingMap
                    transactionNotes={settings.transactionNotes || {}}
                    currencySymbol={currencySymbol}
                  />
                </Suspense>
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
          onAddExpense={!isReadOnly ? () => setShowAddDialog({ prefillCategory: detail.expense }) : undefined}
        /></Suspense>
      )}

      {showAddDialog && !isReadOnly && (
        <Suspense fallback={null}><AddExpenseDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          monthName={selectedMonth?.name}
          categories={expenses.map(e => e.name)}
          prefillCategory={typeof showAddDialog === 'object' ? showAddDialog.prefillCategory : null}
          prefillVendor={typeof showAddDialog === 'object' ? showAddDialog.prefillVendor || '' : ''}
          prefillAmount={typeof showAddDialog === 'object' ? showAddDialog.prefillAmount || '' : ''}
          onClose={() => setShowAddDialog(false)}
          lockCategory={typeof showAddDialog === 'object' && !!showAddDialog.prefillCategory}
          onSuccess={(result) => {
            ledgerCache.delete(selectedSheetId);
            setRefreshKey(k => k + 1);
            if (result?.queued) {
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
          cards={settings.cards || []}
          cardRules={settings.cardRules || []}
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
          geoTagEnabled={settings.geoTagEnabled || false}
          geoPrivacyBlur={settings.geoPrivacyBlur !== false}
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
        initialQuery={chatInitialQuery}
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
          cardRules={settings.cardRules || []}
          reconciledFingerprints={settings.reconciledFingerprints || []}
          onAddFingerprints={fps => updateSettings(prev => ({
            ...prev,
            reconciledFingerprints: [...new Set([...(prev.reconciledFingerprints || []), ...fps])],
          }))}
        /></Suspense>
      )}

      {/* Onboarding wizard — shown once per user */}
      {!settingsLoading && !settings.hasSeenOnboarding && !isReadOnly && (
        <OnboardingWizard onDone={() => updateSettings(prev => ({ ...prev, hasSeenOnboarding: true }))} />
      )}

      {/* PIN lock overlay */}
      <PinLockScreen
        locked={pinLock.locked}
        setting={pinLock.setting}
        pinHash={pinLock.pinHash}
        onUnlock={async (pin) => {
          const ok = await pinLock.unlock(pin);
          if (!ok) return false;
          // Restore the access token (no-op when biometric is the unlock path).
          await unlockToken(pin);
          pinLock.setLocked(false);
          return true;
        }}
        onBiometricUnlock={() => pinLock.setLocked(false)}
        onSignOut={signOut}
        onSave={async (pin) => {
          await pinLock.savePin(pin);
          // Encrypt the in-memory access token under the new PIN so subsequent
          // locks can clear plaintext from storage without losing the session.
          await setupEncryption(pin);
        }}
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
        <SalaryEditDialog
          currentSalary={salaryReceived}
          onSave={handleSaveSalary}
          onClose={() => setEditingSalary(false)}
        />
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

