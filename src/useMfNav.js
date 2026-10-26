// ════════════════════════════════════════════════════════════════════════════
// useMfNav.js — latest NAVs for the Indian mutual funds on screen + the INR/USD
// rate, from /api/mf-nav. AMFI publishes NAVs once a day, so this fetches on
// mount and then every 6h — only while the Invest tab is mounted AND the app is
// visible (same $0 strategy as useQuotes). localStorage is a per-device cache so
// the UI has numbers offline; it is never a source of truth.
// ════════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';

const POLL_MS = 6 * 60 * 60_000;
export const MF_CACHE_KEY = 'fundient.mfNav.v2';
const CODE_RE = /^\d{4,7}$/;

/** Valid, unique, sorted scheme codes — drops '', 'unmapped' and anything non-numeric. */
export function cleanCodes(codes) {
  return [...new Set((codes || []).map(c => String(c ?? '').trim()).filter(c => CODE_RE.test(c)))].sort();
}

export function readMfCache(storage) {
  try {
    const v = JSON.parse(storage?.getItem(MF_CACHE_KEY));
    return v && typeof v === 'object' && v.navs && typeof v.navs === 'object' ? v : null;
  } catch {
    return null;
  }
}

export function writeMfCache(storage, value) {
  try { storage?.setItem(MF_CACHE_KEY, JSON.stringify(value)); } catch { /* private mode / quota */ }
}

function getStorage() {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

export function useMfNav(codes, accessToken) {
  const [state, setState] = useState(() => {
    const c = readMfCache(getStorage());
    return { navs: c?.navs || {}, fx: c?.fx || null, lastUpdated: c?.lastUpdated ? new Date(c.lastUpdated) : null };
  });
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  // Stable key so a re-render with the same codes doesn't re-arm the effect.
  const codeKey = useMemo(() => cleanCodes(codes).join(','), [codes]);

  const refresh = useCallback(async () => {
    const list = codeKey ? codeKey.split(',') : [];
    if (!list.length || !accessToken || inFlight.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    inFlight.current = true;
    try {
      const res = await fetch('/api/mf-nav', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ action: 'latest', codes: list, includeFx: true }),
      });
      if (!res.ok) { setStale(true); return; }
      const json = await res.json();
      setState(prev => {
        // A null NAV (unknown/N.A.) must not wipe a previously good value.
        const navs = { ...prev.navs };
        for (const [code, nav] of Object.entries(json.data || {})) if (nav) navs[code] = nav;
        const next = { navs, fx: json.fx || prev.fx, lastUpdated: new Date() };
        writeMfCache(getStorage(), { ...next, lastUpdated: next.lastUpdated.toISOString() });
        return next;
      });
      setStale(!!json.stale);
    } catch {
      setStale(true);
    } finally {
      inFlight.current = false;
    }
  }, [codeKey, accessToken]);

  useEffect(() => {
    if (!codeKey) return;
    refresh();
    const id = setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, codeKey]);

  return { navs: state.navs, fx: state.fx, stale, lastUpdated: state.lastUpdated, refresh };
}
