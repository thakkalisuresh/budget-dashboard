# Architecture Overview

Fundient is a personal budget dashboard built with React + Vite, deployed on Netlify, and backed by Google Sheets as its primary data store.

## High-Level Data Flow

```
Browser (React SPA)
  |
  |── Google OAuth 2.0 (login, silent token refresh)
  |── Google Sheets API (read/write budget data)
  |── Google Drive API (copy template sheet for new months)
  |
  |── Netlify Edge Functions (Deno, runs at CDN edge)
  |     |── /api/verify-user   (email allowlist check, returns role)
  |     |── /api/claude        (Anthropic API proxy — receipt scanning, chat)
  |
  |── Netlify Functions (Node.js)
  |     |── push-subscribe     (save Web Push subscription to Netlify Blobs)
  |     |── push-unsubscribe   (remove push subscription)
  |     |── push-alert         (send push notification on budget threshold)
  |     |── push-digest        (scheduled weekly spending digest)
  |
  |── Service Worker (Workbox)
  |     |── Precache app shell (offline-capable)
  |     |── NetworkFirst for Sheets API (1h / 50-entry cap)
  |     |── Background Sync handler (drains offline queue on reconnect)
  |     |── Push notification handler
  |
  |── localStorage / sessionStorage
        |── Auth profile cache, PIN hash, AES encryption salt
        |── Offline expense queue, smart rules, custom categories
        |── Budget data cache (per sheet), FX rate cache
        |── Theme, settings, accent hue
```

## Client Architecture

### Entry Point

`main.jsx` wraps the app in `GoogleOAuthProvider` and an `ErrorBoundary`, then renders `App`.

### App.jsx (orchestrator)

`App` resolves the top-level auth state and delegates rendering to one of three screens:

```
pendingOfflineUnlock → OfflineUnlockScreen (biometric gate)
!user               → LoginScreen (Google Sign-In)
user                → Dashboard (full app)
```

`Dashboard` manages ~30 state variables via custom hooks:

| Hook | Responsibility |
|---|---|
| `useAuth` | Google OAuth, session lifecycle, PIN/biometric unlock, offline session upgrade |
| `useSheetData` | Sheets API fetch, localStorage warm-start cache |
| `useMonthSelection` | Month navigation, template-based month creation |
| `useSettings` | User preferences (currency, lock timeout, shortcuts, icons) |
| `useTheme` | Dark mode, accent hue, font size |
| `useOfflineSync` | Offline queue drain, Background Sync message handler |
| `usePush` | Web Push subscription management |
| `useMessages` | In-app notification system (budget alerts, insights) |
| `useBudgetSummary` | Derived totals (totalActual, overallRemaining, salary calcs) |
| `useDashboardHandlers` | Event handlers for budget/salary edits, icon picker |
| `useNonMonthlyExpenses` | Non-monthly (annual/one-off) expense tracking |

### Auth State Machine

```
No session + no cache             → LoginScreen (Google Sign-In)
No session + cache + biometric    → OfflineUnlockScreen
  └─ biometric passes             → isOfflineSession (cached data, queue writes)
  └─ internet returns             → silent Google refresh → full session
No session + cache, no biometric  → LoginScreen
Active session (sessionStorage)   → Dashboard
Active session, app backgrounded  → PIN lock (if set) → PinLockScreen
```

`useAuth` stores:
- Full session in `sessionStorage` (`budget_auth`): `{ email, name, picture, role, accessToken, expiresAt, encToken? }`
- Profile only in `localStorage` (`budget_auth_cache`): `{ email, name, picture, role, expiresAt }` — no token

The offline session (`isOfflineSession: true`) carries the profile but no `accessToken`. Sheets API calls are skipped; writes go to the offline queue. The session upgrades silently when the `online` event fires and Google's silent refresh succeeds.

### Offline Architecture

**Write queue (`offlineQueue.js`)**
- `enqueue(item)` → writes to `localStorage` + registers a `budget-sync-expenses` Background Sync tag
- `dequeue(id)` → removes a processed item
- Background Sync registration is best-effort (`reg.sync?.register(...)`) — silently skipped if the API is unavailable

**Service worker Background Sync (`sw.js`)**
- `sync` event for tag `budget-sync-expenses` → posts `{ type: 'DRAIN_OFFLINE_QUEUE' }` to all open window clients
- On Android Chrome: fires when connectivity returns, even with the app in the background
- On iOS Safari: Background Sync API is not supported; drains on next app open via the `online` event listener

