// ════════════════════════════════════════════════════════════════════════════
// ledgerCache.js — the Ledger tab's two-tier cache, and the one way to clear it.
//
// Two tiers, because the tab needs to paint instantly on mount but must not show
// yesterday's data:
//   • an in-memory Map (2 min) that survives tab switches within a session
//   • a localStorage mirror (1 hr) that survives a reload, used to warm-start
//
// Extracted from LedgerTab.jsx so that invalidation is testable without React,
// and so the component file exports only components.
//
// The bug this exists to prevent: callers used to clear the Map and nothing else,
// so a freshly added transaction could still be missing from the Ledger — the tab
// would mount, paint the hour-old localStorage copy, and only correct itself if
// the background refetch happened to succeed. Both tiers must always be dropped
// together, which is why there is exactly one function to do it.
// ════════════════════════════════════════════════════════════════════════════

/** Serve the in-memory copy without refetching for this long. */
export const CACHE_MS = 2 * 60 * 1000;

/** Ignore a localStorage copy older than this. Matches the SEC-05 SW convention. */
export const LOCAL_CACHE_MAX_AGE_MS = 60 * 60 * 1000;

/** sheetId → { data, fetchedAt } */
export const ledgerCache = new Map();

export const ledgerCacheKey = (sheetId) => `budget_ledger_cache_${sheetId}`;

/**
 * Drop every cached copy of a month's ledger. Anything that mutates a month's
 * transactions must call this — never `ledgerCache.delete` on its own.
 */
export function invalidateLedger(sheetId) {
  if (!sheetId) return;
  ledgerCache.delete(sheetId);
  try { localStorage.removeItem(ledgerCacheKey(sheetId)); } catch { /* private mode / quota */ }
}

/** Fresh in-memory copy, or null. */
export function readMemoryCache(sheetId) {
  const cached = ledgerCache.get(sheetId);
  if (!cached) return null;
  return (Date.now() - cached.fetchedAt < CACHE_MS) ? cached : null;
}

/** Warm-start copy from localStorage, or null if absent, stale or corrupt. */
export function loadCachedLedger(sheetId) {
  try {
    const raw = localStorage.getItem(ledgerCacheKey(sheetId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.data || Date.now() - parsed.fetchedAt > LOCAL_CACHE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Write both tiers at once, so they can't disagree. */
export function storeLedger(sheetId, data) {
  const fetchedAt = Date.now();
  ledgerCache.set(sheetId, { data, fetchedAt });
  try {
    localStorage.setItem(ledgerCacheKey(sheetId), JSON.stringify({ data, fetchedAt }));
  } catch { /* ignore quota errors — the memory tier still works */ }
  return fetchedAt;
}
