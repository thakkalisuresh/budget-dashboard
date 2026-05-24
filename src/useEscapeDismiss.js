import { useEffect } from 'react';

/**
 * Global Escape key handler — closes the topmost open panel.
 * `layers` is an ordered array of { active: boolean, dismiss: () => void }.
 * The first layer where `active` is truthy gets dismissed on Escape.
 */
export function useEscapeDismiss(layers) {
  useEffect(() => {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      for (const { active, dismiss } of layers) {
        if (active) { dismiss(); return; }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  });
}
