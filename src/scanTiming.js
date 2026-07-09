// ════════════════════════════════════════════════════════════════════════════
// scanTiming.js — lightweight stopwatch for the scan/import pipeline.
//
// Wraps performance.now() so we can measure where the perceived wait goes
// (compress → extract → dedupe → import) without pulling in a dependency.
// Logging is opt-in: enable by setting `localStorage.scan_timing = '1'` in the
// browser console, or `?scanTiming=1` in the URL. Off by default → zero noise
// in production, no cost.
// ════════════════════════════════════════════════════════════════════════════

function timingEnabled() {
  try {
    if (typeof window !== 'undefined') {
      if (new URLSearchParams(window.location.search).get('scanTiming') === '1') return true;
      if (localStorage.getItem('scan_timing') === '1') return true;
    }
  } catch { /* ignore */ }
  return false;
}

const now = () =>
  (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Start a labelled timing run. Returns a handle with:
 *   .mark(stage)  → record elapsed since the previous mark
 *   .end()        → log the full breakdown (if timing is enabled)
 * When timing is disabled every method is a cheap no-op.
 */
export function startScanTiming(label) {
  if (!timingEnabled()) {
    return { mark() {}, end() {}, enabled: false };
  }
  const t0 = now();
  let last = t0;
  const stages = [];
  return {
    enabled: true,
    mark(stage) {
      const t = now();
      stages.push([stage, Math.round(t - last)]);
      last = t;
    },
    end(extra = {}) {
      const total = Math.round(now() - t0);
      const parts = stages.map(([s, ms]) => `${s}=${ms}ms`).join('  ');
      console.log(`⏱ scan[${label}] total=${total}ms  ${parts}`, extra);
      return total;
    },
  };
}
