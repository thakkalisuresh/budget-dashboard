# Changelog

## [2026-06-12] — Backend migration: Netlify → Firebase

### Infrastructure

- **Hosting + API moved from Netlify to Firebase.** The SPA now serves from Firebase Hosting and all server logic runs as Firebase Cloud Functions (2nd gen, Node 22, Express `onRequest`) under `functions/`. Motivation: Netlify Pro's build-minute metering cost ~$20/mo; Firebase builds run in GitHub Actions (no build-minute billing) and Cloud Functions/Hosting usage for a single household stays in the free tier.
- **Netlify Edge Functions (Deno) + Netlify Functions (Node) → unified Cloud Functions.** `verify-user`, `claude`, `push-subscribe/unsubscribe/alert`, `telegram-webhook`, and the `mcp` server were ported with their security controls intact (origin + `sec-fetch-site` gates, token caches, rate limits, model allowlist, body caps).
- **Netlify Blobs → Firestore.** Push subscriptions (`push_subscriptions`), bot state (`bot_state`, via a Blobs-compatible adapter), and MCP rate limits (`mcp_rate_limit`) now live in Firestore. Rules are default-deny — all access is via the Admin SDK.
- **Secrets → Firebase Secret Manager** (declared in `functions/lib/secrets.mjs`, injected at cold start). Client `VITE_*` vars come from GitHub repository variables in CI.
- **CI/CD**: `.github/workflows/ci.yml` gained `deploy-live` (push to `main`/`develop` → `firebase deploy`) and `deploy-preview` (PR hosting channels).
- WhatsApp/Twilio support was dropped (was never fully activated); the bot is Telegram-only.

### Security hardening (Part E review)

- Dropped the legacy Netlify origin from the API CORS allowlist post-cutover.
- Telegram webhook-secret now compared in constant time (`timingSafeEqual` over digests).
- Added the `sec-fetch-site` check to `verify-user`, matching the Claude proxy.

## [2026-06-02] — Post-launch fixes & Bilt Blue Card

### New card

- **Bilt Blue Card** added to the household's card list and rewards engine: 3× Bilt points on dining, 2× on travel, 1× everywhere else (1.25¢/pt). Included in best-card comparisons, Cards tab analytics, bot rewards line, and Settings → Reward Rates editor.

### Schema corrections

- **V2 schema final column order**: UUID is now always the last column. Booking Method (col G) only appears on Travel and Holiday sheets where it is meaningful — all other category sheets use a 7-column layout without it. Final layout: Travel/Holiday = `Month|Year|Date|Vendor|Amount|Payment Method|Booking Method|UUID`; all others = `Month|Year|Date|Vendor|Amount|Payment Method|UUID`.

### Bug fixes

- **New expenses written to wrong row**: the Sheets API `:append` endpoint was skipping past named table ranges (RentTable, GroceryTable, etc.) inherited from the template, causing new transactions to land at row 5 instead of row 2. Fixed by reading the current row count first and writing directly to `values.length + 1` (both web and bot paths). `:append` is no longer used for V2 expense rows.
- **New month template rows**: `createMonth` now writes V2 headers to every category sheet and clears rows 2–20 to remove stale template content that caused the row positioning issue.
- **Bilt Blue Card not visible**: new default cards added in code were not surfaced to existing users whose settings were already saved. `loadUserSettings` now automatically appends any `DEFAULT_SETTINGS.cards` entries missing from the user's saved list.

## [2026-06-01] — Rewards Engine Rewrite

### Functionality

