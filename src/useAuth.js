import { useState, useEffect } from 'react';

const STORAGE_KEY    = 'budget_auth';
const AUTH_CACHE_KEY = 'budget_auth_cache';

// Edge function endpoint — email allowlist lives server-side only
const VERIFY_URL = import.meta.env.DEV
  ? 'http://localhost:8888/api/verify-user'  // netlify dev port
  : '/api/verify-user';

function loadStored() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function loadOfflineCache() {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return null;
    return { ...JSON.parse(raw), isOfflineSession: true };
  } catch {
    return null;
  }
}

export function useAuth() {
  const [user, setUser]         = useState(() => {
    const stored = loadStored();
    if (stored) return stored;
    if (!navigator.onLine) return loadOfflineCache();
    return null;
  });
  const [denied, setDenied]     = useState(false);
  const [loadingAuth, setLoading] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  const onGoogleSuccess = async (tokenResponse) => {
    setLoading(true);
    setDenied(false);
    try {
      let email, name, picture;

      if (import.meta.env.DEV) {
        // Dev mode: verify with Google directly — edge function not available without netlify dev
        const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const profile = await profileRes.json();
        email   = profile.email?.toLowerCase();
        name    = profile.given_name || 'User';
        picture = profile.picture;

        // Check against VITE_ALLOWED_EMAILS in .env (dev only — never in production bundle)
        const devAllowed = new Set(
          (import.meta.env.VITE_ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
        );
        if (!devAllowed.has(email)) { setDenied(true); setLoading(false); return; }
      } else {
        // Production: verify server-side via edge function — emails never in client bundle
        const res  = await fetch(VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: tokenResponse.access_token }),
        });
        const data = await res.json();
        if (!data.allowed) { setDenied(true); setLoading(false); return; }
        email   = data.email;
        name    = data.name || 'User';
        picture = data.picture;
      }

      const role = import.meta.env.DEV
        ? ((import.meta.env.VITE_VIEWER_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).includes(email) ? 'viewer' : 'owner')
        : (data?.role ?? 'owner');

      const auth = {
        email, name, picture, role,
        accessToken: tokenResponse.access_token,
        expiresAt:   Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
      // Store only non-sensitive profile data in localStorage — no access token
      const { accessToken: _drop, ...profileOnly } = auth;
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(profileOnly));
      setSessionExpired(false);
      setUser(auth);
    } catch {
      setDenied(true);
    } finally {
      setLoading(false);
    }
  };

  const onGoogleError = () => {
    setLoading(false);
    setDenied(true);
  };

  const signOut = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    // Clear all app localStorage on sign-out (security hygiene)
    ['budget_custom_categories', 'budget_category_icons', 'budget_vendor_domains',
     'theme', AUTH_CACHE_KEY,
     'budget_pin_hash', 'budget_pin_salt', 'budget_biometric_id',
    ].forEach(k => localStorage.removeItem(k));
    setUser(null);
    setDenied(false);
    setSessionExpired(false);
  };

  // Auto-clear expired sessions
  useEffect(() => {
    if (!user?.expiresAt) return;
    const ms = user.expiresAt - Date.now();
    if (ms <= 0) { signOut(); return; }
    const t = setTimeout(signOut, ms);
    return () => clearTimeout(t);
  }, [user?.expiresAt]);

  // Silent token refresh — fires 5 min before expiry
  useEffect(() => {
    if (!user?.expiresAt) return;
    const refreshIn = user.expiresAt - Date.now() - 5 * 60 * 1000;
    if (refreshIn <= 0) return;

    const t = setTimeout(() => {
      try {
        const client = window.google?.accounts?.oauth2?.initTokenClient({
          client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
          scope: [
            'openid email profile',
            'https://www.googleapis.com/auth/spreadsheets',
            'https://www.googleapis.com/auth/drive',
          ].join(' '),
          prompt: '',
          callback: (tokenResponse) => {
            if (tokenResponse?.access_token) {
              onGoogleSuccess(tokenResponse);
            } else {
              setSessionExpired(true);
            }
          },
        });
        client?.requestAccessToken({ prompt: '' });
      } catch { /* silent refresh failed — user will re-auth on expiry */ }
    }, refreshIn);

    return () => clearTimeout(t);
  }, [user?.expiresAt]);

  return { user, denied, loadingAuth, onGoogleSuccess, onGoogleError, signOut, sessionExpired, setSessionExpired };
}
