// ════════════════════════════════════════════════════════════════════════════
// useEscapeDismiss.js — a custom hook that closes the topmost open layer on Esc.
// A "hook" is a reusable function whose name starts with `use` and which plugs
// into React's lifecycle. This one attaches a keyboard listener while a component
// is on screen, and tidies it up when the component leaves.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect } from 'react';

/**
 * Global Escape key handler — closes the topmost open panel.
 * `layers` is an ordered array of { active: boolean, dismiss: () => void }.
 * The first layer where `active` is truthy gets dismissed on Escape.
 */
export function useEscapeDismiss(layers) {
  // useEffect runs "side effects" — here, adding and later removing a listener.
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;          // ignore every key except Escape
      // Walk the layers from top to bottom; dismiss the first open one, then stop
      // so a single Esc only closes one layer at a time.
      for (const { active, dismiss } of layers) {
        if (active) { dismiss(); return; }
      }
    };
    document.addEventListener('keydown', handler);
    // The returned function is the "cleanup": React runs it on unmount (and before
    // each re-run) so we never leave duplicate listeners behind.
    return () => document.removeEventListener('keydown', handler);
  });
  // Note: no dependency array on purpose — this re-subscribes every render so the
  // handler always closes over the latest `layers` (their `active` flags change).
}
