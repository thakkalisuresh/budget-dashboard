import { useRef, useEffect, useState } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Animates a numeric value from its previous state to the new target.
 * Uses ease-out-quart easing via requestAnimationFrame.
 * Skips animation when prefers-reduced-motion is set.
 */
export function useCountUp(target, duration = 500) {
  const [display, setDisplay] = useState(target);
  const prev = useRef(target);
  const raf  = useRef(null);

  useEffect(() => {
    if (prefersReducedMotion()) {
      prev.current = target;
      setDisplay(target);
      return;
    }

    const from = prev.current;
    const to   = target;
    prev.current = target;

    if (from === to) return;

    const t0 = performance.now();

    const tick = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      // ease-out-quart
      const eased = 1 - Math.pow(1 - p, 4);
      setDisplay(from + (to - from) * eased);
      if (p < 1) {
        raf.current = requestAnimationFrame(tick);
      } else {
        setDisplay(to);
      }
    };

    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);

  return display;
}
