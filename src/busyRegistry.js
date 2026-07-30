// ════════════════════════════════════════════════════════════════════════════
// busyRegistry.js — "is the user in the middle of something?"
//
// The update gate blocks the stale version, but forcing the reload while an
// expense is half-typed or a receipt is mid-upload would throw that work away.
// Rather than thread a boolean down through every dialog, surfaces that own
// unsaved work register here while they're active, and the gate reads the count.
//
// A counter, not a boolean: a receipt scan can be running underneath an open
// dialog, and whichever unmounts first must not clear the other's claim.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect, useSyncExternalStore } from 'react';

let busyCount = 0;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn();
}

/**
 * Claim busy. Returns the release function — call it exactly once.
 * Shaped as a cleanup so it can be returned straight from a useEffect.
 */
export function markBusy() {
  busyCount += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;   // guard double-release (StrictMode double-invokes effects)
    released = true;
    busyCount -= 1;
    emit();
  };
}

export function subscribeBusy(onChange) {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export function getBusySnapshot() {
  return busyCount > 0;
}

/** Test-only: drop all claims so one test can't leak state into the next. */
export function _resetBusy() {
  busyCount = 0;
  emit();
}

/** Read the current busy state, re-rendering when it changes. */
export function useIsBusy() {
  return useSyncExternalStore(subscribeBusy, getBusySnapshot, () => false);
}

/**
 * Claim busy for as long as `active` is true and the component is mounted.
 * Call this from any surface holding work that a reload would destroy.
 */
export function useBusyWhile(active) {
  useEffect(() => {
    if (!active) return undefined;
    return markBusy();
  }, [active]);
}
