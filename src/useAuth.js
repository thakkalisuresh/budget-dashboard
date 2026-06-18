import { useState, useEffect, useRef } from 'react';
import { clearQueue } from './offlineQueue.js';
import { clearDriveTokenCache } from './driveAuth.js';
import {
  derivePinKey, aesEncrypt, aesDecrypt, ensureEncSalt,
  PIN_HASH_KEY, BIOMETRIC_KEY, verifyBiometric,
} from './PinLock.jsx';
import {
  isLoginBiometricRegistered, verifyLoginBiometric,
} from './biometricLogin.js';
import { MOCK_USER } from './mockData.js';

function isMobileDevice() {
  return /iPhone|iPad|Android/i.test(navigator.userAgent);
}

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';

const STORAGE_KEY    = 'budget_auth';
const AUTH_CACHE_KEY = 'budget_auth_cache';

/** True if a PIN is set AND biometric is NOT — the "encrypt the token" regime.
 *  When biometric is registered we leave plaintext in sessionStorage because
 *  WebAuthn assertions don't yield key material that can decrypt it. */
function isEncryptingRegime() {
  return !!localStorage.getItem(PIN_HASH_KEY) && !localStorage.getItem(BIOMETRIC_KEY);
}

/** Best-effort: clear every Workbox/runtime cache so financial-data responses
 *  don't linger in the Service Worker cache after sign-out. */
