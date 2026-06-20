import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import { WifiOff } from 'lucide-react';
import { registerLoginBiometric } from './biometricLogin.js';

export function LoginScreen({ onSuccess, onError, loading, denied }) {
  const login = useGoogleLogin({
    onSuccess,
    onError,
    flow: 'implicit',
    scope: 'openid email profile https://www.googleapis.com/auth/spreadsheets',
  });

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6 transition-colors duration-300"
      style={{ background: 'var(--color-bg)' }}
    >
      <div className="w-full max-w-sm">
        <div
          className="glass-heavy rounded-[2rem] p-10 text-center space-y-8"
          style={{ border: '1px solid var(--sur-10)' }}
        >

          {/* Icon */}
          <div className="flex justify-center">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
            >
              <svg className="w-8 h-8" style={{ color: 'var(--color-accent-text)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
          </div>

          {/* Title */}
          <div className="space-y-2">
            <h1 className="text-2xl font-black tracking-tight" style={{ color: 'var(--color-text)' }}>Budget Tracker</h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Sign in to access the dashboard</p>
          </div>

          {/* Error state */}
          {denied && (
            <div
              className="rounded-2xl px-5 py-4"
              style={{ background: 'oklch(62% 0.22 25 / 10%)', border: '1px solid oklch(62% 0.22 25 / 25%)' }}
            >
              <p className="text-sm font-bold" style={{ color: 'var(--color-danger)' }}>Access denied</p>
              <p className="text-xs mt-1" style={{ color: 'oklch(62% 0.22 25 / 70%)' }}>This Google account is not authorised. Please use your personal account.</p>
            </div>
          )}

          {/* Sign in button */}
          <button
            onClick={() => login()}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-3.5 rounded-2xl text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: 'var(--sur-6)', border: '1px solid var(--sur-12)', color: 'var(--color-text)' }}
          >
            {loading ? (
              <svg className="w-5 h-5 animate-spin" style={{ color: 'var(--color-text-muted)' }} viewBox="0 0 24 24" fill="none">
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

          <p className="text-[11px]" style={{ color: 'var(--sur-20)' }}>Private — access restricted to authorised users only</p>
        </div>
      </div>
    </div>
  );
}

export function MobileLoginScreen({ onBiometricLogin, onSignInInstead, loading, denied, onSuccess, onError }) {
  const [status, setStatus] = useState('idle');
  const bioLabel = /iPhone|iPad/.test(navigator.userAgent) ? 'Face ID' : 'Fingerprint';

  const cached = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('budget_auth_cache') || 'null'); } catch { return null; }
  }, []);

  const attempt = useCallback(async () => {
    setStatus('verifying');
    const result = await onBiometricLogin();
    if (!result.ok) {
      // reason='token' → biometric passed but no valid token; go straight to Google auth
      // reason='biometric' → Face ID/fingerprint genuinely failed; show retry
      setStatus(result.reason === 'token' ? 'google' : 'failed');
    }
  }, [onBiometricLogin]);

  useEffect(() => {
    const t = setTimeout(attempt, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (status === 'google') {
    return <LoginScreen onSuccess={onSuccess} onError={onError} loading={loading} denied={denied} />;
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6 transition-colors duration-300"
      style={{ background: 'var(--color-bg)' }}
    >
      <div className="w-full max-w-sm">
        <div
          className="glass-heavy rounded-[2rem] p-10 text-center space-y-6"
          style={{ border: '1px solid var(--sur-10)' }}
        >
          <div className="flex justify-center">
            {cached?.picture ? (
              <img src={cached.picture} alt="" className="w-16 h-16 rounded-2xl object-cover" referrerPolicy="no-referrer" />
            ) : (
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center"
                style={{ background: 'var(--color-accent-subtle)', border: '1px solid var(--color-accent-border)' }}
              >
                <svg className="w-8 h-8" style={{ color: 'var(--color-accent-text)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <h1 className="text-xl font-black tracking-tight" style={{ color: 'var(--color-text)' }}>
              {cached?.name ? `Hi, ${cached.name.split(' ')[0]}` : 'Welcome back'}
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
              Use {bioLabel} to sign in
            </p>
          </div>

          {status === 'verifying' && (
            <div className="flex items-center justify-center gap-2 text-sm py-1" style={{ color: 'var(--color-text-muted)' }}>
              <svg className="w-4 h-4 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Signing in…
            </div>
          )}

          {status === 'idle' && (
            <p className="text-xs py-1" style={{ color: 'var(--sur-20)' }}>
              Waiting for {bioLabel}…
            </p>
          )}

          {status === 'failed' && (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--color-danger)' }}>{bioLabel} verification failed</p>
              <button
                onClick={attempt}
                className="w-full py-3 rounded-2xl text-sm font-bold text-white active:scale-[0.97] transition-all"
                style={{ background: 'var(--color-text)' }}
              >
                Try again
              </button>
              <button
                onClick={() => setStatus('google')}
                className="w-full py-2 text-sm transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Sign in with Google instead
              </button>
            </div>
          )}

          {status !== 'failed' && (
            <button
              onClick={() => setStatus('google')}
              className="w-full py-2 text-sm transition-colors"
              style={{ color: 'var(--sur-20)' }}
            >
              Sign in with Google instead
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function BiometricSetupSheet({ email, onDismiss }) {
  const [status, setStatus] = useState('idle');
  const bioLabel = /iPhone|iPad/.test(navigator.userAgent) ? 'Face ID' : 'fingerprint';

  const [errorMsg, setErrorMsg] = useState('');

  const handleAccept = async () => {
    setStatus('registering');
    const result = await registerLoginBiometric(email);
    if (result?.ok) {
      setStatus('done');
      setTimeout(onDismiss, 800);
    } else {
      setErrorMsg(result?.error || 'Unknown error');
      setStatus('failed');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center p-4"
      style={{ background: 'oklch(0% 0 0 / 60%)' }}
    >
      <div
        className="glass-heavy w-full max-w-sm rounded-[2rem] p-8 text-center space-y-5"
        style={{
          border: '1px solid var(--sur-10)',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 2rem)',
        }}
      >
        <div className="space-y-2">
          <p className="text-lg font-black" style={{ color: 'var(--color-text)' }}>
            Enable {bioLabel} login?
          </p>
          <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>
            Skip Google sign-in next time — unlock instantly with {bioLabel}.
          </p>
        </div>

        {status === 'done' && (
          <p className="text-sm font-bold" style={{ color: 'var(--color-accent-text)' }}>
            All set! {bioLabel.charAt(0).toUpperCase() + bioLabel.slice(1)} enabled.
          </p>
        )}
        {status === 'failed' && (
          <p className="text-sm" style={{ color: 'var(--color-danger)' }}>
            Registration failed{errorMsg ? `: ${errorMsg}` : ''}.
          </p>
        )}

        {status !== 'done' && (
          <button
            onClick={handleAccept}
            disabled={status === 'registering'}
            className="w-full py-3.5 rounded-2xl text-sm font-black text-white transition-all active:scale-[0.97] disabled:opacity-60"
            style={{ background: 'var(--color-accent)' }}
          >
            {status === 'registering' ? 'Registering…' : `Enable ${bioLabel}`}
          </button>
        )}

        <button
          onClick={onDismiss}
          className="w-full py-2 text-sm transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {status === 'failed' ? 'Dismiss' : 'Not now'}
        </button>
      </div>
    </div>
  );
}

export function OfflineUnlockScreen({ onUnlock, onSignInInstead }) {
  const [status, setStatus] = useState('idle');

  const cached = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('budget_auth_cache') || 'null'); } catch { return null; }
  }, []);

  const attempt = useCallback(async () => {
    setStatus('verifying');
    const ok = await onUnlock();
    if (!ok) setStatus('failed');
  }, [onUnlock]);

  useEffect(() => {
    const t = setTimeout(attempt, 250);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6 transition-colors duration-300"
      style={{ background: 'var(--color-bg)' }}
    >
      <div className="w-full max-w-sm">
        <div
          className="glass-heavy rounded-[2rem] p-10 text-center space-y-6"
          style={{ border: '1px solid var(--sur-10)' }}
        >

          {/* Avatar or fallback icon */}
          <div className="flex justify-center">
            {cached?.picture ? (
              <div className="relative">
                <img src={cached.picture} alt="" className="w-16 h-16 rounded-2xl object-cover" referrerPolicy="no-referrer" />
                <div
                  className="absolute -bottom-1.5 -right-1.5 w-6 h-6 rounded-lg flex items-center justify-center"
                  style={{ background: 'var(--color-surface)', border: '1px solid var(--sur-10)' }}
                >
                  <WifiOff className="w-3 h-3" style={{ color: 'var(--color-text-muted)' }} />
                </div>
              </div>
            ) : (
              <div
                className="w-16 h-16 rounded-2xl flex items-center justify-center"
                style={{ background: 'var(--sur-6)' }}
              >
                <WifiOff className="w-7 h-7" style={{ color: 'var(--color-text-muted)' }} />
              </div>
            )}
          </div>

          {/* Greeting */}
          <div className="space-y-1.5">
            <h1 className="text-xl font-black tracking-tight" style={{ color: 'var(--color-text)' }}>
              {cached?.name ? `Hi, ${cached.name.split(' ')[0]}` : 'You\'re offline'}
            </h1>
            <p className="text-sm" style={{ color: 'var(--color-text-muted)' }}>Verify to continue with cached data</p>
          </div>

          {/* Status area */}
          {status === 'verifying' && (
            <div className="flex items-center justify-center gap-2 text-sm py-1" style={{ color: 'var(--color-text-muted)' }}>
              <svg className="w-4 h-4 animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
              Verifying…
            </div>
          )}

          {status === 'idle' && (
            <p className="text-xs py-1" style={{ color: 'var(--sur-20)' }}>
              Use Face ID or fingerprint to continue
            </p>
          )}

          {status === 'failed' && (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: 'var(--color-danger)' }}>Biometric verification failed</p>
              <button
                onClick={attempt}
                className="w-full py-3 rounded-2xl text-sm font-bold text-white active:scale-[0.97] transition-all"
                style={{ background: 'var(--color-text)' }}
              >
                Try again
              </button>
              <button
                onClick={onSignInInstead}
                className="w-full py-2 text-sm transition-colors"
                style={{ color: 'var(--color-text-muted)' }}
              >
                Sign in with Google instead
              </button>
            </div>
          )}

          <p className="text-[11px]" style={{ color: 'var(--sur-20)' }}>
            Read-only · Edits sync when reconnected
          </p>
        </div>
      </div>
    </div>
  );
}
