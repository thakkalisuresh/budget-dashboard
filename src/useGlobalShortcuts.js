import { useEffect } from 'react';

/**
 * Settings-driven keyboard shortcuts (e.g. Ctrl+E → add expense).
 * `shortcuts` is the settings.keyboardShortcuts object: { addExpense: 'ctrl+e', ... }
 * `actions` maps each shortcut key → handler function.
 */
export function useGlobalShortcuts(shortcuts, actions) {
  useEffect(() => {
    if (!shortcuts) return;
    const matches = (e, combo) => {
      if (!combo) return false;
      const parts = combo.toLowerCase().split('+');
      const key   = parts[parts.length - 1];
      return (
        e.key.toLowerCase() === key &&
        e.ctrlKey  === parts.includes('ctrl') &&
        e.shiftKey === parts.includes('shift') &&
        e.altKey   === parts.includes('alt') &&
        e.metaKey  === parts.includes('meta')
      );
    };
    const handler = (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      for (const [name, combo] of Object.entries(shortcuts)) {
        if (matches(e, combo) && actions[name]) {
          e.preventDefault();
          actions[name]();
          return;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [shortcuts, actions]);
}
