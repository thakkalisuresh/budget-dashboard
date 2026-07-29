// ════════════════════════════════════════════════════════════════════════════
// useCountUp.js — animate a number smoothly from its old value to a new one.
// Used so figures like "$1,055" roll up instead of snapping, which feels nicer.
// Honors the OS "reduce motion" accessibility preference by skipping the animation.
// ════════════════════════════════════════════════════════════════════════════
import { useRef, useEffect, useState } from 'react';

// Read the user's "I prefer reduced motion" OS/browser setting (accessibility).
const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Animates a numeric value from its previous state to the new target.
 * Uses ease-out-quart easing via requestAnimationFrame.
 * Skips animation when prefers-reduced-motion is set.
 */
export function useCountUp(target, duration = 500) {
  const [display, setDisplay] = useState(target);  // the number actually shown right now
  // useRef holds a value that survives re-renders WITHOUT causing one when changed.
  const prev = useRef(target);   // remembers the previous target between renders
  const raf  = useRef(null);     // id of the pending animation frame, so we can cancel it

  useEffect(() => {
    // Accessibility path: jump straight to the value, no animation.
    if (prefersReducedMotion()) {
      prev.current = target;
      setDisplay(target);
      return;
    }

    const from = prev.current;   // where we animate from
    const to   = target;         // where we animate to
    prev.current = target;       // record the new value for next time

    if (from === to) return;     // value didn't change → nothing to animate

    const t0 = performance.now(); // high-precision start time

    // `tick` runs once per screen refresh (~60x/sec) until the animation finishes.
    const tick = (now) => {
      const p = Math.min((now - t0) / duration, 1);  // progress from 0→1, capped at 1
      // ease-out-quart: moves fast at first, then gently decelerates near the end.
      const eased = 1 - Math.pow(1 - p, 4);
      setDisplay(from + (to - from) * eased);        // interpolate between from and to
      if (p < 1) {
        raf.current = requestAnimationFrame(tick);   // not done → schedule the next frame
      } else {
        setDisplay(to);                              // done → land exactly on the target
      }
    };

    cancelAnimationFrame(raf.current);   // cancel any animation already in flight
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);  // cleanup: stop animating on unmount
  }, [target, duration]);   // re-run whenever the target (or duration) changes

  return display;   // the component renders this continuously-updating number
}
