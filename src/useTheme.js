import { useState, useEffect, useRef } from 'react';

/**
 * Manages dark/light mode, font size, and accent color CSS injection.
 * Extracts ~70 lines of state + effects from the Dashboard component.
 */
export function useTheme(settings, updateSettings) {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved) return saved === 'dark';
    return true;
  });

  // Sync theme when settings.theme changes (e.g. from another device)
  useEffect(() => {
    if (!settings.theme || settings.theme === 'system') return;
    const dark = settings.theme === 'dark';
    setIsDark(dark);
  }, [settings.theme]);

  // Font size applied to <html>
  useEffect(() => {
    const sizes = { sm: '14px', base: '16px', lg: '18px' };
    document.documentElement.style.fontSize = sizes[settings.fontSize] || '16px';
  }, [settings.fontSize]);

  // Accent color — injects a <style> block that overrides every indigo-* class.
  // Also sets --accent-hue for the redesign/v2 OKLCH token system.
  useEffect(() => {
    const HUE_MAP = {
      default: 270, rose: 10, emerald: 145, amber: 55, sky: 210, violet: 285,
    };
    document.documentElement.style.setProperty(
      '--accent-hue', String(HUE_MAP[settings.colorScheme] ?? 55)
    );

    const SCHEMES = {
      default: { c600:'#4f46e5', c700:'#4338ca', c500:'#6366f1', c400:'#818cf8', c50:'#eef2ff', cdark:'rgba(99,102,241,0.2)',  cshadow:'rgba(99,102,241,0.25)',  c300:'#a5b4fc' },
      rose:    { c600:'#e11d48', c700:'#be123c', c500:'#f43f5e', c400:'#fb7185', c50:'#fff1f2', cdark:'rgba(225,29,72,0.2)',   cshadow:'rgba(225,29,72,0.25)',   c300:'#fda4af' },
      emerald: { c600:'#059669', c700:'#047857', c500:'#10b981', c400:'#34d399', c50:'#ecfdf5', cdark:'rgba(5,150,105,0.2)',   cshadow:'rgba(5,150,105,0.25)',   c300:'#6ee7b7' },
      amber:   { c600:'#e07c00', c700:'#c46a00', c500:'#f08c10', c400:'#f5a840', c50:'#fff7ed', cdark:'rgba(224,124,0,0.16)',  cshadow:'rgba(224,124,0,0.28)',   c300:'#fcc27a' },
      sky:     { c600:'#0284c7', c700:'#0369a1', c500:'#0ea5e9', c400:'#38bdf8', c50:'#f0f9ff', cdark:'rgba(2,132,199,0.2)',   cshadow:'rgba(2,132,199,0.25)',   c300:'#7dd3fc' },
      violet:  { c600:'#7c3aed', c700:'#6d28d9', c500:'#8b5cf6', c400:'#a78bfa', c50:'#f5f3ff', cdark:'rgba(124,58,237,0.2)',  cshadow:'rgba(124,58,237,0.25)',  c300:'#c4b5fd' },
    };
    const s = SCHEMES[settings.colorScheme] || SCHEMES.default;
    let el = document.getElementById('accent-override');
    if (!el) { el = document.createElement('style'); el.id = 'accent-override'; document.head.appendChild(el); }
    el.textContent = `
      .bg-indigo-600, .dark\\:bg-indigo-700  { background-color: ${s.c600} !important; }
      .hover\\:bg-indigo-700:hover           { background-color: ${s.c700} !important; }
      .bg-indigo-50, .dark\\:bg-indigo-900\\/20, .dark\\:bg-indigo-900\\/30 { background-color: ${s.c50} !important; }
      .text-indigo-600, .dark\\:text-indigo-400 { color: ${s.c600} !important; }
      .text-indigo-500                       { color: ${s.c500} !important; }
      .text-indigo-400                       { color: ${s.c400} !important; }
      .border-indigo-300, .dark\\:border-indigo-600 { border-color: ${s.c300} !important; }
      .ring-indigo-500\\/40, .focus\\:ring-indigo-500\\/40:focus { --tw-ring-color: ${s.cshadow} !important; }
      .shadow-indigo-200, .dark\\:shadow-indigo-900\\/30 { --tw-shadow-color: ${s.cshadow} !important; }
      .hover\\:text-indigo-500:hover, .hover\\:text-indigo-600:hover, .dark\\:hover\\:text-indigo-400:hover { color: ${s.c500} !important; }
      .hover\\:bg-indigo-50:hover, .dark\\:hover\\:bg-indigo-900\\/30:hover { background-color: ${s.cdark} !important; }
      .bg-indigo-500 { background-color: ${s.c500} !important; }
      .text-indigo-100 { color: ${s.c50} !important; }
      .text-indigo-300 { color: ${s.c300} !important; }
      .bg-indigo-100\\/50 { background-color: ${s.cdark} !important; }
      .dark\\:bg-indigo-900\\/40 { background-color: ${s.cdark} !important; }
      .hover\\:border-indigo-300:hover, .dark\\:hover\\:border-indigo-600:hover { border-color: ${s.c300} !important; }
    `;
  }, [settings.colorScheme]);

  // Apply dark class + persist + sync settings.
  // Skip the first fire (initial mount) — settings haven't loaded yet at that
  // point, so calling updateSettings would save DEFAULT_SETTINGS (including the
  // default colorScheme) and overwrite the user's saved accent color.
  const isFirstDarkRender = useRef(true);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    if (isFirstDarkRender.current) { isFirstDarkRender.current = false; return; }
    updateSettings(prev => ({ ...prev, theme: isDark ? 'dark' : 'light' }));
  }, [isDark]);

  return { isDark, setIsDark };
}
