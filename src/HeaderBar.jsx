import React from 'react';
import { RefreshCw, AlertCircle, Sun, Moon, Bell, ChevronDown, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { MessagesPanel } from './MessagesPanel.jsx';

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
      {/* Status left side */}
      <div className="flex items-center gap-3">
        {loading && !lastUpdated && (
          <span className="text-xs text-slate-400 flex items-center gap-1.5">
            <RefreshCw className="w-3 h-3 animate-spin" /> Loading from Google Sheets…
          </span>
        )}
        {error && (
          <span className="text-xs text-rose-500 flex items-center gap-1.5 flex-wrap">
            <AlertCircle className="w-3 h-3 flex-shrink-0" /> {error}
            {(error.toLowerCase().includes('permission') || error.toLowerCase().includes('access denied')) && (
              <button
                onClick={async () => {
                  try {
                    await shareAllMonths();
                    refresh();
                  } catch { /* non-fatal */ }
                }}
                className="ml-1 px-2 py-0.5 bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400 rounded-lg font-bold hover:bg-rose-200 dark:hover:bg-rose-900/60 transition-colors"
              >
                Fix permissions
              </button>
            )}
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

      {/* Controls right side */}
      <div className="flex items-center gap-2">
        {/* Theme toggle */}
        <button
          onClick={() => setIsDark(d => !d)}
          className="p-2.5 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 shadow-sm transition-all"
        >
          {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
        </button>

        {/* Messages button */}
        <div className="relative">
          <button
            onClick={() => { setShowMessages(v => !v); if (showMessages) markAllRead(); }}
            className="relative p-2.5 rounded-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 shadow-sm transition-all"
            title="Messages"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-rose-500 text-white text-[10px] font-black flex items-center justify-center px-1">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {showMessages && (
            <>
              {/* Backdrop — closes panel on outside click */}
              <div className="fixed inset-0 z-40" onClick={() => { setShowMessages(false); markAllRead(); }} />

              {/* Desktop: dropdown anchored below bell button */}
              <div className="hidden sm:block absolute right-0 top-full mt-2 w-96 z-50">
                <MessagesPanel
                  messages={messages}
                  unreadCount={unreadCount}
                  onMarkAllRead={markAllRead}
                  onDismiss={dismissMessage}
                  onClearAll={clearMessages}
                  onClose={() => { setShowMessages(false); markAllRead(); }}
                />
              </div>

              {/* Mobile: fixed bottom sheet */}
              <div className="sm:hidden fixed bottom-0 left-0 right-0 z-50">
                <MessagesPanel
                  messages={messages}
                  unreadCount={unreadCount}
                  onMarkAllRead={markAllRead}
                  onDismiss={dismissMessage}
                  onClearAll={clearMessages}
                  onClose={() => { setShowMessages(false); markAllRead(); }}
                />
              </div>
            </>
          )}
        </div>

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
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Clear cache & refresh
              </button>
              {isMonthEnded && (
                <>
                  <div className="h-px bg-slate-100 dark:bg-slate-700" />
                  <button
                    onClick={() => { setShowUserMenu(false); setShowReconcile(true); }}
                    className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4 text-slate-400" />
                    Reconcile {selectedMonth?.name}
                  </button>
                </>
              )}
              <div className="h-px bg-slate-100 dark:bg-slate-700" />
              <button
                onClick={() => { setShowUserMenu(false); signOut(); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-bold text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
              <div className="px-4 py-2 text-[10px] text-slate-400 font-mono border-t border-slate-100 dark:border-slate-700">
                v{__APP_VERSION__} · {__COMMIT_SHA__} · {new Date(__BUILD_TIME__).toLocaleDateString()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
