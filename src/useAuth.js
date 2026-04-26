import { useState, useEffect } from 'react';

const ALLOWED_EMAILS = [
  'nair.sabarish97@gmail.com',
  'anupamaramesh26@gmail.com',
  'anupamaramesh2697@gmail.com',
];

const NAME_MAP = {
  'nair.sabarish97@gmail.com':    'Sabarish',
  'anupamaramesh26@gmail.com':    'Anupama',
  'anupamaramesh2697@gmail.com':  'Anupama',
};

const STORAGE_KEY = 'budget_auth';

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Invalidate if token has expired
    if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function useAuth() {
  const [user, setUser]           = useState(() => loadStored());
  const [denied, setDenied]       = useState(false);
  const [loadingAuth, setLoading] = useState(false);

  // Handle the token response from @react-oauth/google
  const onGoogleSuccess = async (tokenResponse) => {
    setLoading(true);
    setDenied(false);
    try {
      // Fetch the user's profile with the access token
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
      });
      const profile = await res.json();
      const email = profile.email?.toLowerCase();

      if (!ALLOWED_EMAILS.includes(email)) {
        setDenied(true);
        setLoading(false);
        return;
      }

      const auth = {
        email,
        name:        NAME_MAP[email] || profile.given_name || 'User',
        picture:     profile.picture,
        accessToken: tokenResponse.access_token,
        expiresAt:   Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
      setUser(auth);
    } catch (e) {
      console.error('Auth error:', e);
    } finally {
      setLoading(false);
    }
  };

  const onGoogleError = () => {
    setLoading(false);
    console.error('Google sign-in failed');
  };

  const signOut = () => {
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setDenied(false);
  };

  // Auto-clear expired sessions
  useEffect(() => {
    if (!user?.expiresAt) return;
    const ms = user.expiresAt - Date.now();
    if (ms <= 0) { signOut(); return; }
    const t = setTimeout(signOut, ms);
    return () => clearTimeout(t);
  }, [user?.expiresAt]);

  // Silent token refresh — fires 5 min before expiry, no UI shown
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
          prompt: '',  // silent — no popup if already authorised
          callback: (tokenResponse) => {
            if (tokenResponse?.access_token) {
              onGoogleSuccess(tokenResponse);
            }
          },
        });
        client?.requestAccessToken({ prompt: '' });
      } catch (e) {
        console.warn('Silent token refresh failed:', e);
      }
    }, refreshIn);

    return () => clearTimeout(t);
  }, [user?.expiresAt]);

  return { user, denied, loadingAuth, onGoogleSuccess, onGoogleError, signOut };
}
