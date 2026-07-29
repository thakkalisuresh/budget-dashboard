// ════════════════════════════════════════════════════════════════════════════
// useGlobalShortcuts.js — wire up the user-configurable keyboard shortcuts.
// Reads the shortcut strings from Settings (like "ctrl+e") and runs the matching
// action when that combo is pressed — unless the user is currently typing in a field.
// ════════════════════════════════════════════════════════════════════════════
import { useEffect } from 'react';

/**
 * Settings-driven keyboard shortcuts (e.g. Ctrl+E → add expense).
 * `shortcuts` is the settings.keyboardShortcuts object: { addExpense: 'ctrl+e', ... }
 * `actions` maps each shortcut key → handler function.
 */
export function useGlobalShortcuts(shortcuts, actions) {
  useEffect(() => {
    if (!shortcuts) return;   // nothing configured → attach nothing
    // Does a keydown event match a combo string like "ctrl+shift+e"?
    const matches = (e, combo) => {
      if (!combo) return false;
      const parts = combo.toLowerCase().split('+');   // e.g. ["ctrl", "e"]
      const key   = parts[parts.length - 1];          // the main key is the last part
      return (
        e.key.toLowerCase() === key &&                // correct key pressed, AND
        e.ctrlKey  === parts.includes('ctrl') &&      // each modifier matches EXACTLY
        e.shiftKey === parts.includes('shift') &&     // (so "ctrl+e" won't fire on Ctrl+Shift+E)
        e.altKey   === parts.includes('alt') &&
        e.metaKey  === parts.includes('meta')
      );
    };
    const handler = (e) => {
      // Don't steal keystrokes while the user is typing in an input/textarea/select.
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      // Check each configured shortcut; run the first one that matches, then stop.
      for (const [name, combo] of Object.entries(shortcuts)) {
        if (matches(e, combo) && actions[name]) {
          e.preventDefault();   // suppress the browser's built-in action for that combo
          actions[name]();
          return;
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);  // cleanup on unmount
  }, [shortcuts, actions]);
}