**Queue drain (`useOfflineSync.js`)**
- Listens for `online` events and SW `DRAIN_OFFLINE_QUEUE` messages
- Requires `user.accessToken` (won't drain during an offline session)
- Uses `navigator.locks` to prevent cross-tab duplicate writes
- Sets `syncedCount` on completion → Dashboard shows a "N expenses synced" toast for 4 seconds

### Animation Architecture

**Budget bars — CSS `@property` + `clip-path`**

`--bar-pct` is registered as an animatable `<number>` property via `@property` in `index.css`. The `.bar-gradient-fill` class applies a fixed `linear-gradient` (green → amber → red) clipped with `clip-path: inset(0 calc((100 - var(--bar-pct)) * 1%) 0 0)`. The transition on `--bar-pct` drives the reveal animation — no JS colour logic.

**Donut chart — imperative D3 arc morphing**

`DonutChart` uses `useLayoutEffect` keyed on `dataKey` (a string of `name:actual` pairs). The effect:
1. Snapshots starting arc angles from `currentArcs` ref (supports mid-tween resume) or `prevArcs` (last settled state)
2. Synchronously sets each `<path d>` to the starting state before paint (no blank-frame flash)
3. Runs a 700ms RAF tween with ease-out-quart interpolation, updating `<path d>` imperatively
4. Settles `prevArcs` and `currentArcs` refs on completion

Paths are keyed by `d.data.name` (not index) so ref stability holds across data changes.

**Other animations**

| Element | Mechanism |
|---|---|
| Live status dot | CSS `@keyframes sonar` — scale + opacity ring, 2s loop |
| Tab indicator | Single `<div>` with `translateX(calc(tabIdx * 100%))`, 150ms |
| Button press | Global `button:active { transform: scale(0.97) }` |
| Month switch | `animate-crossfade-in` class swap on the data container |
| User menu open | `animate-dropdown` — translateY(-4px)→0 + opacity 0→1 |
| Bar/legend entrance | `opacity + translateY` with staggered `transitionDelay` |

All animations respect `prefers-reduced-motion` — the DonutChart tween and BudgetBarsChart mount animation both snap to final state when reduced motion is preferred.

### Data Layer

`sheetsApi.js` is a barrel that re-exports from 10 focused modules:

| Module | Responsibility |
|---|---|
| `sheetHelpers` | Constants, `SHEET_MAP`, `safeText()`, pure utilities |
| `sheetApi` | Low-level `batchGet` / `batchUpdate` wrappers |
| `sheetDetail` | Per-category transaction cache and reads |
| `sheetHistory` | History sheet ensure / append / fetch |
| `sheetUndo` | Undo support |
| `sheetTotals` | Totals sheet CRUD |
| `sheetExpenses` | Expense add / update / rename / delete, offline enqueue |
| `sheetNonMonthly` | Non-monthly expense tracking |
| `sheetCategories` | Category CRUD |
| `sheetCards` | `ensureCardsSummarySheet()` — formula-driven Cards Summary tab |

### Payment Methods & Card Rewards

Transactions can record which card/account paid for them. Tracking is active for **V2 sheets (June 2026 onward)**; older rows stay blank — there is no migration.

**V2 category-sheet schema** — two variants depending on category:

**Travel / Holiday** (8 cols):

| Col | Index | Field |
|-----|-------|-------|
| A | 0 | Month |
| B | 1 | Year |
| C | 2 | Date (anchor — `detectV2` checks `header[2] === 'Date'`) |
| D | 3 | Vendor |
| E | 4 | Amount |
| F | 5 | Payment Method |
| G | 6 | Booking Method (`''` = portal default, `'direct'` = direct booking) |
| H | 7 | UUID (always last) |

**All other categories** (7 cols, no Booking Method):

| Col | Index | Field |
|-----|-------|-------|
| A–F | 0–5 | Same as above |
| G | 6 | UUID (always last) |

Booking Method is only meaningful for CSR airline/hotel transactions — writing it to every category sheet would add an empty column with no purpose. UUID is always the last column in both variants.

**History sheet schema** (cols A–L):
- Col K (index 10): Payment Method
- Col L (index 11): Booking Method
- Bot rows use a padded layout (uuid at index 6, user at 7, empty at 8) so `getRecentExpenses` can distinguish bot vs. web rows while still landing paymentMethod at col K.

**Cards Summary tab**: formula-driven (`sheetCards.ensureCardsSummarySheet`), created on first Cards tab visit. A single `QUERY` over `History!A:K` aggregates spend / count / last-date / last-vendor per card — live, no app writes after creation.

**Settings** (`useSettings` → `DEFAULT_SETTINGS`)
- `cards`: pre-seeded list of card/account names (user-editable in Settings).
- `cardRules`: `[{ id, vendorPattern, category, card }]` — auto-assigns a card. Category-specific rules beat vendor-only; longer patterns beat shorter.
- `cardRewardRates`: `null` = use hardcoded `CARD_REWARDS`; set to a custom rate table by APPLY RATES or the Settings UI. Read via `getEffectiveRates(settings)`.

**Resolution chain** (used by add-expense, scanner, import, reconcile, bot):
`Vision-extracted card → resolveCardName() fuzzy match against cards list → applyCardRules(vendor, category) → manual pick`. `resolveCardName` normalizes punctuation/case and guards short names (e.g. "Cash" won't match "…active cash").

**MCC-based rewards engine** (`src/cardRewards.js` + `src/vendorMCC.js`, mirrored server-side in `netlify/functions/_card-rewards.mjs`)

Rates are keyed by Merchant Category Code (MCC), not app category name, so they work correctly across vendors (e.g. Uber → rideshare 3% on Amex, Uber Eats → dining 5812 not rideshare).

`src/vendorMCC.js` — two tables:
- `VENDOR_MCC`: ~80 known vendors → MCC (substring-matched, longest key first). Not exhaustive; unknown vendors fall back to `CATEGORY_DEFAULT_MCC`.
- `CATEGORY_DEFAULT_MCC`: app category → fallback MCC (e.g. Entertainment → 7996, not 7372, so unknown streaming services don't incorrectly earn Amex 6%).
- `resolveMCC(vendor, category)` — exported and re-exported from `cardRewards.js`; used by all callers before `calculateRewards`.

`src/cardRewards.js` rate table shape (per card):
```js
{
  type: 'points' | 'cashback',
  unit: 'UR' | '$',
  pointValue: number,           // for points cards ($ per point for display)
  mccs: {
    '5812': 3,                  // flat rate
    '4511': { portal: 8, direct: 4 },   // booking-method split (CSR travel)
    '5411': { rate: 6, cap: { annual: 6000, then: 1 } },  // capped category
  },
  default: number,              // catch-all rate for unlisted MCCs
}
```

Reward cards and rates:

| Card | Type | Key rates |
|---|---|---|
| Chase Sapphire Reserve | Points (UR, 1.5¢) | 3x dining, 8x travel portal / 4x direct, 1x default |
| American Express Blue Cash Preferred | Cashback | 6% supermarkets (cap $6k/yr), 6% streaming, 3% gas, 3% transit, 1% default |
| Capital One Quicksilver | Cashback | 1.5% flat |
| Chase Freedom Unlimited | Points (UR, 1¢) | 3x dining + pharmacy, 1.5x default |
| Bilt Blue Card | Points (Bilt, 1.25¢) | 3x dining, 2x travel, 1x default |

Key functions:
- `calculateRewards(card, mcc, amount, ytdSpend, bookingMethod, rates)` — `mcc` from `resolveMCC`; `bookingMethod` for CSR portal/direct; `rates` defaults to `CARD_REWARDS` but respects `getEffectiveRates(settings)`.
- `getEffectiveRates(settings)` — returns `settings.cardRewardRates` if set, otherwise `CARD_REWARDS`. Used by CardsTab, bot confirm flow, and rate-check application.
- `getBestCard(category, vendor, rates)` — ranks all reward cards by estimated $/$ return; ties prefer cash back.
- The two rate modules (`cardRewards.js` and `_card-rewards.mjs`) are **duplicated and must be kept in sync** — the server can't import client modules. The drift-guard test `cardRewardsSync.test.js` fails CI on any divergence.

**New month creation** (`src/useMonths.js` → `createMonth`):
After copying the template, `writeV2Headers` writes the correct V2 header row to every category sheet AND clears rows 2–20 to remove stale template content. This prevents Google Sheets named-table definitions (RentTable, GroceryTable, etc.) from causing new expense rows to be written at the wrong position — the Sheets `:append` API was skipping to the end of the table range instead of the first empty row. New expenses now use a direct row write (`PUT` to `values.length + 1`) rather than `:append`.

**Settings merge** (`loadUserSettings`): Any cards in `DEFAULT_SETTINGS.cards` that are missing from the user's saved list are automatically appended on load, so new pre-seeded cards (e.g. Bilt Blue Card) appear without requiring a manual Settings entry.

**Booking method** — stored per transaction only when card = CSR and MCC is a travel code (4511 airlines, 7011 hotels, CHASE_PORTAL). The UI shows the booking method toggle in AddExpenseDialog and ReceiptScanner when both conditions are met.

**Monthly rate auto-check** (`netlify/functions/rate-check.mjs`, `netlify/functions/_rate-check.mjs`)

Scheduled `0 9 1 * *` (1st of month, 09:00 UTC). The deployed wrapper (`rate-check.mjs`) injects Claude Sonnet + web search, Telegram, and Sheets; the core logic lives in `_rate-check.mjs` (pure, DI, fully unit-tested).

Flow:
1. Load effective rates from `getUserSettings()` (or fall back to `CARD_REWARDS`).
2. For each reward card, call Claude Sonnet with `tools: [{ type: 'web_search_20250305' }]` against the issuer page (Bankrate fallback for Amex). Source hints are hardcoded per card.
3. Parse the response with `parseClaudeRates()` — tolerates fenced/prose output; extracts the last valid JSON blob.
4. `diffRateTable(oldCfg, newCfg)` — compares every MCC node + default.
5. **High confidence + actual diff** → store proposal in `rate-proposals/latest` (Netlify Blobs), send Telegram notification to all `TELEGRAM_ALLOWED_USERS`, append read-only in-app message for all `ALLOWED_EMAILS`.
6. Low/medium confidence or no change → silence.

Bot replies: `APPLY RATES` writes `proposal.rates` to `cardRewardRates` for **all household accounts** via `updateUserSettingsFor`. `IGNORE` deletes the proposal blob.

### Key UI Components

| Component | Purpose |
|---|---|
| `LoginScreen` | Google Sign-In, also exports `OfflineUnlockScreen` |
| `HeaderBar` | Nav, month picker, theme toggle, accent colour picker, user menu |
| `StatCard` | Hero metric card (total spent, budget, remaining, salary) |
| `BudgetBarsChart` | Animated gradient budget bars, over-budget alert |
| `DonutChart` | Spending distribution with D3 arc morphing |
| `ExpenseTable` | Budget table with inline editing |
| `DetailPanel` | Per-category transaction detail view |
| `HistoryTab` | Month-over-month trend charts |
| `LedgerTab` | Full transaction log with search/filter |
| `CardsTab` | Per-card spend totals, transaction list, rewards analytics |
| `AddExpenseDialog` | Add expense form with receipt scanning |
| `ReconcileDialog` | Bank statement reconciliation (CSV + PDF) |
| `ChatAgent` | AI budget assistant |
| `PinLock` / `PinLockScreen` | PIN hashing, AES-GCM encryption, WebAuthn, lock screen |
| `SettingsPanel` | User preferences |
| `ThemePicker` | OKLCH hue slider (accent colour) |
| `SpeedDial` | Floating action button (mobile) |
| `OnboardingWizard` | First-run setup flow |

## Server Architecture

### Edge Functions (Deno)

- **verify-user.js**: validates Google access tokens against Google's userinfo endpoint. Checks email against `ALLOWED_EMAILS`. Returns `{ allowed, email, name, picture, role }`. Token hashes cached for 5 minutes (500-entry FIFO cap). Failed tokens cached with 30s TTL (50-entry cap, SEC-15).
- **claude.js**: Anthropic API proxy. Validates bearer token, enforces model allowlist (`claude-haiku-4-5`), caps `max_tokens` at 4096, enforces 8MB body limit. Dual-layer rate limiting: IP 20 req/min, email 10 req/min. Requires `sec-fetch-site: same-origin` header.

### Functions (Node.js)

- **_auth.mjs**: shared auth helpers (origin check, `sec-fetch-site` validation, bearer token verification). Not deployed (underscore prefix).
- **push-subscribe / push-unsubscribe**: Web Push subscription storage via `@netlify/blobs`.
- **push-alert**: sends a push notification on budget threshold breach.
- **push-digest**: scheduled weekly spending summary.

### Messaging Bot (Telegram / WhatsApp)

`telegram-webhook.mjs` and `whatsapp-webhook.mjs` share transport-agnostic logic in `_bot-core.mjs`. Receipt/wallet images are parsed by `_extraction.mjs` (Gemini), which now also returns `payment_method`. The bot resolves a card (Vision → fuzzy match → `cardRules`, all via `getUserSettings()`) and surfaces it in two places:

- **Pending confirmation** — adds a `Card:` line and a `card: <name>` edit option alongside the existing `category:` / `amount:` edits.
- **Logged confirmation** — adds the resolved `Card:`, a **rewards line** from `_card-rewards.mjs` `buildRewardsLine()` (best-card ✓ or a better-card recommendation with estimated savings), and a direct `View Sheet:` link to the month's Google Sheet (`/spreadsheets/d/{sheetId}`).

`_card-rewards.mjs` is a server-side duplicate of `src/cardRewards.js` — keep the rate tables in sync.
