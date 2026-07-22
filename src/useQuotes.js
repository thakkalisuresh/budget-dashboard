// ════════════════════════════════════════════════════════════════════════════
// useQuotes.js — poll /api/quotes for the symbols on screen, but ONLY while
// the Invest tab is mounted AND the app is visible. This is the whole $0
// strategy: no background quota burn, prices refresh while you're looking.
// ════════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { MOCK_INVEST } from './mockData.js';

const DEV_MOCK = import.meta.env.DEV && import.meta.env.VITE_DEV_MOCK === 'true';
const POLL_MS = 60_000;

export function useQuotes(symbols, accessToken) {
  const [quotes, setQuotes] = useState(() => (DEV_MOCK ? MOCK_INVEST.quotes : {}));
  const [stale, setStale] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => (DEV_MOCK ? new Date() : null));
  const inFlight = useRef(false);

  // Stable key so a re-render with the same symbols doesn't re-arm the effect.
  const symbolKey = useMemo(
    () => [...new Set(symbols.map(s => String(s).toUpperCase()))].sort().join(','),
    [symbols]
  );

  const fetchQuotes = useCallback(async () => {
    if (DEV_MOCK) return;
    const list = symbolKey ? symbolKey.split(',') : [];
    if (!list.length || !accessToken || inFlight.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    inFlight.current = true;
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ symbols: list }),
      });
      if (!res.ok) { setStale(true); return; }
      const json = await res.json();
      setQuotes(prev => ({ ...prev, ...json.data }));
      setStale(!!json.stale);
      setLastUpdated(new Date());
    } catch {
      setStale(true);
    } finally {
      inFlight.current = false;
    }
  }, [symbolKey, accessToken]);

  useEffect(() => {
    if (!symbolKey) return;
    fetchQuotes();
    const id = setInterval(fetchQuotes, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') fetchQuotes(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchQuotes, symbolKey]);

  return { quotes, stale, lastUpdated, refreshQuotes: fetchQuotes };
}
