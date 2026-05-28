import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { WifiOff } from 'lucide-react';

export function LoginScreen({ onSuccess, onError, loading, denied }) {
  const login = useGoogleLogin({
    onSuccess,
    onError,
    flow: 'implicit',
    // NOTE: drive scope deliberately omitted. The default session only needs
    // Sheets API. Drive (template copy + sharing) is requested just-in-time
    // when the user creates a new month — see requestDriveToken() in driveAuth.js.
    scope: 'openid email profile https://www.googleapis.com/auth/spreadsheets',
  });

  return (
    <div className="min-h-screen bg-[#fcfdfe] dark:bg-slate-950 flex items-center justify-center p-6 transition-colors duration-300">
      <div className="w-full max-w-sm">
        {/* Card */}
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 shadow-[0_8px_40px_rgb(0,0,0,0.06)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.3)] p-10 text-center space-y-8">

          {/* Icon */}
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-indigo-50 dark:bg-indigo-900/30 rounded-2xl flex items-center justify-center">
              <svg className="w-8 h-8 text-indigo-600 dark:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
          </div>

          {/* Title */}
          <div className="space-y-2">
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Budget Tracker</h1>
            <p className="text-sm text-slate-400">Sign in to access the dashboard</p>
          </div>

          {/* Error state */}
          {denied && (
            <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-100 dark:border-rose-800/40 rounded-2xl px-5 py-4">
              <p className="text-sm font-bold text-rose-600 dark:text-rose-400">Access denied</p>
              <p className="text-xs text-rose-500/80 dark:text-rose-400/70 mt-1">This Google account is not authorised. Please use your personal account.</p>
            </div>
          )}

          {/* Sign in button */}
          <button
            onClick={() => login()}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-3.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-2xl text-sm font-bold text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-600 hover:border-slate-300 dark:hover:border-slate-500 shadow-sm transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <svg className="w-5 h-5 animate-spin text-slate-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            )}
            {loading ? 'Signing in…' : 'Sign in with Google'}
          </button>

          <p className="text-[11px] text-slate-300 dark:text-slate-600">Private — access restricted to authorised users only</p>
        </div>
      </div>
    </div>
  );
}

export function OfflineUnlockScreen({ onUnlock, onSignInInstead }) {
  const [status, setStatus] = useState('idle'); // 'idle' | 'verifying' | 'failed'

  const cached = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('budget_auth_cache') || 'null'); } catch { return null; }
  }, []);

  const attempt = useCallback(async () => {
    setStatus('verifying');
    const ok = await onUnlock();
    if (!ok) setStatus('failed');
    // on success, parent sets user → component unmounts
  }, [onUnlock]);

  // Auto-trigger on mount with a short delay so the screen renders first
  useEffect(() => {
    const t = setTimeout(attempt, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-[#fcfdfe] dark:bg-slate-950 flex items-center justify-center p-6 transition-colors duration-300">
      <div className="w-full max-w-sm">
        <div className="bg-white dark:bg-slate-800 rounded-[2rem] border border-slate-100 dark:border-slate-700 shadow-[0_8px_40px_rgb(0,0,0,0.06)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.3)] p-10 text-center space-y-6">

          {/* Avatar or fallback icon */}
          <div className="flex justify-center">
            {cached?.picture ? (
              <div className="relative">
                <img src={cached.picture} alt="" className="w-16 h-16 rounded-2xl object-cover" referrerPolicy="no-referrer" />
                <div className="absolute -bottom-1.5 -right-1.5 w-6 h-6 bg-slate-100 dark:bg-slate-700 rounded-lg flex items-center justify-center shadow-sm">
                  <WifiOff className="w-3 h-3 text-slate-400" />
                </div>
              </div>
            ) : (
              <div className="w-16 h-16 bg-slate-100 dark:bg-slate-700 rounded-2xl flex items-center justify-center">
                <WifiOff className="w-7 h-7 text-slate-400" />
              </div>
            )}
          </div>

          {/* Greeting */}
          <div className="space-y-1.5">
            <h1 className="text-xl font-black text-slate-900 dark:text-white tracking-tight">
              {cached?.name ? `Hi, ${cached.name.split(' ')[0]}` : 'You\'re offline'}
            </h1>
            <p className="text-sm text-slate-400">Verify to continue with cached data</p>
          </div>

          {/* Status area */}
          {status === 'verifying' && (
            <div className="flex items-center justify-center gap-2 text-sm text-slate-400 py-1">
              <svg className="w-4 h-4 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Verifying…
            </div>
          )}

          {status === 'idle' && (
            <p className="text-xs text-slate-300 dark:text-slate-600 py-1">
              Use Face ID or fingerprint to continue
            </p>
          )}

          {status === 'failed' && (
            <div className="space-y-3">
              <p className="text-sm text-rose-500">Biometric verification failed</p>
              <button
                onClick={attempt}
                className="w-full py-3 bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-2xl text-sm font-bold active:scale-[0.97] transition-all"
              >
                Try again
              </button>
              <button
                onClick={onSignInInstead}
                className="w-full py-2 text-sm text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                Sign in with Google instead
              </button>
            </div>
          )}

          <p className="text-[11px] text-slate-300 dark:text-slate-600">
            Read-only · Edits sync when reconnected
          </p>
        </div>
      </div>
    </div>
  );
}
