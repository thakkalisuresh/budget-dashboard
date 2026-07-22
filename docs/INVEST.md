# Invest tab

Tracks what invested money *becomes*: two HYSAs (Amex Savings, Happen Bank) with a
**$250k FDIC goal each**, and the Fidelity brokerage (stocks + ETFs). Phase 1 of 3.

## Data model

One dedicated **"Fundient Investments"** spreadsheet — deliberately *not* tabs in the
monthly template, because `createMonth` copies the template every month and the new
tabs would leak into every month sheet. Provisioned automatically the first time the
Invest tab opens (`sheetInvest.ensureInvestSheet`), shared with `allowedEmails`, and
its id stored in `UserSettings` as `settings.investSheetId` (readable server-side via
`getUserSettings()` for the Phase-2 rate-watch function).

| Tab | Purpose |
|---|---|
| `Accounts` | one row per account: id, name, type (`hysa`/`brokerage`), institution, APY, balance anchor, balanceAsOf, goal (250000 for HYSAs) |
| `Activities` | append-only event log: date, accountId, type (`BUY SELL DIVIDEND DEPOSIT WITHDRAW INTEREST FEE`), symbol, qty, price, amount, note, uuid. Holdings + FIFO lots are **derived** client-side (`investMath.deriveHoldings`) — Ghostfolio-style, nothing stored twice |
| `Snapshots` | balance history points (written on every balance update) |
| `RateWatch` | scan log written by the Phase-2 scheduled function; the Rate-watch card shows an empty state until the first run |

## Quotes ($0 by construction)

`/api/quotes` (`functions/quotes.mjs`) proxies Finnhub so the API key never reaches
the client bundle. Auth = same stack as the push endpoints (allowlisted origin,
`sec-fetch-site`, Google bearer + `ALLOWED_EMAILS`). ≤30 symbols/request, 60s
per-instance cache, `maxInstances: 2`. The client (`useQuotes`) polls every 60s
**only while the Invest tab is mounted and the app is visible** — background quota
burn is structurally impossible. Quotes are ~15-min delayed on Finnhub's free tier;
missing quotes fall back to average cost with a "cost basis" badge.

**Setup:** create a free key at finnhub.io, then
`firebase functions:secrets:set FINNHUB_API_KEY` **before** the function first deploys.

If Finnhub's free tier ever degrades: swap the fetcher in `functions/quotes.mjs`
(single function, normalised shape) — Yahoo's unofficial `query1.finance.yahoo.com`
chart endpoint or Twelve Data's free tier are drop-in candidates.

## Seeding & imports

- **Fidelity CSV** (`fidelityCsvParser.js`): a *positions* export seeds one opening
  lot per symbol at average cost basis (fast start); an *activity/history* export
  imports true dated lots, dividends, and deposits. Both tolerate Fidelity's junk
  (disclaimer tails, `SPAXX**` cash sweep, "Pending Activity" rows).
- **Manual**: any activity via the Add-activity dialog; HYSA balance/APY by tapping
  a gauge.
- **Flow-through** (`investFlowThrough.js`): expenses saved under the *Investment*
  budget category mirror as `DEPOSIT`s using `settings.investAccountRules`
  (vendor-contains matching, most specific wins) and bump the matched HYSA's
  balance. Fire-and-forget: a mirror failure never blocks the expense.

## UI (approved hybrid mockup, ported 1:1)

Ticker tape → orbital hero (planet size ∝ dollar weight; HYSAs ring 1, top equities
ring 2, rest ring 3, tail folds into a `+N` moon) → savings card with liquid FDIC
gauges + projection + years-to-goal → account card with ‹ › switcher and 3D tilt →
rate-watch card → Apple-Stocks-style equity rows (live tick flashes, today-range
sparklines from real open/high/low/last) → ETF/stock split donut (Split ⇄ Holdings).

Chart palette (dark-surface CVD-validated, fixed order): `#6366f1 #d97706 #0d9488
#f43f5e #0284c7`; legends never rely on colour alone; all motion is
transform/opacity and dies under `prefers-reduced-motion` (see the Invest block at
the end of `index.css`).

Nav: Invest took Split's BottomNav slot; Split remains a desktop tab and lives in
the header user menu on mobile.

## Phase roadmap

1. **Done** — everything above.
2. Rate-watch scheduled function (Gemini + Google Search grounding, 1st & 15th,
   digest to Telegram + push, writes `RateWatch`), pre-buy check dialog
   (quote + 52-wk context + Finnhub analyst recommendation trends + rule-based
   flags from `settings.preBuyThresholds` — data relay, never a verdict).
3. ETF look-through overlap via SEC EDGAR N-PORT (cached in an `EtfHoldings` tab).