async function clearAllCaches() {
  try {
    if (typeof caches === 'undefined') return;
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch { /* non-fatal */ }
}

/** Best-effort: drop every IndexedDB database the app touched. */
async function clearAllIndexedDB() {
  try {
    if (!indexedDB?.databases) return;
    const dbs = await indexedDB.databases();
    await Promise.all((dbs || []).map(db => new Promise(resolve => {
      if (!db?.name) return resolve();
      const req = indexedDB.deleteDatabase(db.name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    })));
  } catch { /* non-fatal */ }
}

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
    // If only the encrypted token remains (e.g., tab reload while locked),
    // the session is intact but the access token is held under the PIN.
    if (!parsed.accessToken && parsed.encToken) parsed.isLocked = true;
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
    if (DEV_MOCK) return MOCK_USER;
    const stored = loadStored();
    if (stored) return stored;
    return null;
  });
  const [denied, setDenied]     = useState(false);
  const [loadingAuth, setLoading] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  // Biometric offline unlock — set when there's a cached profile + registered
  // biometric but no active session (e.g. PWA reopened after tab close).
  const [pendingOfflineUnlock, setPendingOfflineUnlock] = useState(() => {
    if (loadStored()) return false;
    if (!loadOfflineCache()) return false;
    return !!localStorage.getItem(BIOMETRIC_KEY);
  });

  // Mobile biometric login — on mobile, if a login credential is registered and
  // no active session exists, gate the login screen behind biometric instead of
  // showing Google OAuth immediately. Desktop always stays false.
  const [pendingMobileLogin, setPendingMobileLogin] = useState(() => {
    if (DEV_MOCK) return false;
    if (loadStored()) return false;
    if (!isMobileDevice()) return false;
    return isLoginBiometricRegistered();
  });

  // Controls the post-first-login "Enable Face ID / fingerprint?" bottom sheet.
  const [showBiometricSetup, setShowBiometricSetup] = useState(false);

  // ── Localhost dev bypass ──────────────────────────────────────────────────
  // When VITE_DEV_MOCK=true: skip OAuth entirely — MOCK_USER is pre-set above.
  // When VITE_DEV_ACCESS_TOKEN is set: skip OAuth popup and auto-login on load.
  const devAutoLoginFired = useRef(false);
  useEffect(() => {
    if (DEV_MOCK) return;
    if (!import.meta.env.DEV) return;
    if (devAutoLoginFired.current) return;
    if (user) return;
    const devToken = import.meta.env.VITE_DEV_ACCESS_TOKEN;
    if (!devToken) return;
    devAutoLoginFired.current = true;
    onGoogleSuccess({ access_token: devToken, expires_in: 3600 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // In-memory AES key derived from the PIN. Populated on PIN setup or unlock;
  // cleared on lock and sign-out. Never written to storage.
  const cipherKeyRef = useRef(null);

  const onGoogleSuccess = async (tokenResponse) => {
    setLoading(true);
    setDenied(false);
    try {
      let email, name, picture, prodRole, prodAllowedEmails;

      if (import.meta.env.DEV) {
        // Dev mode: verify with Google directly — edge function not available without netlify dev
        const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenResponse.access_token}` },
        });
        const profile = await profileRes.json();
        email   = profile.email?.toLowerCase();
        name    = profile.given_name || 'User';
        picture = profile.picture;
      } else {
        // Production: verify server-side via edge function — emails never in client bundle
        const res  = await fetch(VERIFY_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: tokenResponse.access_token }),
        });
        const data = await res.json();
        if (!data.allowed) { setDenied(true); setLoading(false); return; }
        email    = data.email;
        name     = data.name || 'User';
        picture  = data.picture;
        prodRole = data.role;
        prodAllowedEmails = data.allowedEmails;
      }

      const role = import.meta.env.DEV ? 'owner' : (prodRole ?? 'owner');
      const allowedEmails = import.meta.env.DEV ? [email] : (prodAllowedEmails || []);

      const auth = {
        email, name, picture, role, allowedEmails,
        accessToken: tokenResponse.access_token,
        expiresAt:   Date.now() + (tokenResponse.expires_in ?? 3600) * 1000,
      };

      // If a PIN exists without biometric, the at-rest token must be encrypted.
      // Four cases:
      //   1. Cipher key cached (normal silent-refresh path) → encrypt and store both
      //      plaintext (memory + sessionStorage during unlocked use) and encToken.
      //   2. No cipher key cached, storage already has an encToken (silent refresh
      //      fires while locked) → drop the new token; lock stays effective and
      //      the user re-auths on next interaction.
      //   3. No cipher key cached, no existing encToken (fresh sign-in with a
      //      previously-set PIN) → store plaintext but mark isLocked. The lock
      //      screen will show and unlockToken(pin) will encrypt in place.
      //   4. No PIN at all → store plaintext as before.
      if (isEncryptingRegime()) {
        if (cipherKeyRef.current) {
          auth.encToken = await aesEncrypt(cipherKeyRef.current, auth.accessToken);
        } else {
          const existingRaw = sessionStorage.getItem(STORAGE_KEY);
          let existingHasEnc = false;
          try { existingHasEnc = !!JSON.parse(existingRaw || '{}').encToken; } catch { /* ignore */ }
          if (existingHasEnc) {
            // Silent refresh while locked — keep the existing ciphertext, drop this token.
            setLoading(false);
            return;
          }
          // Fresh sign-in with a pre-existing PIN — gate the session behind the lock
          // until the user supplies the PIN, at which point we'll encrypt in place.
          auth.isLocked = true;
        }
      }

      // SEC-04: without a PIN, accessToken is stored as plaintext in sessionStorage.
      // XSS or a malicious extension can read it. Setting a PIN enables AES-GCM
      // encryption via isEncryptingRegime() above. Token expires in ≤1 hour.
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
      // Cache profile only in localStorage — no access token, no ciphertext
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify({
        email: auth.email, name: auth.name, picture: auth.picture,
        role: auth.role, expiresAt: auth.expiresAt,
      }));
      setSessionExpired(false);
      setUser(auth);

      // On mobile, after first successful login with no login biometric yet,
      // offer to register one for future cold-starts.
      if (isMobileDevice() && !isLoginBiometricRegistered()) {
        setShowBiometricSetup(true);
      }
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

  const signOut = async () => {
    sessionStorage.removeItem(STORAGE_KEY);
    // Sweep every budget_* key — covers per-sheet data caches, offline queue,
    // smart-rules, custom categories, vendor domains, PIN, biometric markers, etc.
    try {
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('budget_') || k === 'theme')) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
    } catch { /* non-fatal */ }
    // Explicit removals in case the prefix sweep missed anything
    localStorage.removeItem(AUTH_CACHE_KEY);
    cipherKeyRef.current = null;
    clearQueue();
    clearDriveTokenCache();
    await clearAllCaches();
    await clearAllIndexedDB();
    setUser(null);
    setDenied(false);
    setSessionExpired(false);
  };

  /** Called once when the user sets their PIN (or unlocks with one) to bring
   *  the session into the encrypting regime: derive the AES key, encrypt the
   *  in-memory access token, and persist the ciphertext alongside the plaintext.
   *  Subsequent silent refreshes re-encrypt using the cached key.
   *  No-op when biometric is registered (per the design choice). */
  const setupEncryption = async (pin) => {
    if (!isEncryptingRegime()) return;
    if (!user?.accessToken) return;
    const salt = ensureEncSalt();
    const key  = await derivePinKey(pin, salt);
    const enc  = await aesEncrypt(key, user.accessToken);
    cipherKeyRef.current = key;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const obj = raw ? JSON.parse(raw) : { ...user };
      obj.encToken = enc;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch { /* non-fatal */ }
  };

  /** Strip the plaintext access token from React state and sessionStorage,
   *  leaving the encrypted copy intact. Clear the in-memory key so a memory
   *  inspector after lock can't read it either.
   *  Only strips when an encToken exists to restore from — otherwise leaves
   *  plaintext so the first PIN unlock can encrypt it in place.
   *  No-op when biometric is registered or no PIN is set. */
  const lockToken = () => {
    if (!isEncryptingRegime()) return;
    let stripped = false;
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj.encToken) {
          delete obj.accessToken;
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
          stripped = true;
        }
      }
    } catch { /* non-fatal */ }
    if (stripped) {
      cipherKeyRef.current = null;
      setUser(prev => prev ? { ...prev, accessToken: null, isLocked: true } : prev);
    }
  };

  /** Called from the unlock flow with the entered PIN. Two paths:
   *   - encToken exists: derive key, decrypt, restore accessToken to memory and
   *     sessionStorage, cache the key.
   *   - encToken missing (first unlock after fresh sign-in with existing PIN, or
   *     legacy session pre-encryption): derive key, encrypt the current plaintext
   *     accessToken in place, cache the key. The session moves into the
   *     encrypted regime from here on.
   *  Returns true on success, false if nothing to do or decryption failed. */
  const unlockToken = async (pin) => {
    if (!isEncryptingRegime()) return true; // no PIN regime — caller handles UI gate only
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj   = JSON.parse(raw);
      const salt  = ensureEncSalt();
      const key   = await derivePinKey(pin, salt);

      if (obj.encToken) {
        const token = await aesDecrypt(key, obj.encToken);
        if (!token) return false;
        obj.accessToken = token;
      } else if (obj.accessToken) {
        // Migrate: encrypt the plaintext currently in storage so the next lock
        // can strip it safely.
        obj.encToken = await aesEncrypt(key, obj.accessToken);
      } else {
        return false; // nothing to unlock
      }

      delete obj.isLocked;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
      cipherKeyRef.current = key;
      setUser(prev => prev ? { ...prev, accessToken: obj.accessToken, isLocked: false } : obj);
      return true;
    } catch {
      return false;
    }
  };

  // Biometric unlock — prompts Face ID / fingerprint, then loads offline cache
  const unlockOffline = async () => {
    const ok = await verifyBiometric();
    if (!ok) return false;
    const cached = loadOfflineCache();
    if (!cached) return false;
    setPendingOfflineUnlock(false);
    setUser(cached);
    if (navigator.onLine) attemptSilentRefresh();
    return true;
  };

  const cancelOfflineUnlock = () => setPendingOfflineUnlock(false);

  // Promise-based silent refresh with a timeout. Resolves true if a fresh token
  // was obtained (onGoogleSuccess called), false if it timed out or failed.
  // Does NOT set sessionExpired — caller decides how to handle failure.
  const attemptSilentRefreshAsync = (timeoutMs = 5000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    try {
      const client = window.google?.accounts?.oauth2?.initTokenClient({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        scope: [
          'openid email profile',
          'https://www.googleapis.com/auth/spreadsheets',
        ].join(' '),
        prompt: '',
        callback: async (tokenResponse) => {
          clearTimeout(t);
          if (tokenResponse?.access_token) {
            await onGoogleSuccess(tokenResponse);
            resolve(true);
          } else {
            resolve(false);
          }
        },
      });
      if (!client) { clearTimeout(t); resolve(false); return; }
      client.requestAccessToken({ prompt: '' });
    } catch {
      clearTimeout(t);
      resolve(false);
    }
  });

  // Biometric login for mobile cold-starts. Verifies the platform authenticator,
  // waits up to 5 s for a silent Google token refresh so real data loads first,
  // then falls back to the offline cached session if the refresh times out/fails.
  // pendingMobileLogin stays true the entire time so the spinner keeps showing —
  // it's only cleared once we have a session, avoiding a flash of the Google login screen.
  const triggerMobileLogin = async () => {
    const ok = await verifyLoginBiometric();
    if (!ok) return false;
    // Keep pendingMobileLogin=true here — MobileLoginScreen spinner stays visible

    if (navigator.onLine) {
      const refreshed = await attemptSilentRefreshAsync(5000);
      if (refreshed) {
        // onGoogleSuccess already set user — now dismiss the biometric screen
        setPendingMobileLogin(false);
        return true;
      }
    }

    // Silent refresh failed or offline — load cached profile as offline session
    const cached = loadOfflineCache();
    setPendingMobileLogin(false); // batched with setUser below in React 18
    if (cached) setUser(cached);
    return true;
  };

  // Upgrade offline session to full session when internet returns
  useEffect(() => {
    if (!user?.isOfflineSession) return;
    const upgrade = () => attemptSilentRefresh();
    window.addEventListener('online', upgrade);
    return () => window.removeEventListener('online', upgrade);
  }, [user?.isOfflineSession]);

  // Auto-clear expired sessions — but try silent refresh first (SEC-14)
  // Skip for offline sessions: no token to refresh, expiry is stale
  useEffect(() => {
    if (DEV_MOCK) return;
    if (!user?.expiresAt || user.isOfflineSession) return;
    const ms = user.expiresAt - Date.now();
    if (ms <= 0) { attemptSilentRefresh(); return; }
    const t = setTimeout(signOut, ms);
    return () => clearTimeout(t);
  }, [user?.expiresAt, user?.isOfflineSession]);

  // Shared silent-refresh logic — used both by the scheduled pre-expiry
  // refresh and by the post-sleep catch-up path (SEC-14).
  const attemptSilentRefresh = () => {
    try {
      const client = window.google?.accounts?.oauth2?.initTokenClient({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        scope: [
          'openid email profile',
          'https://www.googleapis.com/auth/spreadsheets',
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
    } catch { setSessionExpired(true); }
  };

  // Silent token refresh — fires 5 min before expiry, or immediately if
  // the window has already passed (e.g. laptop resumed from sleep).
  // Skip for offline sessions: handled by the online event upgrade effect.
  useEffect(() => {
    if (DEV_MOCK) return;
    if (!user?.expiresAt || user.isOfflineSession) return;
    const refreshIn = user.expiresAt - Date.now() - 5 * 60 * 1000;
    if (refreshIn <= 0) { attemptSilentRefresh(); return; }

    const t = setTimeout(attemptSilentRefresh, refreshIn);
    return () => clearTimeout(t);
  }, [user?.expiresAt, user?.isOfflineSession]);

  return {
    user, denied, loadingAuth, onGoogleSuccess, onGoogleError, signOut,
    sessionExpired, setSessionExpired,
    lockToken, unlockToken, setupEncryption,
    pendingOfflineUnlock, unlockOffline, cancelOfflineUnlock,
    pendingMobileLogin, setPendingMobileLogin, triggerMobileLogin,
    showBiometricSetup, setShowBiometricSetup,
  };
}
