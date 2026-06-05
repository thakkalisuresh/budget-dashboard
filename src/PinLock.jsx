import React, { useState, useEffect, useRef } from 'react';
import { Lock, Fingerprint, X } from 'lucide-react';

const PIN_KEY            = 'budget_pin_hash';
const PIN_SALT_KEY       = 'budget_pin_salt';
export const PIN_ENC_SALT_KEY = 'budget_pin_enc_salt'; // separate salt for AES key derivation
export const BIOMETRIC_KEY    = 'budget_biometric_id';
export const PIN_HASH_KEY     = PIN_KEY; // re-export under a clearer name for useAuth
const PIN_TIMEOUT_KEY    = 'budget_pin_timeout';
const PIN_LEN_KEY        = 'budget_pin_length'; // remembered length of the stored PIN
const FAIL_KEY           = 'budget_pin_fail';

const PIN_LENGTH_DEFAULT = 6; // new PINs are 6 digits; legacy 4-digit PINs still unlock
const MAX_TRIES          = 5;
const FAIL_WINDOW_MS     = 24 * 60 * 60 * 1000; // failed attempts persist for 24h
const DEFAULT_LOCK_MS    = 10 * 60 * 1000;
const MIN_LOCK_MS        = 30 * 1000;            // 30s floor
const MAX_LOCK_MS        = 24 * 60 * 60 * 1000;  // 24h ceiling — anything larger is invalid

function getLockAfterMs() {
  const stored = parseInt(localStorage.getItem(PIN_TIMEOUT_KEY) || '0', 10);
  if (!Number.isFinite(stored) || stored <= 0) return DEFAULT_LOCK_MS;
  // Clamp — an attacker who can write to localStorage can't disable the timeout.
  return Math.min(Math.max(stored, MIN_LOCK_MS), MAX_LOCK_MS);
}

function getStoredPinLength() {
  const stored = parseInt(localStorage.getItem(PIN_LEN_KEY) || '0', 10);
  if (stored === 4 || stored === 6) return stored;
  return 4; // legacy default
}

// Persisted failure tracking — survives reloads, so an attacker can't reset
// the counter by hitting F5 between brute-force attempts.
function getFailState() {
  try {
    const raw = localStorage.getItem(FAIL_KEY);
    if (!raw) return { count: 0, firstAt: 0 };
    const obj = JSON.parse(raw);
    if (Date.now() - (obj.firstAt || 0) > FAIL_WINDOW_MS) return { count: 0, firstAt: 0 };
    return { count: obj.count || 0, firstAt: obj.firstAt || 0 };
  } catch { return { count: 0, firstAt: 0 }; }
}

function recordFail() {
  const cur = getFailState();
  const next = {
    count: cur.count + 1,
    firstAt: cur.firstAt || Date.now(),
  };
  localStorage.setItem(FAIL_KEY, JSON.stringify(next));
  return next.count;
}

