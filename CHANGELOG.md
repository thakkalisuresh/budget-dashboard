# Changelog

## [2026-05-27] — UI Overhaul + Offline Biometric Unlock

### Visual

- Budget bars replaced with CSS `@property`-animated gradient fills (green → amber → red based on % spent). No JS colour logic — the gradient is driven entirely by the registered `--bar-pct` custom property with a CSS transition.
- Donut chart slices morph between months via imperative D3 arc tweening (700ms ease-out-quart). Slices animate from their previous position rather than redrawing, with mid-tween resume if the month changes during animation.
- Sonar pulse animation on the live status dot in the header.
- Tab switcher uses a single sliding indicator div instead of toggling active classes.
- All buttons respond with `scale(0.97)` on press.
- Month switch triggers a crossfade on the main data container.
- Hero stat sits directly on the page background (no card chrome).
- Bar thickness increased from 6px to 10px. Legend text floor raised to 12px.
- Accent colour picker in the header — single `--primary-hue` OKLCH variable, persists to `localStorage`.

### Functionality

- **Offline biometric unlock**: when the PWA is reopened without an internet connection, WebAuthn (Face ID / fingerprint) gates access to the cached dashboard profile instead of blocking on Google Sign-In. The offline session is read-only with expenses queued; the session upgrades silently when connectivity returns.
- **Background Sync**: the offline expense queue registers a `budget-sync-expenses` sync tag. On Android, the browser drains the queue when connectivity returns even if the app is in the background. On iOS, drains on next app open.
- **Sync toast**: a green "N expenses synced" banner appears briefly after the offline queue drains.
- **Offline banner** shows pending expense count when the queue is non-empty.
- Empty month states: table placeholder, donut placeholder circle, bars at 0% with budget shown.
- Unbudgeted categories display `$50 / —` instead of `$50 / $1`.
- Long category names truncated with `title` attribute for hover tooltip.
- API errors distinguish rate limit (429), access denied (403), Sheets unavailable (5xx), and offline.
- Large numbers formatted with `toLocaleString()` (e.g. 12,346 not 12346).

### Copy

- Over-budget alert: removed "aggregate", added "adjust in your spreadsheet" (actionable).
- Page title personalised to "[First name]'s Budget".
- Banner icons replaced with Lucide SVGs (EyeOff, WifiOff, CalendarX).

### Mobile

- Header icon touch targets raised to 44px minimum.
- Expense table switches to card-per-row layout below `md:` breakpoint.
- Month labels abbreviate to `Jan 2026` at narrow widths.

### Performance

- D3 imports tree-shaken to named sub-packages (`d3-shape`, `d3-scale-chromatic`, `d3-interpolate`).
- Plus Jakarta Sans loads only weights 400/500/700/800 with `font-display: optional`.

### Bug Fixes

- Budget bars use `scaleX` instead of `width` to avoid layout thrash.
- `transition-all` replaced with explicit property lists in HeaderBar.
- `font-black` replaced with `font-extrabold` where Plus Jakarta Sans caps at weight 800.
- `item.budget || 1` fallback removed — unbudgeted state is now explicit.
- Add Expense button disabled during Sheets API write to prevent double-submit.
- `--ease-spring` removed from index.css (browser unsupported); replaced with `--ease-out`.
- ARIA added to tab switcher (`role="tablist"`, `role="tab"`, `aria-selected`).
- Focus ring opacity increased to full contrast.
- `aria-label` added to icon-only buttons in HeaderBar.
- RAF unmount guard removed from BudgetBarsChart and DonutChart — the previous `isMounted` ref pattern broke silently under React 19 Strict Mode double-invoke.

---

## [2026-04] — Initial Build

- Google OAuth login with server-side email allowlist (Netlify Edge Function).
- Google Sheets as data backend — reads budget rows, writes expense entries.
- Monthly budget view: category list with actual vs. budget, running totals.
- Expense table with inline editing and add/delete.
- Per-category detail panel with transaction history.
- Donut chart (spending distribution) and budget bars chart.
- History tab — month-over-month spending trends.
- Ledger tab — full transaction log with search and filter.
- Receipt scanning via Claude Haiku (camera capture + file upload, PDF statement import).
- Bank reconciliation — CSV and PDF import, category matching.
- AI chat agent — budget questions in plain language, Claude-backed.
- Dark mode with `prefers-color-scheme` and manual toggle.
- PIN lock with PBKDF2 hashing and AES-GCM token encryption.
- Biometric unlock (WebAuthn) registered alongside PIN.
- Offline queue: writes buffered in `localStorage` when offline, replayed on reconnect.
- Service worker (Workbox): precached app shell, NetworkFirst for Sheets API.
- Web Push notifications: daily digest, over-budget alerts.
- Multi-user support: owner and viewer roles via `VIEWER_EMAILS` env var.
- Non-monthly expense tracking.
- 50/30/20 rule analysis tab.
- Smart rules: auto-categorise known vendors without an AI call.
- Draggable category order.
- Keyboard shortcuts.
- Settings panel: currency, lock timeout, push hour, category icons, accent colour.
- PWA manifest + install prompt.
