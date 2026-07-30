// ════════════════════════════════════════════════════════════════════════════
// resetAppCaches.js — the "clear cache & reload" escape hatch, in one place.
//
// This is what the user used to do by hand after every deploy. It was already
// implemented inline as the ErrorBoundary's recovery button in main.jsx; it now
// lives here so the update flow can reuse it instead of carrying a second copy
// that could drift.
//
// It is the FALLBACK update path. The normal path is the service worker's own
// skipWaiting handoff (see useAppUpdate.js), which is far cheaper — it keeps the
// caches and swaps the worker. This one throws everything away, and is what we
// fall back to when the version poll spots a deploy the service worker missed.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Delete every Cache Storage entry and unregister every service worker.
 * Best-effort: partial failure is fine, since the caller reloads regardless and
 * a stale cache is better than an exception that strands the user on the gate.
 */
export async function resetAppCaches() {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch { /* ignore — best-effort cleanup */ }

  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch { /* ignore — best-effort cleanup */ }
}

/** Wipe caches and workers, then reload into the fresh build. */
export async function resetAndReload() {
  await resetAppCaches();
  window.location.reload();
}
