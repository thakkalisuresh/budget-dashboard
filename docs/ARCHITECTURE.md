# Architecture Overview

Fundient is a personal budget dashboard built with React + Vite, deployed on Netlify, and backed by Google Sheets as its primary data store.

## High-Level Data Flow

```
Browser (React SPA)
  |
  |-- Google OAuth 2.0 (login, token refresh)
  |-- Google Sheets API (read/write budget data)
  |-- Google Drive API (copy template sheet for new months)
  |
  |-- Netlify Edge Functions
  |     |-- /api/verify-user   (email allowlist check)
  |     |-- /api/claude        (Anthropic API proxy for receipt scanning)
  |
  |-- Netlify Functions
  |     |-- push-subscribe     (save push subscription to Netlify Blobs)
  |     |-- push-unsubscribe   (remove push subscription)
  |     |-- push-alert         (send push notification on budget threshold)
  |     |-- push-digest        (scheduled weekly spending digest)
  |
  |-- Service Worker (Workbox)
  |     |-- Precache app shell
  |     |-- NetworkFirst for Sheets API (1h / 50-entry cap)
  |     |-- Push notification handler
  |
  |-- localStorage / sessionStorage
        |-- Auth tokens, PIN hash, encryption salt
        |-- Offline queue, smart rules, custom categories
        |-- Theme, settings, FX rate cache
```

## Client Architecture

### Entry Point
`main.jsx` wraps the app in `GoogleOAuthProvider` and renders `App.jsx`.

### App.jsx (orchestrator)
Manages top-level state (~30 variables) via custom hooks:
- `useAuth` -- Google OAuth, session management, PIN/biometric unlock, token encryption
- `useSheetData` -- fetches budget data from Sheets, caches in state
- `useMonths` -- month navigation, template-based month creation
- `useTheme` -- dark mode, accent color, font size
- `useSettings` -- user preferences (lock timeout, shortcuts, non-monthly tracking)
- `useOfflineSync` -- queues writes when offline, replays on reconnect
- `usePush` -- push notification subscription management
- `useMessages` -- in-app notification system

### Data Layer (sheetsApi.js barrel)
`sheetsApi.js` re-exports from 9 focused modules:
- `sheetHelpers` -- constants, SHEET_MAP, pure utilities
- `sheetApi` -- low-level Sheets API wrappers (batchGet, batchUpdate)
- `sheetDetail` -- detail row cache and reads
- `sheetHistory` -- history sheet ensure/append/fetch
- `sheetUndo` -- undo support
- `sheetTotals` -- totals sheet CRUD
- `sheetExpenses` -- expense add/update/rename/delete
- `sheetNonMonthly` -- non-monthly expense tracking
- `sheetCategories` -- category CRUD

### Key UI Components
- `ExpenseTable` -- main budget table with inline editing
- `DetailPanel` -- per-category transaction detail view
- `DashboardGrid` -- draggable grid layout (react-grid-layout)
- `ReceiptScanner` -- camera/file receipt scanning and statement import via Claude
- `ReconcileDialog` -- bank statement reconciliation (CSV + PDF)
- `ChatAgent` -- AI chat for budget questions
- `PinLock` -- PIN entry, PBKDF2 hashing, AES-GCM token encryption
- `SettingsPanel` -- user preferences

## Server Architecture

### Edge Functions (Deno, runs at CDN edge)
- **verify-user.js**: Validates Google access tokens against `ALLOWED_EMAILS` env var. Returns user role (owner/viewer). No secrets in client bundle.
- **claude.js**: Proxies requests to Anthropic API. Validates auth, enforces model allowlist (`claude-haiku-4-5`), caps `max_tokens` at 4096, enforces 8MB body limit. Dual-layer rate limiting (IP: 20/min, email: 10/min).

### Functions (Node.js, runs on Netlify Functions)
- **_auth.mjs**: Shared auth helpers (origin check, sec-fetch-site, bearer verification with cached token hashes). NOT deployed as a function (underscore prefix).
- **push-*.mjs**: Web Push notification management using `@netlify/blobs` for subscription storage and `web-push` for delivery.

## Offline Support
- Service Worker (Workbox) precaches the app shell and caches Sheets API responses with NetworkFirst strategy
- `offlineQueue.js` queues failed writes to localStorage, replays them on reconnect
- `navigator.locks` prevents cross-tab duplicate replays

## Security Layers
See [SECURITY.md](../SECURITY.md) for the token storage tradeoff. Additional layers:
- CSP headers in `netlify.toml` (no unsafe-inline for scripts)
- `sec-fetch-site` validation on edge functions blocks non-browser requests
- MIME validation via magic bytes (not file extension) for uploads
- Formula injection prevention (`safeText`) on all Sheets writes
- PBKDF2 (200k iterations) for PIN hashing, AES-GCM for token encryption
- FX rate plausibility bounds prevent malicious rate injection
