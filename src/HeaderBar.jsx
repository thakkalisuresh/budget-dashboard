import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { RefreshCw, AlertCircle, Sun, Moon, ChevronDown, Settings as SettingsIcon, LogOut } from 'lucide-react';
import { ThemePicker } from './ThemePicker.jsx';
import { StackMark } from './StackMark.jsx';

function RelativeTime({ date }) {
  const [label, setLabel] = useState('');

  useEffect(() => {
    const update = () => {
      const secs = Math.floor((Date.now() - date.getTime()) / 1000);
      if (secs < 60)        setLabel('just now');
      else if (secs < 3600) setLabel(`${Math.floor(secs / 60)}m ago`);
      else                  setLabel(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    };
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [date]);

  return <>{label}</>;
}

const TABS = [
  ['budget',  'Dashboard'],
  ['ledger',  'Ledger'],
  ['history', 'History'],
  ['cards',   'Cards'],
  ['split',   'Split'],
];

function TabSwitcher({ activeTab, setActiveTab }) {
  const tabIdx = TABS.findIndex(([t]) => t === activeTab);
  const tabRefs = useRef([]);
  const pillReady = useRef(false); // false until first measure → no slide-in on cold load
  const [pill, setPill] = useState(null); // { left, width } | null

  // Position the pill from the active tab's real rendered geometry.
  // Content-width tabs ("Dashboard" ≫ "Split") make equal-fifths math drift, so we measure.
  useLayoutEffect(() => {
    const measure = () => {
      const el = tabRefs.current[tabIdx];
      if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    // Geist loads async — remeasure once fonts settle (fixes cold-load misalignment)
    document.fonts?.ready.then(measure).catch(() => {});
    return () => window.removeEventListener('resize', measure);
  }, [tabIdx]);

  return (
    <div
      role="tablist"
      className="relative flex p-1 rounded-xl"
      style={{ background: 'var(--sur-8)' }}
    >
      {/* Sliding pill — positioned from measured geometry */}
      {pill && (
        <div
          aria-hidden="true"
          className="absolute top-1 bottom-1 rounded-lg pointer-events-none"
          style={{
            background: 'var(--sur-20)',
            boxShadow: '0 1px 3px oklch(0% 0 0 / 30%)',
            left: `${pill.left}px`,
            width: `${pill.width}px`,
            transition: pillReady.current
              ? 'left 150ms var(--ease-out), width 150ms var(--ease-out)'
              : 'none',
          }}
          ref={() => { pillReady.current = true; }}
        />
      )}
      {TABS.map(([tab, label], i) => (
        <button
          key={tab}
          ref={el => (tabRefs.current[i] = el)}
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => setActiveTab(tab)}
          className="relative px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors duration-150 whitespace-nowrap focus:outline-none focus-visible:outline-none"
          style={{
            color: activeTab === tab
              ? 'var(--color-text)'
              : 'var(--color-text-muted)',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function UserMenu({ user, signOut, setShowSettings, setShowReconcile, setShowUserMenu, showUserMenu, userMenuRef, isMonthEnded, selectedMonth }) {
  return (
    <div className="relative" ref={userMenuRef}>
      <button
        onClick={() => setShowUserMenu(v => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-xl transition-colors duration-150 active:scale-[0.98]"
        style={{ background: 'var(--sur-8)' }}
      >
        {user.picture ? (
          <img src={user.picture} alt={user.name} className="w-5 h-5 rounded-full flex-shrink-0" referrerPolicy="no-referrer" />
        ) : (
          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black text-white flex-shrink-0"
            style={{ background: 'var(--color-accent)' }}>
            {user.name?.[0]?.toUpperCase()}
          </div>
        )}
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          {user.name?.split(' ')[0]}
        </span>
        <ChevronDown
          className="w-3.5 h-3.5 transition-transform duration-200"
          style={{ color: 'var(--color-text-muted)', transform: showUserMenu ? 'rotate(180deg)' : undefined }}
        />
      </button>

      {showUserMenu && (
        <div className="absolute right-0 top-full mt-2 w-48 glass-medium rounded-xl overflow-hidden z-30 animate-dropdown"
          style={{ border: '1px solid var(--sur-10)' }}>
          <button
            onClick={() => { setShowUserMenu(false); setShowSettings(true); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold transition-colors duration-150 hover:bg-[var(--sur-5)]"
            style={{ color: 'var(--color-text)' }}
          >
            <SettingsIcon className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
            Settings
          </button>
          <div className="h-px" style={{ background: 'var(--sur-8)' }} />
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
            className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold transition-colors duration-150 hover:bg-[var(--sur-5)]"
            style={{ color: 'var(--color-accent-text)' }}
          >
            <RefreshCw className="w-4 h-4" />
            Clear cache
          </button>
          {isMonthEnded && (
            <>
              <div className="h-px" style={{ background: 'var(--sur-8)' }} />
              <button
                onClick={() => { setShowUserMenu(false); setShowReconcile(true); }}
                className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold transition-colors duration-150 hover:bg-[var(--sur-5)]"
                style={{ color: 'var(--color-text)' }}
              >
                <RefreshCw className="w-4 h-4" style={{ color: 'var(--color-text-muted)' }} />
                Reconcile {selectedMonth?.name}
              </button>
            </>
          )}
          <div className="h-px" style={{ background: 'var(--sur-8)' }} />
          <button
            onClick={() => { setShowUserMenu(false); signOut(); }}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm font-semibold transition-colors duration-150 hover:bg-[var(--sur-5)]"
            style={{ color: 'var(--color-danger)' }}
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </button>
          <div className="px-4 py-2 text-[10px] font-mono border-t" style={{ color: 'var(--color-text-muted)', borderColor: 'var(--sur-8)' }}>
            v{__APP_VERSION__} · {new Date(__BUILD_TIME__).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).replace(',', '')}
          </div>
        </div>
      )}
    </div>
  );
}

export function HeaderBar({
  loading, lastUpdated, error, refresh, shareAllMonths,
  isDark, setIsDark,
  showMessages, setShowMessages, messages, unreadCount, markAllRead, dismissMessage, clearMessages,
  showUserMenu, setShowUserMenu, userMenuRef,
  user, signOut,
  setShowSettings, setShowReconcile,
  isMonthEnded, selectedMonth,
  activeTab, setActiveTab,
}) {
  const userMenuProps = { user, signOut, setShowSettings, setShowReconcile, setShowUserMenu, showUserMenu, userMenuRef, isMonthEnded, selectedMonth };

  return (
    <>
      {/* ── Desktop glass header (lg+) ────────────────────────────────────────── */}
      <header className="hidden lg:flex fixed top-0 inset-x-0 z-50 h-16 glass-heavy items-center px-6 gap-4"
        style={{ borderBottom: '1px solid var(--sur-8)' }}>

        {/* Left: logo + status */}
        <div className="flex items-center gap-3 flex-shrink-0 min-w-0 w-52">
          <StackMark size={28} />
          <span className="text-base font-black tracking-tight" style={{ color: 'var(--color-text)' }}>
            Budget
          </span>
          {/* Live status */}
          {lastUpdated && !error && (
            <div className="flex items-center gap-1.5 ml-1">
              <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0 animate-sonar text-emerald-400" />
              <button onClick={refresh} title="Refresh" className="transition-colors duration-150 active:scale-90"
                style={{ color: 'var(--color-text-muted)' }}>
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          )}
          {error && (
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--color-danger)' }} />
          )}
          {loading && !lastUpdated && (
            <RefreshCw className="w-3 h-3 animate-spin flex-shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          )}
        </div>

        {/* Center: tab switcher */}
        {activeTab !== undefined && setActiveTab && (
          <div className="flex-1 flex justify-center">
            <TabSwitcher activeTab={activeTab} setActiveTab={setActiveTab} />
          </div>
        )}

        {/* Right: controls */}
        <div className="flex items-center gap-2 flex-shrink-0 w-52 justify-end">
          <ThemePicker />
          <button
            onClick={() => setIsDark(d => !d)}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-2 rounded-xl transition-colors duration-150"
            style={{ background: 'var(--sur-8)', color: 'var(--color-text-muted)' }}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <UserMenu {...userMenuProps} />
        </div>
      </header>

      {/* ── Mobile inline controls (below lg) ────────────────────────────────── */}
      <div className="lg:hidden flex flex-wrap justify-between items-center gap-3">
        {/* Status */}
        <div className="flex items-center gap-3 min-h-[28px]">
          {loading && !lastUpdated && (
            <span className="text-xs flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
              <RefreshCw className="w-3 h-3 animate-spin" />
              Syncing…
            </span>
          )}
          {error && (
            <span className="text-xs flex items-center gap-1.5 flex-wrap" style={{ color: 'var(--color-danger)' }}>
              <AlertCircle className="w-3 h-3 flex-shrink-0" />
              {error}
              {(error.toLowerCase().includes('permission') || error.toLowerCase().includes('access denied')) && (
                <button
                  onClick={async () => {
                    try { await shareAllMonths(); refresh(); } catch { /* non-fatal */ }
                  }}
                  className="ml-1 px-2 py-0.5 rounded-lg font-bold transition-colors duration-150"
                  style={{ background: 'var(--color-danger)', color: 'white' }}
                >
                  Fix permissions
                </button>
              )}
            </span>
          )}
          {lastUpdated && !error && (
            <div className="flex items-center gap-2">
              <span className="relative w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0 animate-sonar text-emerald-400" />
              <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                Live · <RelativeTime date={lastUpdated} />
              </span>
              <button onClick={refresh} title="Refresh"
                className="transition-colors duration-150 ml-0.5 active:scale-90"
                style={{ color: 'var(--color-text-muted)' }}>
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2">
          <ThemePicker />
          <button
            onClick={() => setIsDark(d => !d)}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-3 rounded-xl border shadow-sm transition-colors duration-150"
            style={{
              background: 'var(--color-surface)',
              borderColor: 'var(--sur-10)',
              color: 'var(--color-text-muted)',
            }}
          >
            {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <UserMenu {...userMenuProps} />
        </div>
      </div>
    </>
  );
}