function resetFails() {
  localStorage.removeItem(FAIL_KEY);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** PBKDF2 with a random per-device salt — brute-forcing the keyspace takes minutes for 4 digits, much longer for 6 */
async function hashPin(pin, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function newSalt() { return crypto.getRandomValues(new Uint8Array(32)); }

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

// ── AES-GCM token encryption ──────────────────────────────────────────────────
// Used by useAuth.js to encrypt the Google access token at rest in sessionStorage.
// Key is derived from the PIN with PBKDF2 using a *separate* salt from the PIN
// hash. Sharing the same salt would mean the AES key equals the stored hash —
// reading localStorage would yield the key. Keep them split.

/** Returns the stored encryption salt as Uint8Array, creating one if missing. */
export function ensureEncSalt() {
  const existing = localStorage.getItem(PIN_ENC_SALT_KEY);
  if (existing) return b64decode(existing);
  const fresh = newSalt();
  localStorage.setItem(PIN_ENC_SALT_KEY, b64encode(fresh.buffer));
  return fresh;
}

/** Derive an AES-GCM CryptoKey from the PIN. */
export async function derivePinKey(pin, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a string; returns { iv, ct } as base64. */
export async function aesEncrypt(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { iv: b64encode(iv.buffer), ct: b64encode(ct) };
}

/** Decrypt a { iv, ct } pair. Returns the plaintext string, or null on failure. */
export async function aesDecrypt(key, enc) {
  try {
    const iv = b64decode(enc.iv);
    const ct = b64decode(enc.ct);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(buf);
  } catch { return null; }
}

/** Returns true if the device has a platform authenticator (Face ID / Touch ID / fingerprint) */
async function biometricAvailable() {
  try {
    return !!(window.PublicKeyCredential &&
      await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch { return false; }
}

/** Register a new platform credential — called once when user sets their PIN */
async function registerBiometric() {
  try {
    const available = await biometricAvailable();
    if (!available) return null;
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Budget Dashboard', id: window.location.hostname },
        user: {
          id: new TextEncoder().encode('budget-user-v1'),
          name: 'budget@dashboard',
          displayName: 'Budget Dashboard',
        },
        pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'discouraged',
        },
        timeout: 60000,
      },
    });
    if (!credential) return null;
    const id = b64encode(credential.rawId);
    localStorage.setItem(BIOMETRIC_KEY, id);
    return id;
  } catch { return null; }
}

/** Prompt biometric verification — returns true on success */
export async function verifyBiometric() {
  try {
    const storedId = localStorage.getItem(BIOMETRIC_KEY);
    if (!storedId) return false;
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: window.location.hostname,
        allowCredentials: [{ id: b64decode(storedId), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!assertion;
  } catch { return false; }
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function usePinLock(onSignOut) {
  const [pinHash, setPinHash]   = useState(() => localStorage.getItem(PIN_KEY));
  const [locked, setLocked]     = useState(false);
  const [setting, setSetting]   = useState(false);

  // Lock after LOCK_AFTER_MS in background — prevents locking on every tab switch
  useEffect(() => {
    if (!pinHash) return;
    let hiddenAt = null;
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (document.visibilityState === 'visible') {
        if (hiddenAt && Date.now() - hiddenAt >= getLockAfterMs()) setLocked(true);
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [pinHash]);

  const savePin = async (pin) => {
    // Clear any old SHA-256 hash before saving new PBKDF2 hash
    localStorage.removeItem(PIN_SALT_KEY);
    const salt = newSalt();
    const h = await hashPin(pin, salt);
    localStorage.setItem(PIN_SALT_KEY, b64encode(salt.buffer));
    localStorage.setItem(PIN_KEY, h);
    localStorage.setItem(PIN_LEN_KEY, String(pin.length));
    resetFails();
    setPinHash(h);
    setSetting(false);
    // Register biometric credential alongside the PIN (best-effort)
    await registerBiometric();
  };

  const clearPin = () => {
    localStorage.removeItem(PIN_KEY);
    localStorage.removeItem(PIN_SALT_KEY);
    localStorage.removeItem(PIN_ENC_SALT_KEY);
    localStorage.removeItem(BIOMETRIC_KEY);
    localStorage.removeItem(PIN_LEN_KEY);
    resetFails();
    setPinHash(null);
  };

  const unlock = async (pin) => {
    const saltB64 = localStorage.getItem(PIN_SALT_KEY);
    if (!saltB64) { clearPin(); return false; }
    const salt = b64decode(saltB64);
    const h = await hashPin(pin, salt);
    const ok = h === pinHash;
    if (ok) {
      resetFails();
      if (pin.length < PIN_LENGTH_DEFAULT) {
        setTimeout(() => setSetting(true), 0);
      }
    }
    return ok;
  };

  return { pinHash, locked, setLocked, setting, setSetting, savePin, clearPin, unlock, onSignOut };
}

// ── Lock Screen ───────────────────────────────────────────────────────────────

export function PinLockScreen({ locked, setting, pinHash, onUnlock, onBiometricUnlock, onSignOut, onSave, onCancel }) {
  const expectedLen = setting ? PIN_LENGTH_DEFAULT : getStoredPinLength();

  const [digits, setDigits]           = useState('');
  const [error, setError]             = useState('');
  const [tries, setTries]             = useState(() => getFailState().count);
  const [confirm, setConfirm]         = useState('');
  const [step, setStep]               = useState(1);
  const [hasBiometric, setHasBiometric] = useState(false);
  const [bioPrompted, setBioPrompted] = useState(false);
  const inputRef                      = useRef(null);

  // Detect biometric availability
  useEffect(() => {
    biometricAvailable().then(ok => setHasBiometric(ok && !!localStorage.getItem(BIOMETRIC_KEY)));
  }, []);

  // Auto-trigger biometric when lock screen opens (not during PIN setup)
  useEffect(() => {
    if (!locked || setting || bioPrompted) return;
    if (!localStorage.getItem(BIOMETRIC_KEY)) return;
    setBioPrompted(true);
    triggerBiometric();
  }, [locked, setting]);

  useEffect(() => {
    setDigits('');
    setError('');
    setStep(1);
    setConfirm('');
    setBioPrompted(false);
    setTries(getFailState().count);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [locked, setting]);

  const triggerBiometric = async () => {
    setError('');
    const ok = await verifyBiometric();
    if (ok && onBiometricUnlock) {
      // Biometric assertion came from a registered platform credential — unlock.
      // We do NOT pass a sentinel string through onUnlock; that path was a
      // logic-only bypass and is gone.
      onBiometricUnlock();
      resetFails();
    }
    // If cancelled/failed, fall through silently to PIN
  };

  const handleDigit = (d) => {
    if (digits.length >= expectedLen) return;
    const next = digits + d;
    setDigits(next);
    if (next.length === expectedLen) handleSubmit(next);
  };

  const handleDelete = () => setDigits(d => d.slice(0, -1));

  const handleSubmit = async (pin) => {
    setError('');
    if (setting) {
      if (step === 1) { setConfirm(pin); setStep(2); setTimeout(() => setDigits(''), 100); return; }
      if (pin !== confirm) {
        setError("PINs don't match. Try again.");
        setStep(1); setConfirm('');
        setTimeout(() => setDigits(''), 100);
        return;
      }
      await onSave(pin);
      return;
    }
    const ok = await onUnlock(pin);
    if (ok) {
      setTimeout(() => setDigits(''), 50);
    } else {
      const totalFails = recordFail();
      setTries(totalFails);
      if (totalFails >= MAX_TRIES) { onSignOut(); return; }
      setError(`Incorrect PIN. ${MAX_TRIES - totalFails} attempt${MAX_TRIES - totalFails !== 1 ? 's' : ''} remaining.`);
      setTimeout(() => setDigits(''), 100);
    }
  };

  if (!locked && !setting) return null;

  const title    = setting ? (step === 1 ? 'Set a PIN' : 'Confirm PIN') : 'Enter PIN';
  const subtitle = setting
    ? (step === 1 ? `Choose a ${expectedLen}-digit PIN to lock the app` : 'Re-enter your PIN to confirm')
    : `Enter your ${expectedLen}-digit PIN to continue`;

  const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  // Dot indicators — one per expected digit
  const dots = Array.from({ length: expectedLen }, (_, i) => i);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-6"
      style={{
        background: 'oklch(8% 0.006 265)',
        paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)',
      }}
    >

      {setting && (
        <button
          onClick={onCancel}
          className="absolute right-6 p-2 transition-colors"
          style={{ top: 'calc(env(safe-area-inset-top) + 1rem)', color: 'oklch(60% 0 0)' }}
        >
          <X className="w-5 h-5" />
        </button>
      )}

      <div className="w-full max-w-xs flex flex-col items-center gap-8">

        {/* Icon + title */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{ background: 'var(--color-accent-subtle)' }}
          >
            <Lock className="w-7 h-7" style={{ color: 'var(--color-accent-text)' }} />
          </div>
          <div className="text-center">
            <p className="text-lg font-black text-white">{title}</p>
            <p className="text-sm mt-1" style={{ color: 'oklch(60% 0.003 265)' }}>{subtitle}</p>
          </div>
        </div>

        {/* PIN dots */}
        <div className="flex gap-3">
          {dots.map(i => (
            <div
              key={i}
              className="w-3.5 h-3.5 rounded-full border-2 transition-all duration-150"
              style={i < digits.length
                ? { background: 'var(--color-accent)', borderColor: 'var(--color-accent)', transform: 'scale(1.1)' }
                : { background: 'transparent', borderColor: 'oklch(35% 0.005 265)' }}
            />
          ))}
        </div>

        {error && <p className="text-xs font-medium text-center -mt-4" style={{ color: 'var(--color-danger)' }}>{error}</p>}

        {/* Hidden input for keyboard on mobile */}
        <input ref={inputRef} type="tel" inputMode="numeric" maxLength={expectedLen} value={digits}
          onChange={e => {
            const val = e.target.value.replace(/\D/g, '').slice(0, expectedLen);
            setDigits(val);
            if (val.length === expectedLen) handleSubmit(val);
          }}
          className="sr-only"
        />

        {/* Number pad */}
        <div className="grid grid-cols-3 gap-3 w-full">
          {KEYS.map((k, i) => k === '⌫' ? (
            <button
              key={i}
              onClick={handleDelete}
              className="h-16 rounded-2xl text-white text-xl font-bold flex items-center justify-center active:scale-95 transition-transform"
              style={{ background: 'oklch(18% 0.008 265)' }}
            >
              ⌫
            </button>
          ) : k === '' ? (
            <div key={i} />
          ) : (
            <button
              key={i}
              onClick={() => handleDigit(k)}
              className="h-16 rounded-2xl text-white text-xl font-black flex items-center justify-center active:scale-95 transition-transform"
              style={{ background: 'oklch(18% 0.008 265)' }}
            >
              {k}
            </button>
          ))}
        </div>

        {/* Biometric button */}
        {locked && !setting && hasBiometric && (
          <button
            onClick={triggerBiometric}
            className="flex items-center gap-2 px-5 py-2.5 rounded-2xl text-sm font-bold transition-all active:scale-95"
            style={{ background: 'oklch(18% 0.008 265)', color: 'oklch(70% 0.003 265)' }}
          >
            <Fingerprint className="w-5 h-5" style={{ color: 'var(--color-accent-text)' }} />
            Use Face ID / Touch ID
          </button>
        )}

        {locked && !setting && (
          <button
            onClick={onSignOut}
            className="text-xs transition-colors"
            style={{ color: 'oklch(40% 0.003 265)' }}
          >
            Sign out instead
          </button>
        )}
      </div>
    </div>
  );
}
