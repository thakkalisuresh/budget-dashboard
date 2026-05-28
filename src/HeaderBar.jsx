import React, { useState, useEffect } from 'react';
import { RefreshCw, AlertCircle, Sun, Moon, ChevronDown, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { ThemePicker } from './ThemePicker.jsx';

function RelativeTime({ date }) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    const update = () => {
      const secs = Math.floor((Date.now() - date.getTime()) / 1000);
      if (secs < 60)       setLabel('just now');
      else if (secs < 3600) setLabel(`${Math.floor(secs / 60)}m ago`);
      else                  setLabel(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [date]);

  return <>{label}</>;
}

export function HeaderBar({
  loading, lastUpdated, error, refresh, shareAllMonths,
  isDark, setIsDark,
  showMessages, setShowMessages, messages, unreadCount, markAllRead, dismissMessage, clearMessages,
  showUserMenu, setShowUserMenu, userMenuRef,
  user, signOut,
  setShowSettings, setShowReconcile,
  isMonthEnded, selectedMonth,
}) {
  return (
    <div className="flex flex-wrap justify-between items-center gap-3">
      {/* Status — left */}
      <div className="flex items-center gap-3 min-h-[28px]">
        {loading && !lastUpdated && (
          <span className="text-xs text-slate-400 flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Syncing…
          </span>
        )}
        {error && (
          <span className="text-xs text-rose-500 flex items-center gap-1.5 flex-wrap">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            {error}
            {(error.toLowerCase().includes('permission') || error.toLowerCase().includes('access denied')) && (
              <button
                onClick={async () => {
                  try { await shareAllMonths(); refresh(); } catch { /* non-fatal */ }
                }}
                className="ml-1 px-2 py-0.5 bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400 rounded-lg font-bold hover:bg-rose-200 dark:hover:bg-rose-900/60 transition-colors duration-[150ms]"
              >
                Fix permissions
              </button>
            )}
          </span>
        )}
        {lastUpdated && !error && (
          <div className="flex items-center gap-2">
            <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0 animate-sonar text-emerald-400" />
            <span className="text-xs text-slate-400">
              Live · <RelativeTime date={lastUpdated} />
            </span>
            <button
              onClick={refresh}
              title="Refresh"
              className="text-slate-400 hover:text-indigo-500 transition-colors duration-[150ms] ml-0.5 active:scale-90"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {/* Controls — right */}
      <div className="flex items-center gap-2">
        {/* Theme color picker */}
        <ThemePicker />

        {/* Theme toggle */}
        <button
          onClick={() => setIsDark(d => !d)}
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
          className="p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 shadow-sm transition-colors duration-[150ms]"
        >
          {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        {/* User menu */}
        <div className="relative" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(v => !v)}
            className="flex items-center gap-2 px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-sm hover:border-indigo-300 dark:hover:border-indigo-600 transition-colors duration-[150ms] active:scale-[0.98]"
          >
            {user.picture && (
              <img src={user.picture} alt={user.name} className="w-5 h-5 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
            )}
            <span className="hidden sm:inline text-sm font-semibold text-slate-700 dark:text-slate-200">
              {user.name.split(' ')[0]}
            </span>
            <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`} />
          </button>

          {showUserMenu && (
            <div className="absolute right-0 top-full mt-2 w-44 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden z-30 animate-dropdown">
              <button
                onClick={() => { setShowUserMenu(false); setShowSettings(true); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors duration-[150ms]"
              >
                <SettingsIcon className="w-4 h-4 text-slate-400" />
                Settings
              </button>
              <div className="h-px bg-slate-100 dark:bg-slate-700" />
              <button
                onClick={async () => {
                  setShowUserMenu(false);
                  try {
                    const cacheNames = await caches.keys();
                    await Promise.all(cacheNames.map(n => caches.delete(n)));
                    const regs = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(regs.map(r => r.unregister()));
                  } catch { /* ignore if SW not supported */ }
                  window.location.reload(true);
                }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors duration-[150ms]"
              >
                <RefreshCw className="w-4 h-4" />
                Clear cache
              </button>
              {isMonthEnded && (
                <>
                  <div className="h-px bg-slate-100 dark:bg-slate-700" />
                  <button
                    onClick={() => { setShowUserMenu(false); setShowReconcile(true); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors duration-[150ms]"
                  >
                    <RefreshCw className="w-4 h-4 text-slate-400" />
                    Reconcile {selectedMonth?.name}
                  </button>
                </>
              )}
              <div className="h-px bg-slate-100 dark:bg-slate-700" />
              <button
                onClick={() => { setShowUserMenu(false); signOut(); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors duration-[150ms]"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
              <div className="px-4 py-2 text-[10px] text-slate-400 font-mono border-t border-slate-100 dark:border-slate-700">
                v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).replace(',', '')}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
