import React, { useState, useEffect, useRef } from 'react';
import { Lock, Fingerprint, X } from 'lucide-react';

const PIN_KEY        = 'budget_pin_hash';
const PIN_SALT_KEY   = 'budget_pin_salt';
const BIOMETRIC_KEY  = 'budget_biometric_id';
const MAX_TRIES      = 5;
const LOCK_AFTER_MS  = 2 * 60 * 1000; // lock after 2 min in background

// ── Helpers ───────────────────────────────────────────────────────────────────

/** PBKDF2 with a random per-device salt — brute-forcing 10k PINs takes minutes, not ms */
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
async function verifyBiometric() {
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
        if (hiddenAt && Date.now() - hiddenAt >= LOCK_AFTER_MS) setLocked(true);
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
    setPinHash(h);
    setSetting(false);
    // Register biometric credential alongside the PIN (best-effort)
    await registerBiometric();
  };

  const clearPin = () => {
    localStorage.removeItem(PIN_KEY);
    localStorage.removeItem(PIN_SALT_KEY);
    localStorage.removeItem(BIOMETRIC_KEY);
    setPinHash(null);
  };

  const unlock = async (pin) => {
    const saltB64 = localStorage.getItem(PIN_SALT_KEY);
    // Legacy SHA-256 hash with no salt key — force re-set
    if (!saltB64) { clearPin(); return false; }
    const salt = b64decode(saltB64);
    const h = await hashPin(pin, salt);
    return h === pinHash;
  };

  return { pinHash, locked, setLocked, setting, setSetting, savePin, clearPin, unlock, onSignOut };
}

// ── Lock Screen ───────────────────────────────────────────────────────────────

export function PinLockScreen({ locked, setting, pinHash, onUnlock, onSignOut, onSave, onCancel }) {
  const [digits, setDigits]           = useState('');
  const [error, setError]             = useState('');
  const [tries, setTries]             = useState(0);
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
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [locked, setting]);

  const triggerBiometric = async () => {
    setError('');
    const ok = await verifyBiometric();
    if (ok) {
      onUnlock('__biometric__'); // signal to parent that biometric succeeded
    }
    // If cancelled/failed, fall through silently to PIN
  };

  const handleDigit = (d) => {
    if (digits.length >= 4) return;
    const next = digits + d;
    setDigits(next);
    if (next.length === 4) handleSubmit(next);
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
      const newTries = tries + 1;
      setTries(newTries);
      if (newTries >= MAX_TRIES) { onSignOut(); return; }
      setError(`Incorrect PIN. ${MAX_TRIES - newTries} attempt${MAX_TRIES - newTries !== 1 ? 's' : ''} remaining.`);
      setTimeout(() => setDigits(''), 100);
    }
  };

  if (!locked && !setting) return null;

  const title    = setting ? (step === 1 ? 'Set a PIN' : 'Confirm PIN') : 'Enter PIN';
  const subtitle = setting
    ? (step === 1 ? 'Choose a 4-digit PIN to lock the app' : 'Re-enter your PIN to confirm')
    : 'Enter your PIN to continue';

  const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

  return (
    <div className="fixed inset-0 z-[100] bg-slate-950 flex flex-col items-center justify-center p-6"
      style={{ paddingTop: 'calc(env(safe-area-inset-top) + 1.5rem)', paddingBottom: 'calc(env(safe-area-inset-bottom) + 1.5rem)' }}>

      {setting && (
        <button onClick={onCancel} className="absolute top-6 right-6 p-2 text-slate-400 hover:text-white transition-colors"
          style={{ top: 'calc(env(safe-area-inset-top) + 1rem)' }}>
          <X className="w-5 h-5" />
        </button>
      )}

      <div className="w-full max-w-xs flex flex-col items-center gap-8">

        {/* Icon + title */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 bg-indigo-900/40 rounded-2xl flex items-center justify-center">
            <Lock className="w-7 h-7 text-indigo-400" />
          </div>
          <div className="text-center">
            <p className="text-lg font-black text-white">{title}</p>
            <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
          </div>
        </div>

        {/* PIN dots */}
        <div className="flex gap-4">
          {[0,1,2,3].map(i => (
            <div key={i} className={`w-4 h-4 rounded-full border-2 transition-all duration-150 ${
              i < digits.length ? 'bg-indigo-500 border-indigo-500 scale-110' : 'bg-transparent border-slate-600'
            }`} />
          ))}
        </div>

        {error && <p className="text-xs text-rose-400 font-medium text-center -mt-4">{error}</p>}

        {/* Hidden input for keyboard on mobile */}
        <input ref={inputRef} type="tel" inputMode="numeric" maxLength={4} value={digits}
          onChange={e => {
            const val = e.target.value.replace(/\D/g, '').slice(0, 4);
            setDigits(val);
            if (val.length === 4) handleSubmit(val);
          }}
          className="sr-only"
        />

        {/* Number pad */}
        <div className="grid grid-cols-3 gap-3 w-full">
          {KEYS.map((k, i) => k === '⌫' ? (
            <button key={i} onClick={handleDelete}
              className="h-16 rounded-2xl bg-slate-800 text-white text-xl font-bold flex items-center justify-center active:scale-95 transition-transform hover:bg-slate-700">
              ⌫
            </button>
          ) : k === '' ? (
            <div key={i} />
          ) : (
            <button key={i} onClick={() => handleDigit(k)}
              className="h-16 rounded-2xl bg-slate-800 text-white text-xl font-black flex items-center justify-center active:scale-95 transition-transform hover:bg-slate-700">
              {k}
            </button>
          ))}
        </div>

        {/* Biometric button — shown on lock screen if credential registered */}
        {locked && !setting && hasBiometric && (
          <button onClick={triggerBiometric}
            className="flex items-center gap-2 px-5 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-2xl text-sm font-bold transition-all active:scale-95">
            <Fingerprint className="w-5 h-5 text-indigo-400" />
            Use Face ID / Touch ID
          </button>
        )}

        {locked && !setting && (
          <button onClick={onSignOut} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            Sign out instead
          </button>
        )}
      </div>
    </div>
  );
}
