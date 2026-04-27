import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as d3 from 'd3';
import {
  TrendingDown, TrendingUp, DollarSign, Wallet, Banknote, Receipt,
  PieChart as PieChartIcon, BarChart3, Plus, Trash2,
  Edit2, Check, X, AlertCircle, Info, ChevronRight,
  Sun, Moon, RefreshCw, LogOut, Settings as SettingsIcon, ChevronDown, GripVertical, FolderPlus, Pencil, MoreHorizontal, Smile,
} from 'lucide-react';
import { useSheetData } from './useSheetData.js';
import { use503020 } from './use503020.js';
import { hasDetail } from './fetchDetail.js';
import { fetchDetailRows, updateCategoryBudget, writeSalary } from './sheetsApi.js';
import { getCurrencySymbol } from './currency.js';
import { DetailPanel } from './DetailPanel.jsx';
import { BudgetRules } from './BudgetRules.jsx';
import { AddExpenseDialog } from './AddExpenseDialog.jsx';
import { useAuth } from './useAuth.js';
import { LoginScreen } from './LoginScreen.jsx';
import { useMonths } from './useMonths.js';
import { NewMonthDialog } from './NewMonthDialog.jsx';
import { ChatAgent } from './ChatAgent.jsx';
import { ReceiptScanButton } from './ReceiptScanner.jsx';
import { HistoryTab } from './HistoryTab.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { useSettings, DEFAULT_CATEGORY_ORDER } from './useSettings.js';
import { AddCategoryDialog } from './AddCategoryDialog.jsx';
import { DEFAULT_ICONS, EMOJI_DATA } from './categoryIcons.js';
import { DeleteCategoryDialog } from './DeleteCategoryDialog.jsx';
import { RenameCategoryDialog } from './RenameCategoryDialog.jsx';

function App() {
  const { user, denied, loadingAuth, onGoogleSuccess, onGoogleError, signOut } = useAuth();

  if (!user) {
    return <LoginScreen onSuccess={onGoogleSuccess} onError={onGoogleError} loading={loadingAuth} denied={denied} />;
  }

  return <Dashboard user={user} signOut={signOut} />;
}