- **MCC-based reward rates**: reward calculations now use Merchant Category Codes (MCC) instead of app category names, enabling accurate per-vendor rates. A vendor table (~80 entries, `src/vendorMCC.js`) maps known merchants to their MCC; unknown vendors fall back to a category-level default.
- **Corrected rates**: CSR travel is now 8× UR via the Chase Travel portal / 4× direct (was flat 3×). Amex Blue Cash Preferred gains streaming 6%, gas 3%, and transit & rideshare 3% (all were missing). Wholesale clubs (Costco, Walmart, Target) correctly earn Amex base 1%, not 6%.
- **Booking method per transaction**: CSR airline/hotel purchases record portal vs. direct booking (col H in V2 sheets). The Add Expense dialog and receipt-scanner confirm screen show an inline toggle ("📊 8× UR — Chase Travel portal · Booked direct instead? → 4×") when card = CSR and the vendor resolves to a travel MCC. The Detail panel shows an amber "✈️ Direct booking · 4× UR" badge. The Telegram bot accepts `booking: direct` as an edit field.
- **Monthly rate auto-check** (`rate-check.mjs`, scheduled 1st of month 09:00 UTC): calls Claude Sonnet + web search against issuer pages (Bankrate fallback for Amex), compares proposed rates against the current table, and on high-confidence changes sends a Telegram notification + in-app message with the proposed diff. Low/medium-confidence findings are silently discarded.
- **`APPLY RATES` / `IGNORE` bot commands**: replying `APPLY RATES` writes the proposed rates to both household accounts. `IGNORE` discards the proposal. Nothing auto-applies.
- **User-editable rates** (Settings → Cards & Payment Methods → Reward Rates): per-card accordion with human-readable rows (Dining, Airlines portal/direct, Streaming, Gas, Transit & rideshare, US Supermarkets, Everything else), inline editing, and "Reset to defaults" per card. Changes saved to `UserSettings` and applied immediately.
- **`getEffectiveRates(settings)`**: all reward calculations — `calculateRewards`, `getBestCard`, `bestCardTable`, `buildRewardsLine`, and the Cards tab — respect user-overridden rates. Default hardcoded rates are used when no override is set.

### Data / Schema

- **V2 category-sheet schema** updated: `Month | Year | Date(C) | Vendor(D) | Amount(E) | Payment Method(F) | UUID(G) | Booking Method(H)`. Col H stores `''` (portal default) or `'direct'` for CSR travel transactions.
- **History sheet** extended to col L (`Booking Method`). Existing rows without col L read as `''`.
- **`UserSettings.cardRewardRates`**: new field (`null` = hardcoded defaults; set by APPLY RATES or Settings UI). Rate proposals stored in Netlify Blobs (`rate-proposals/latest`) between auto-check and user approval.

## [2026-05-31] — Payment Method & Card Rewards Tracking

### Functionality

- **Payment method per transaction**: every expense can now record which card/account was used. Stored in a new column on each category sheet (V2 layout, col F) and in the History sheet (col K). Card tracking applies to transactions from June 2026 onward; older rows are left blank.
- **Cards list & rules** (Settings → Cards & Payment Methods): a pre-seeded, user-editable list of cards (4 credit cards, 2 debit cards, 2 bank accounts, Cash), plus *card rules* that auto-assign a card by vendor pattern and optional category (category-specific rules win over vendor-only).
- **Auto-resolution**: the Add Expense dialog, receipt scanner, statement import, reconciliation, and the Telegram/WhatsApp bot all resolve a card automatically — Vision-extracted card (Apple/Google/Samsung Pay wallet screenshots) → fuzzy match against the cards list → card rules → manual pick.
- **Cards dashboard tab**: per-card spend totals + a filterable transaction list, plus a **Cards Summary** Google Sheet tab (formula-driven, auto-updating) created on first visit.
- **Card badges**: payment method shown on Ledger rows, History entries, and category Detail-pane vendor rows.
- **Rewards analytics** (Cards tab): rewards earned to date (Chase UR points and cash back tracked separately), per-card cash-back breakdown, Amex 6% grocery-cap progress ($6k/yr), a monthly estimated-value trend, and a static "best card per category" recommendation table.
- **Bot rewards check**: the bot confirmation message flags whether the best card was used (`📊 6% cash back — best card for Grocery ✓`) or recommends a better one with estimated savings (`⚠️ … saves ~$4.50 on this transaction`). Confirmation also links the month's Google Sheet directly.

### Data / Schema

- **V2 category-sheet schema** (effective June 2026): `Month | Year | Date | Vendor | Amount | Payment Method (F) | UUID (G)`. UUID shifted from col F to col G to make room. The bot's `appendExpense` was realigned to match.
- **History sheet**: extended to col K (`Payment Method`); the bot's history append is padded so its card also lands in col K while preserving the legacy uuid@6 layout.
- Card reward rates are **pre-seeded in code** (`src/cardRewards.js` + `netlify/functions/_card-rewards.mjs`), not environment-configurable. The two files duplicate the rate table and must be kept in sync.

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