function Dashboard({ user, signOut }) {
  const { months, loading: monthsLoading, createMonth, deleteMonth } = useMonths(user.accessToken);
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
  const currentMonthMissing = !monthsLoading && months.length > 0 &&
    !months.some(m => m.name.toLowerCase() === currentMonthLabel.toLowerCase());

  const { data: liveData, loading, error, lastUpdated, refresh } = useSheetData(selectedSheetId, user.accessToken);
  const { data: rulesData, loading: rulesLoading } = use503020(selectedSheetId, user.accessToken);
  const [data, setData] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', amount: '', remaining: '' });
  const [activeTab, setActiveTab] = useState('budget'); // 'budget' | 'history'
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
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef(null);
  const tableDragIndex = useRef(null);
  const [tableDragOver, setTableDragOver] = useState(null);
  const [tableDragging, setTableDragging] = useState(null);
  const touchDragRef = useRef({ active: false, fromIdx: null });
  const touchDragOverRef = useRef(null);

  // Per-user settings (saved to Google Sheets)
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

  // Category colors from settings
  const getCategoryColor = (name, idx) =>
    settings.categoryColors?.[name] || d3.schemeTableau10[idx % 10];

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

  // Global Escape key — closes the topmost open panel
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
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
  }, [iconPickerFor, categoryActionFor, deletingCategory, renamingCategory, editingSalary, editingBudgetId,
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
  const notesString = notesRow?.row[8] || "";

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

  const totalActual = d3.sum(expenses, d => d.actual);
  const totalBudget = d3.sum(expenses, d => d.budget);
  const overallRemaining = totalBudget - totalActual;

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
  const chartExpenses = useMemo(
    () => [...expenses].filter(d => d.actual > 0).sort((a, b) => b.actual - a.actual),
    [expenses]
  );

  const [hoveredSlice, setHoveredSlice] = useState(null);

  const renderDonutChart = () => {
    const width = 200, height = 200;
    const radius = Math.min(width, height) / 2;
    const pie = d3.pie().value(d => d.actual).sort(null);
    const arc     = d3.arc().innerRadius(radius * 0.65).outerRadius(radius);
    const arcHover = d3.arc().innerRadius(radius * 0.62).outerRadius(radius * 1.05);
    const arcs = pie(chartExpenses);
    const pct = hoveredSlice
      ? ((hoveredSlice.actual / totalActual) * 100).toFixed(1)
      : null;
    return (
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
    );
  };

  const renderBudgetBars = () => {
    const sorted = [...expenses].sort((a, b) => {
      if (settings.barSortOrder === 'name')      return a.name.localeCompare(b.name);
      if (settings.barSortOrder === 'remaining') return a.remaining - b.remaining;
      return b.actual - a.actual; // default: amount
    });
    const maxVal = d3.max(sorted, d => Math.max(d.actual, d.budget)) || 1;
    return (
      <div className="space-y-4 pt-2 max-h-80 overflow-y-auto pr-1">
        {sorted.map((item, i) => {
          const actualWidth = Math.max(0, (item.actual / maxVal) * 100);
          const budgetWidth = Math.max(0, (item.budget / maxVal) * 100);
          const isOverBudget = item.remaining < 0;
          return (
            <div key={i} className="group">
              <div className="flex justify-between text-xs mb-1.5">
                <span className="font-semibold text-slate-700 dark:text-slate-300 group-hover:text-indigo-500 transition-colors">{item.name}</span>
                <span className="text-slate-400 font-medium">
                  <span className="text-slate-900 dark:text-slate-100">{currencySymbol}{item.actual.toFixed(0)}</span> / {currencySymbol}{item.budget.toFixed(0)}
                </span>
              </div>
              <div className="relative h-2 w-full bg-slate-100 dark:bg-slate-700 rounded-full overflow-hidden">
                <div className="absolute h-full bg-slate-200 dark:bg-slate-600 transition-all duration-700 ease-out" style={{ width: `${budgetWidth}%` }} />
                <div className={`absolute h-full transition-all duration-700 ease-out rounded-full ${isOverBudget ? 'bg-rose-500' : 'bg-emerald-500'}`} style={{ width: `${actualWidth}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // ── Table drag-to-reorder ──────────────────────────────────────────────────
  const handleTableDragStart = (e, idx) => {
    tableDragIndex.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    setTableDragging(idx);
    // Use the row itself as drag image but with correct background
    const ghost = e.currentTarget.cloneNode(true);
    ghost.style.cssText = `
      position:fixed; top:-1000px; left:0; width:${e.currentTarget.offsetWidth}px;
      background:${isDark ? '#1e293b' : '#ffffff'};
      opacity:0.95; border-radius:12px; box-shadow:0 8px 24px rgba(0,0,0,0.25);
      pointer-events:none;
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    setTimeout(() => document.body.removeChild(ghost), 0);
  };
  const handleTableDragOver = (e, idx) => {
    e.preventDefault();
    setTableDragOver(idx);
  };
  const handleTableDrop = (e, dropIdx) => {
    e.preventDefault();
    const from = tableDragIndex.current;
    if (from == null || from === dropIdx) { setTableDragOver(null); return; }
    // Build new order from current rendered expenses order
    const currentOrder = expenses.map(ex => ex.name);
    const [moved] = currentOrder.splice(from, 1);
    currentOrder.splice(dropIdx, 0, moved);
    // Fill in any categories not currently shown (keep them at the end)
    const full = [...currentOrder];
    (settings.categoryOrder || DEFAULT_CATEGORY_ORDER).forEach(n => {
      if (!full.includes(n)) full.push(n);
    });
    updateSettings(prev => ({ ...prev, categoryOrder: full }));
    tableDragIndex.current = null;
    setTableDragOver(null);
  };
  const handleTableDragEnd = () => {
    tableDragIndex.current = null;
    setTableDragOver(null);
    setTableDragging(null);
  };

  // ── Touch drag (iOS + Android) — fires from grip handle only ──────────────
  const handleGripTouchStart = (e, idx) => {
    touchDragRef.current = { active: true, fromIdx: idx };
    touchDragOverRef.current = idx;
    setTableDragging(idx);
  };

  const commitTouchDrop = () => {
    const from = touchDragRef.current.fromIdx;
    const to   = touchDragOverRef.current;
    if (from != null && to != null && from !== to) {
      const currentOrder = expenses.map(ex => ex.name);
      const [moved] = currentOrder.splice(from, 1);
      currentOrder.splice(to, 0, moved);
      const full = [...currentOrder];
      (settings.categoryOrder || DEFAULT_CATEGORY_ORDER).forEach(n => {
        if (!full.includes(n)) full.push(n);
      });
      updateSettings(s => ({ ...s, categoryOrder: full }));
    }
    touchDragRef.current = { active: false, fromIdx: null };
    touchDragOverRef.current = null;
    setTableDragging(null);
    setTableDragOver(null);
  };

  // Non-passive touchmove — prevents page scroll while dragging rows
  useEffect(() => {
    if (tableDragging === null) return;
    const onMove = (e) => {
      if (!touchDragRef.current.active) return;
      e.preventDefault();
      const touch = e.touches[0];
      const rows = document.querySelectorAll('[data-rowindex]');
      for (const row of rows) {
        const rect = row.getBoundingClientRect();
        if (touch.clientY >= rect.top && touch.clientY <= rect.bottom) {
          const overIdx = parseInt(row.getAttribute('data-rowindex'), 10);
          if (overIdx !== touchDragOverRef.current) {
            touchDragOverRef.current = overIdx;
            setTableDragOver(overIdx);
          }
          break;
        }
      }
    };
    const onEnd = () => commitTouchDrop();
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
    return () => {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };
  }, [tableDragging]);

  const inputCls = "bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-xl px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30";

  return (
    <div className="min-h-screen bg-[#fcfdfe] dark:bg-slate-950 text-slate-900 dark:text-slate-100 font-sans p-4 lg:p-8 transition-colors duration-300"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 1rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)',
        paddingLeft: 'calc(env(safe-area-inset-left) + 1rem)',
        paddingRight: 'calc(env(safe-area-inset-right) + 1rem)',
      }}
    >
      <div className="max-w-7xl mx-auto space-y-8 pb-12">

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
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={selectedSheetId}
            onChange={e => setSelectedSheetId(e.target.value)}
            disabled={monthsLoading}
            className="flex-1 sm:flex-none bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 rounded-2xl px-4 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-500/30 cursor-pointer shadow-sm min-w-0"
          >
            {monthsLoading && <option>Loading…</option>}
            {months.map(m => (
              <option key={m.sheetId} value={m.sheetId}>{m.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowNewMonth(true)}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-2xl text-sm font-bold shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 hover:bg-indigo-700 transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" /> New Month
          </button>
          {selectedMonth && months.length > 1 && (
            <button
              onClick={() => { setDeleteConfirm(selectedMonth); setDeleteInput(''); }}
              className="p-2 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-400 hover:text-rose-500 hover:border-rose-300 dark:hover:border-rose-700 transition-all shadow-sm"
              title="Remove this month"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl w-fit border border-slate-200 dark:border-slate-700">
          {[['budget', 'Budget'], ['history', 'History']].map(([tab, label]) => (
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
        <div className="flex flex-wrap justify-between items-center gap-3">
          <div className="flex items-center gap-3">
            {loading && !lastUpdated && (
              <span className="text-xs text-slate-400 flex items-center gap-1.5">
                <RefreshCw className="w-3 h-3 animate-spin" /> Loading from Google Sheets…
              </span>
            )}
            {error && (
              <span className="text-xs text-rose-500 flex items-center gap-1.5">
                <AlertCircle className="w-3 h-3" /> {error}
              </span>
            )}
            {lastUpdated && !error && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-xs text-slate-400">
                  Live · updated {lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
                <button onClick={refresh} className="text-slate-400 hover:text-indigo-500 transition-colors ml-1">
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Theme quick-toggle */}
            <button
              onClick={() => setIsDark(d => !d)}
              className="p-2.5 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 shadow-sm transition-all"
            >
              {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>

            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setShowUserMenu(v => !v)}
                className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-sm hover:border-indigo-300 dark:hover:border-indigo-600 transition-all"
              >
                {user.picture && (
                  <img src={user.picture} alt={user.name} className="w-6 h-6 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
                )}
                <span className="hidden sm:inline text-sm font-bold text-slate-700 dark:text-slate-200">
                  Hi, {user.name} 👋
                </span>
                <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`} />
              </button>

              {/* Dropdown */}
              {showUserMenu && (
                <div className="absolute right-0 top-full mt-2 w-44 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl overflow-hidden z-30">
                  <button
                    onClick={() => { setShowUserMenu(false); setShowSettings(true); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                  >
                    <SettingsIcon className="w-4 h-4 text-slate-400" />
                    Settings
                  </button>
                  <div className="h-px bg-slate-100 dark:bg-slate-700" />
                  <button
                    onClick={() => { setShowUserMenu(false); signOut(); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* History tab */}
        {activeTab === 'history' && (
          <HistoryTab sheetId={selectedSheetId} accessToken={user.accessToken} onRefresh={refresh} currencySymbol={currencySymbol} />
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
            <StatCard title="Total Monthly Salary" value={salaryReceived} icon={<Wallet className="text-blue-500" />} color="blue" onEdit={() => { setEditingSalary(true); setSalaryDraft(salaryReceived.toFixed(2)); }} currencySymbol={currencySymbol} />
            <StatCard title="Actual Expenses" value={totalActual} icon={<Receipt className="text-rose-500" />} color="rose" subtext={`Budget: ${currencySymbol}${totalBudget.toFixed(2)}`} currencySymbol={currencySymbol} />
            <StatCard title="Remaining Cashflow" value={salaryReceived - totalActual} icon={<Banknote className="text-emerald-500" />} color="emerald" subtext={salaryReceived - totalActual > 0 ? 'Surplus Position' : 'Deficit Position'} currencySymbol={currencySymbol} />
            <StatCard title="Budget Variance" value={overallRemaining} icon={overallRemaining >= 0 ? <TrendingUp className="text-emerald-500" /> : <TrendingDown className="text-rose-500" />} color={overallRemaining >= 0 ? 'emerald' : 'rose'} subtext={overallRemaining >= 0 ? 'Under Budget' : 'Over Budget'} currencySymbol={currencySymbol} />
          </div>
        )}

        {/* Main 2-column grid */}
        {activeTab === 'budget' && (!loading || lastUpdated) && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-start">

            {/* Left column */}
            <div className="lg:col-span-2 space-y-8">

              {/* Expense table */}
              <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] overflow-hidden">
                <div className="px-4 py-4 sm:p-8 border-b border-slate-50 dark:border-slate-700 flex justify-between items-center gap-3">
                  <div>
                    <h2 className="text-base sm:text-xl font-black text-slate-800 dark:text-slate-100">Expense Breakdown</h2>
                    <p className="text-xs sm:text-sm text-slate-400 mt-0.5 sm:mt-1 hidden sm:block">Detailed view of all monthly outgoings</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <ReceiptScanButton accessToken={user.accessToken} sheetId={selectedSheetId} monthName={selectedMonth?.name} onSuccess={() => refresh()} />
                    <button
                      onClick={() => setShowAddCategory(true)}
                      title="Add a new budget category"
                      className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 rounded-2xl text-sm font-bold hover:bg-slate-200 dark:hover:bg-slate-600 transition-all active:scale-95"
                    >
                      <FolderPlus className="w-4 h-4" />
                      <span className="hidden sm:inline">New Category</span>
                    </button>
                    <button onClick={() => setShowAddDialog(true)} className="flex items-center gap-2 px-4 py-2 sm:px-5 sm:py-2.5 bg-indigo-600 text-white rounded-2xl text-sm font-bold shadow-lg shadow-indigo-200 dark:shadow-indigo-900/30 hover:bg-indigo-700 transition-all active:scale-95">
                      <Plus className="w-4 h-4" /> <span className="hidden sm:inline">Add</span> Expense
                    </button>
                  </div>
                </div>
                <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                <table className="w-full text-left border-collapse min-w-[480px] sm:min-w-0">
                  <thead>
                    <tr className="text-slate-400 text-[11px] font-black uppercase tracking-[0.1em]">
                      <th className="px-3 py-4 sm:px-8 sm:py-5">Expense Category</th>
                      <th className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">Budget</th>
                      <th className="px-3 py-4 sm:px-8 sm:py-5">Actual</th>
                      <th className="px-3 py-4 sm:px-8 sm:py-5">Remaining</th>
                      <th className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">Status</th>
                      <th className="px-2 py-4 sm:px-4 sm:py-5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50 dark:divide-slate-700/50">
                    {isAdding && (
                      <tr className="bg-indigo-50/40 dark:bg-indigo-900/20">
                        <td className="px-3 py-4 sm:px-8 sm:py-6"><input className={`w-full ${inputCls}`} placeholder="e.g. Subscriptions" value={newItem.name} onChange={(e) => setNewItem({...newItem, name: e.target.value})} autoFocus /></td>
                        <td className="hidden sm:table-cell px-3 py-4 sm:px-8 sm:py-6" />
                        <td className="px-3 py-4 sm:px-8 sm:py-6"><input type="number" className={`w-20 sm:w-28 ${inputCls}`} placeholder="0.00" value={newItem.amount} onChange={(e) => setNewItem({...newItem, amount: e.target.value})} /></td>
                        <td className="px-3 py-4 sm:px-8 sm:py-6 text-right space-x-2">
                          <button onClick={handleInsert} className="text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2 rounded-xl transition-colors"><Check className="w-5 h-5"/></button>
                          <button onClick={() => setIsAdding(false)} className="text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 p-2 rounded-xl transition-colors"><X className="w-5 h-5"/></button>
                        </td>
                        <td className="hidden sm:table-cell px-8 py-6"><span className="text-xs text-indigo-500 font-bold bg-indigo-100/50 dark:bg-indigo-900/40 px-3 py-1 rounded-full">New Entry</span></td>
                        <td />
                      </tr>
                    )}
                    {expenses.map((item, rowIdx) => (
                      <tr
                        key={item.index_}
                        draggable={editingId !== item.index_}
                        onDragStart={e => handleTableDragStart(e, rowIdx)}
                        onDragOver={e => handleTableDragOver(e, rowIdx)}
                        onDrop={e => handleTableDrop(e, rowIdx)}
                        onDragEnd={handleTableDragEnd}
                        data-rowindex={rowIdx}
                        className={`group transition-all cursor-grab active:cursor-grabbing ${tableDragging === rowIdx ? 'opacity-40' : tableDragOver === rowIdx ? 'bg-indigo-50/60 dark:bg-indigo-900/20 border-t-2 border-indigo-400' : 'hover:bg-slate-50/50 dark:hover:bg-slate-700/30'}`}
                      >
                        <td className="px-3 py-4 sm:px-8 sm:py-5">
                          {editingId === item.index_ ? (
                            <input className={`w-full ${inputCls}`} defaultValue={item.name} id={`edit-name-${item.index_}`} />
                          ) : (
                            <div className="flex items-center gap-2 sm:gap-3">
                              <GripVertical onTouchStart={e => handleGripTouchStart(e, rowIdx)} className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 flex-shrink-0 touch-none select-none opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity" />
                              <button
                                onClick={e => { e.stopPropagation(); setIconPickerFor(item.name); }}
                                title="Change icon"
                                className="text-lg leading-none flex-shrink-0 hover:scale-125 transition-transform select-none"
                              >
                                {categoryIcons[item.name] || '📁'}
                              </button>
                              <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${item.remaining < 0 ? 'bg-rose-400' : item.remaining === 0 ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                              <span className={`font-bold text-slate-700 dark:text-slate-200 text-sm sm:text-base ${hasDetail(item.name) ? 'cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 underline underline-offset-4 decoration-slate-200 dark:decoration-slate-600' : ''}`} onClick={() => handleExpenseClick(item.name)}>{item.name}</span>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                          {editingBudgetId === item.index_ ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="number"
                                value={budgetDraft}
                                onChange={e => setBudgetDraft(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') handleSaveBudget(item); if (e.key === 'Escape') setEditingBudgetId(null); }}
                                autoFocus
                                className={`w-24 ${inputCls}`}
                              />
                              <button onClick={() => handleSaveBudget(item)} className="text-emerald-500 hover:text-emerald-600 p-1"><Check className="w-3.5 h-3.5" /></button>
                              <button onClick={() => setEditingBudgetId(null)} className="text-slate-400 hover:text-slate-500 p-1"><X className="w-3.5 h-3.5" /></button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1.5">
                              <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">{currencySymbol}{item.budget.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                              <button
                                onClick={e => { e.stopPropagation(); setEditingBudgetId(item.index_); setBudgetDraft(item.budget.toFixed(2)); }}
                                title="Edit budget"
                                className="p-1 text-slate-300 dark:text-slate-600 hover:text-indigo-500 transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums text-sm sm:text-base font-black text-slate-800 dark:text-slate-100">
                          {editingId === item.index_ ? <input type="number" className={`w-20 sm:w-28 ${inputCls}`} defaultValue={item.actual} id={`edit-amt-${item.index_}`} /> : `${currencySymbol}${item.actual.toLocaleString(undefined, {minimumFractionDigits: 2})}`}
                        </td>
                        <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums">
                          {editingId === item.index_ ? <input type="number" className={`w-20 sm:w-28 ${inputCls}`} defaultValue={item.remaining} id={`edit-rem-${item.index_}`} /> : (
                            <span className={`font-bold text-sm sm:text-base ${item.remaining < 0 ? 'text-rose-500' : item.remaining === 0 ? 'text-amber-400' : 'text-emerald-500'}`}>{item.remaining < 0 ? '' : '+'}{currencySymbol}{item.remaining.toFixed(2)}</span>
                          )}
                        </td>
                        <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell">
                          <span className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${item.remaining < 0 ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400' : item.remaining === 0 ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'}`}>
                            {item.remaining < 0 ? 'Over' : item.remaining === 0 ? 'Exact' : 'Under'}
                          </span>
                        </td>
                        {/* Row actions */}
                        <td className="px-2 py-4 sm:px-4 sm:py-5">
                          {/* Desktop: faint at rest, full on hover */}
                          <div className="hidden sm:flex items-center gap-1 opacity-20 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={e => { e.stopPropagation(); setRenamingCategory(item); }}
                              title="Rename category"
                              className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={e => { e.stopPropagation(); setDeletingCategory(item); }}
                              title="Delete category"
                              className="p-1.5 rounded-lg text-slate-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {/* Mobile: always-visible ⋯ button */}
                          <button
                            onClick={e => { e.stopPropagation(); setCategoryActionFor(item); }}
                            className="sm:hidden p-2 rounded-xl text-slate-400 dark:text-slate-500 active:bg-slate-100 dark:active:bg-slate-700 transition-colors"
                          >
                            <MoreHorizontal className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-slate-200 dark:border-slate-600 bg-slate-50/80 dark:bg-slate-700/40">
                      <td className="px-3 py-4 sm:px-8 sm:py-5"><span className="text-xs sm:text-sm font-black text-slate-800 dark:text-slate-100 uppercase tracking-wide">Monthly Total</span></td>
                      <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums hidden sm:table-cell"><span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold tabular-nums bg-slate-200 dark:bg-slate-600 text-slate-500 dark:text-slate-400">{currencySymbol}{totalBudget.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></td>
                      <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums"><span className="text-sm sm:text-base font-black text-slate-900 dark:text-slate-100">{currencySymbol}{totalActual.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></td>
                      <td className="px-3 py-4 sm:px-8 sm:py-5 tabular-nums"><span className={`text-sm sm:text-base font-black ${overallRemaining < 0 ? 'text-rose-500' : 'text-emerald-500'}`}>{overallRemaining < 0 ? '' : '+'}{currencySymbol}{overallRemaining.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></td>
                      <td className="px-3 py-4 sm:px-8 sm:py-5 hidden sm:table-cell"><span className={`inline-flex items-center px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-wider ${overallRemaining < 0 ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400' : 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400'}`}>{overallRemaining < 0 ? 'Over' : 'Under'}</span></td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
                </div>
              </div>

              {/* Insight cards */}
              {settings.visibility.insightCards !== false && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-slate-900 dark:bg-slate-800 rounded-[2rem] p-5 sm:p-8 text-white relative overflow-hidden group border border-transparent dark:border-slate-700">
                    <div className="relative z-10">
                      <div className="bg-white/10 w-10 h-10 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center mb-4 sm:mb-6"><Info className="text-indigo-400 w-5 h-5 sm:w-6 sm:h-6" /></div>
                      <h3 className="text-base sm:text-lg font-bold mb-2 sm:mb-3">Balance without random non-monthly expenses</h3>
                      <p className="text-slate-400 text-sm leading-relaxed mb-4 sm:mb-6">
                        If we remove those expenses, we would have had this much left for the month
                        <span className="text-white font-black block text-xl sm:text-2xl mt-2">{currencySymbol}{nonRecurringRemaining.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </p>
                    </div>
                    <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/10 rounded-full -mr-16 -mt-16 blur-2xl" />
                  </div>
                  <div className="bg-indigo-600 dark:bg-indigo-700 rounded-[2rem] p-5 sm:p-8 text-white relative overflow-hidden group">
                    <div className="relative z-10">
                      <div className="bg-white/10 w-10 h-10 sm:w-12 sm:h-12 rounded-2xl flex items-center justify-center mb-4 sm:mb-6"><TrendingUp className="text-white w-5 h-5 sm:w-6 sm:h-6" /></div>
                      <h3 className="text-base sm:text-lg font-bold mb-2 sm:mb-3">Difference between budgeted and actual spent</h3>
                      <p className="text-indigo-100 text-sm leading-relaxed mb-4 sm:mb-6">
                        Calculated difference between what we budgeted and what we spent
                        <span className="text-white font-black block text-xl sm:text-2xl mt-2">{currencySymbol}{potentialDifference.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                      </p>
                      <div className="h-1 w-full bg-white/20 rounded-full overflow-hidden mt-2"><div className="h-full bg-white w-3/4 rounded-full" /></div>
                    </div>
                    <div className="absolute bottom-0 right-0 w-32 h-32 bg-white/10 rounded-full -mr-16 -mb-16 blur-2xl" />
                  </div>
                </div>
              )}

              {/* Non-monthly expenses note */}
              {notesString && settings.visibility.nonMonthlyTile !== false && (
                <div className="bg-white dark:bg-slate-800 rounded-[2rem] p-5 sm:p-8 border border-slate-100 dark:border-slate-700 shadow-sm">
                  <h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 mb-4 flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> Random Non-Monthly Expenses
                  </h4>
                  <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed italic">"{notesString}"</p>
                </div>
              )}

            </div>

            {/* Right column */}
            <div className="space-y-8 lg:sticky lg:top-8">

              {/* Donut chart */}
              {settings.visibility.donutChart !== false && (
                <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] border border-slate-100 dark:border-slate-700 p-5 sm:p-8">
                  <h2 className="text-sm font-black flex items-center gap-2 mb-5 sm:mb-8 text-slate-800 dark:text-slate-100 uppercase tracking-widest">
                    <PieChartIcon className="w-4 h-4 text-indigo-500" /> Distribution
                  </h2>
                  {renderDonutChart()}
                  <div className="mt-6 space-y-3">
                    <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">Top categories · <span className="text-indigo-400">customise in settings</span></p>
                    {chartExpenses.slice(0, settings.donutLegendCount).map((d, i) => (
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
              )}

              {/* Bar chart */}
              {settings.visibility.barChart !== false && (
                <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] border border-slate-100 dark:border-slate-700 p-5 sm:p-8">
                  <h2 className="text-sm font-black flex items-center gap-2 mb-5 sm:mb-8 text-slate-800 dark:text-slate-100 uppercase tracking-widest">
                    <BarChart3 className="w-4 h-4 text-indigo-500" /> Actual vs Budget
                  </h2>
                  {renderBudgetBars()}
                  <div className="mt-10 flex items-center gap-6 text-[10px] font-black text-slate-400 uppercase tracking-[0.1em]">
                    <div className="flex items-center gap-2"><div className="w-4 h-1.5 bg-slate-200 dark:bg-slate-600 rounded-sm" /> Target</div>
                    <div className="flex items-center gap-2"><div className="w-4 h-1.5 bg-emerald-500 rounded-sm" /> Actual</div>
                  </div>
                  {overallRemaining < 0 && (
                    <div className="mt-6 bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40 rounded-[2rem] p-5">
                      <div className="flex items-start gap-4">
                        <div className="bg-rose-500 p-2 rounded-xl flex-shrink-0"><AlertCircle className="w-5 h-5 text-white" /></div>
                        <div>
                          <h4 className="text-sm font-black text-rose-900 dark:text-rose-300 uppercase tracking-tight">Spending Alert</h4>
                          <p className="text-xs text-rose-700/80 dark:text-rose-400/80 mt-1.5 leading-relaxed font-medium">
                            We are currently <span className="font-bold underline decoration-rose-300 underline-offset-4">{currencySymbol}{Math.abs(overallRemaining).toFixed(2)}</span> over our aggregate monthly budget.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
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
        <DetailPanel
          expense={detail.expense}
          rows={detail.rows}
          loading={detail.loading}
          onClose={() => setDetail(null)}
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          onRefresh={handleDetailRefresh}
          currencySymbol={currencySymbol}
        />
      )}

      {showAddDialog && (
        <AddExpenseDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          monthName={selectedMonth?.name}
          categories={expenses.map(e => e.name)}
          onClose={() => setShowAddDialog(false)}
          onSuccess={() => refresh()}
          onSaveRecurring={item => updateSettings(prev => ({
            ...prev,
            recurringExpenses: [
              ...(prev.recurringExpenses || []).filter(
                r => !(r.category === item.category && r.vendor.toLowerCase() === item.vendor.toLowerCase())
              ),
              item,
            ],
          }))}
        />
      )}

      {deleteConfirm && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={() => setDeleteConfirm(null)} />
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
            <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] sm:rounded-[2rem] shadow-2xl w-full sm:max-w-sm border border-rose-100 dark:border-rose-900/40 overflow-hidden max-h-[90vh] flex flex-col">
              <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-1 sm:hidden flex-shrink-0" />
              <div className="px-8 pt-8 pb-6 border-b border-slate-100 dark:border-slate-700 flex-shrink-0">
                <div className="w-12 h-12 bg-rose-50 dark:bg-rose-900/30 rounded-2xl flex items-center justify-center mb-4">
                  <Trash2 className="w-6 h-6 text-rose-500" />
                </div>
                <p className="text-lg font-black text-slate-800 dark:text-slate-100">Remove Month</p>
                <p className="text-xs text-slate-400 mt-1">This removes it from the list. The Google Sheet will <span className="font-bold text-slate-600 dark:text-slate-300">not</span> be deleted.</p>
              </div>
              <div className="px-8 py-6 space-y-4 overflow-y-auto flex-1">
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Type <span className="font-black text-rose-500">{deleteConfirm.name}</span> to confirm:
                </p>
                <input
                  type="text"
                  value={deleteInput}
                  onChange={e => setDeleteInput(e.target.value)}
                  placeholder={deleteConfirm.name}
                  className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-rose-500/40 focus:border-rose-400 placeholder:text-slate-300"
                  autoFocus
                />
              </div>
              <div className="px-8 pb-8 pt-2 flex gap-3 flex-shrink-0" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
                <button
                  onClick={() => setDeleteConfirm(null)}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                >
                  Cancel
                </button>
                <button
                  disabled={deleteInput !== deleteConfirm.name}
                  onClick={async () => {
                    const fallback = months.find(m => m.sheetId !== deleteConfirm.sheetId);
                    setSelectedSheetId(fallback.sheetId);
                    await deleteMonth(deleteConfirm.name);
                    setDeleteConfirm(null);
                    setDeleteInput('');
                  }}
                  className="flex-1 py-3 rounded-2xl text-sm font-bold text-white bg-rose-500 hover:bg-rose-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {showNewMonth && (
        <NewMonthDialog
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
        />
      )}

      <ChatAgent
        expenses={expenses}
        salaryReceived={salaryReceived}
        totalActual={totalActual}
        totalBudget={totalBudget}
        overallRemaining={overallRemaining}
        monthName={selectedMonth?.name}
        accessToken={user.accessToken}
        sheetId={selectedSheetId}
        onRefresh={refresh}
        nonRecurringRemaining={nonRecurringRemaining}
        potentialDifference={potentialDifference}
        notesString={notesString}
        rulesData={rulesData}
      />

      {showSettings && (
        <SettingsPanel
          settings={settings}
          updateSettings={updateSettings}
          expenses={expenses}
          onClose={() => setShowSettings(false)}
          currencySymbol={currencySymbol}
        />
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
        <AddCategoryDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          onClose={() => setShowAddCategory(false)}
          onSuccess={() => refresh()}
          onAddCustomCategory={name => updateSettings(prev => ({
            ...prev,
            customCategories: [...new Set([...(prev.customCategories || []), name])],
          }))}
        />
      )}

      {/* Mobile category action sheet */}
      {categoryActionFor && (
        <>
          <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={() => setCategoryActionFor(null)} />
          <div className="fixed inset-0 z-50 flex items-end justify-center">
            <div className="bg-white dark:bg-slate-800 rounded-t-[2rem] w-full shadow-2xl border border-slate-100 dark:border-slate-700 overflow-hidden">
              <div className="w-10 h-1 bg-slate-200 dark:bg-slate-600 rounded-full mx-auto mt-3 mb-4" />

              {/* Category label */}
              <div className="px-6 pb-3 flex items-center gap-3">
                <span className="text-2xl">{categoryIcons[categoryActionFor.name] || '📁'}</span>
                <div>
                  <p className="text-base font-black text-slate-800 dark:text-slate-100">{categoryActionFor.name}</p>
                  <p className="text-xs text-slate-400">Choose an action</p>
                </div>
              </div>

              <div className="px-4 pb-4 space-y-2" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 1rem)' }}>
                {/* Change icon */}
                <button
                  onClick={() => { setCategoryActionFor(null); setIconPickerFor(categoryActionFor.name); }}
                  className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left bg-slate-50 dark:bg-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-[0.98] transition-all"
                >
                  <div className="w-9 h-9 bg-amber-50 dark:bg-amber-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Smile className="w-5 h-5 text-amber-500" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Change Icon</p>
                    <p className="text-xs text-slate-400">Pick a new emoji</p>
                  </div>
                </button>

                {/* Rename */}
                <button
                  onClick={() => { setCategoryActionFor(null); setRenamingCategory(categoryActionFor); }}
                  className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left bg-slate-50 dark:bg-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-700 active:scale-[0.98] transition-all"
                >
                  <div className="w-9 h-9 bg-indigo-50 dark:bg-indigo-900/30 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Pencil className="w-5 h-5 text-indigo-500" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-slate-700 dark:text-slate-200">Rename Category</p>
                    <p className="text-xs text-slate-400">Change the display name</p>
                  </div>
                </button>

                {/* Delete */}
                <button
                  onClick={() => { setCategoryActionFor(null); setDeletingCategory(categoryActionFor); }}
                  className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl text-left bg-rose-50 dark:bg-rose-900/20 hover:bg-rose-100 dark:hover:bg-rose-900/30 active:scale-[0.98] transition-all"
                >
                  <div className="w-9 h-9 bg-rose-100 dark:bg-rose-900/40 rounded-xl flex items-center justify-center flex-shrink-0">
                    <Trash2 className="w-5 h-5 text-rose-500" />
                  </div>
                  <div>
                    <p className="text-sm font-bold text-rose-600 dark:text-rose-400">Delete Category</p>
                    <p className="text-xs text-rose-400/70 dark:text-rose-500/60">Permanently remove</p>
                  </div>
                </button>

                {/* Cancel */}
                <button
                  onClick={() => setCategoryActionFor(null)}
                  className="w-full py-4 rounded-2xl text-sm font-bold text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors mt-1"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {renamingCategory && (
        <RenameCategoryDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          category={renamingCategory}
          onClose={() => setRenamingCategory(null)}
          onSuccess={() => { refresh(); setRenamingCategory(null); }}
        />
      )}

      {deletingCategory && (
        <DeleteCategoryDialog
          accessToken={user.accessToken}
          sheetId={selectedSheetId}
          category={deletingCategory}
          onClose={() => setDeletingCategory(null)}
          onSuccess={() => { refresh(); setDeletingCategory(null); }}
        />
      )}
    </div>
  );
}

function StatCard({ title, value, icon, color, subtext, onEdit, currencySymbol = '$' }) {
  const colorClasses = {
    blue: "bg-blue-50/50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 border-blue-100/50 dark:border-blue-800/40",
    rose: "bg-rose-50/50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border-rose-100/50 dark:border-rose-800/40",
    emerald: "bg-emerald-50/50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 border-emerald-100/50 dark:border-emerald-800/40",
    indigo: "bg-indigo-50/50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border-indigo-100/50 dark:border-indigo-800/40",
  };
  return (
    <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 p-5 sm:p-8 space-y-4 sm:space-y-6 shadow-[0_8px_30px_rgb(0,0,0,0.02)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.15)] transition-all hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] hover:-translate-y-1">
      <div className="flex justify-between items-start gap-4">
        <div className={`p-3 sm:p-4 rounded-2xl border flex-shrink-0 ${colorClasses[color]}`}>
          {React.cloneElement(icon, { className: "w-5 h-5 sm:w-7 sm:h-7" })}
        </div>
        <div className="text-right">
          <div className="flex items-center justify-end gap-1.5 mb-2">
            <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{title}</p>
            {onEdit && (
              <button
                onClick={onEdit}
                title="Edit"
                className="p-1 rounded-lg text-slate-300 dark:text-slate-600 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-all flex-shrink-0"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
          </div>
          <p className="text-2xl sm:text-4xl font-black text-slate-900 dark:text-slate-100 tabular-nums leading-none">{currencySymbol}{value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
      </div>
      {subtext && (
        <div className="flex items-center gap-2 pt-3 border-t border-slate-50 dark:border-slate-700">
          <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-600" />
          <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">{subtext}</p>
        </div>
      )}
    </div>
  );
}

function IconPickerModal({ categoryName, currentIcon, onPick, onClose }) {
  const [search, setSearch] = React.useState('');
  const q = search.toLowerCase().trim();
  const filtered = q
    ? EMOJI_DATA.filter(({ k }) => k.some(kw => kw.includes(q))).map(({ e }) => e)
    : EMOJI_DATA.map(({ e }) => e);

  return (
    <>
      <div className="fixed inset-0 bg-black/40 dark:bg-black/60 z-40 backdrop-blur-sm" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] shadow-2xl w-full max-w-sm border border-slate-100 dark:border-slate-700 overflow-hidden flex flex-col max-h-[85vh]">

          {/* Header */}
          <div className="px-6 pt-6 pb-4 border-b border-slate-100 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
            <div>
              <p className="text-sm font-black text-slate-800 dark:text-slate-100">Choose an icon</p>
              <p className="text-xs text-slate-400 mt-0.5">{categoryName}</p>
            </div>
            <span className="text-3xl leading-none">{currentIcon}</span>
          </div>

          {/* Search */}
          <div className="px-4 pt-4 pb-2 flex-shrink-0">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search  (e.g. food, car, home…)"
              autoFocus
              className="w-full bg-slate-50 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600 text-slate-900 dark:text-slate-100 rounded-2xl px-4 py-2.5 text-sm outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-400 placeholder:text-slate-300 dark:placeholder:text-slate-500"
            />
          </div>

          {/* Grid */}
          <div className="flex-1 overflow-y-auto p-3">
            {filtered.length === 0 ? (
              <p className="text-center text-sm text-slate-400 py-8">No results for "{search}"</p>
            ) : (
              <div className="grid grid-cols-8 gap-0.5">
                {filtered.map(emoji => (
                  <button
                    key={emoji}
                    onClick={() => onPick(emoji)}
                    className={`text-xl p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors ${currentIcon === emoji ? 'bg-indigo-50 dark:bg-indigo-900/30 ring-2 ring-inset ring-indigo-400' : ''}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 pb-6 pt-2 flex-shrink-0">
            <button onClick={onClose} className="w-full py-2.5 rounded-2xl text-sm font-bold text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              Cancel
            </button>
          </div>

        </div>
      </div>
    </>
  );
}

export default App;
