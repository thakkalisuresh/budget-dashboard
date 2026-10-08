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

## Phase roadmap (revised 2026-10-07)

Phase 1 (above) is **Done**. Phases 2–3 build a holdings-aware **recommendation
engine** — a transparent, rule-based layer that never issues a buy/sell verdict.

### Design sources & licensing

The overlap, concentration, and rebalancing algorithms are ported (to JS) from
two **MIT-licensed** reference projects; their copyright notices are preserved in
`NOTICE`:

| Source | License | What we take |
|---|---|---|
| [etfray](https://github.com/alwank/etfray) | MIT | `calculate_weight_overlap` (Σ min(wₐ,w_b)), `calculate_concentration` (HHI → effective-N → verdict), EDGAR N-PORT fetch approach |
| [ws-rebalancer](https://github.com/EmilMaric/ws-rebalancer) | MIT | greedy buy-only rebalance: repeatedly buy one share of the most-under-target position (cheapest as tiebreak) until cash is spent |

Only these two contribute code. [folioxtracker](https://github.com/chrishanfernando/folioxtracker)
(no license = all rights reserved) and Ghostfolio / Wealthfolio (AGPL-3.0, a
network-copyleft that would force open-sourcing all of Fundient) were evaluated
and **rejected on license** — ideas aren't copyrightable, but their code is off
limits, and neither offered a concept the two MIT sources don't already cover.

### Core engine — `investInsights.js`

One deterministic module, two surfaces. No LLM verdicts anywhere.

- **Overlap** (etfray): normalize each holdings set to sum 100, then
  `overlap = Σ min(weightₐ, weight_b)` over shared tickers. Handles partial
  N-PORT filings by renormalizing against the actual column sum.
- **Concentration** (etfray): HHI = Σ wᵢ²; effective-N = 1/HHI; verdict
  `>100 broadly diversified · >30 moderately concentrated · else highly
  concentrated`; plus top-1/5/10 weights and per-sector grouping.
- **Rebalancing** (ws-rebalancer): greedy share-granular buys toward a target
  allocation the user sets; buy-only (never suggests sells).

### Phase 2 — EDGAR look-through + Candidate Check

- **Full EDGAR N-PORT look-through** (`edgarService.mjs`, Cloud Function): resolve
  ticker → CIK → latest `NPORT-P` filing via `data.sec.gov` full-text search, parse
  the holdings XML, cache in a new **`EtfHoldings`** sheet tab (refresh on a cadence;
  N-PORT is filed quarterly). Requires a descriptive `User-Agent` per SEC fair-access
  rules. This is the accuracy foundation for *any* ETF overlap, not just known indexes.
- **Candidate Check dialog** (`CandidateCheckDialog.jsx`): a modal (same pattern
  as `AddActivityDialog` / `ImportCsvDialog`), opened from a new **"Check"** button
  in the InvestTab header action row (beside Import / Activity); a secondary entry
  point is a "+ add" affordance on the equity rows that opens it pre-filled. Type a ticker →
  1. fetch its holdings (ETF → EDGAR look-through; stock → itself at 100%);
  2. **overlap** vs the user's combined portfolio ("68% already owned via VOO + AAPL/MSFT/NVDA");
  3. **concentration delta** — recompute HHI/sector with the hypothetical add
     ("tech 72% → 81%");
  4. **market factors** (data relay, Finnhub): 52-week position, analyst
     recommendation trend, valuation vs sector — facts only;
  5. **"Worth it?" rule-check** — transparent flags from `settings.candidateRules`
     showing *which checks fired and why* (e.g. "3 of 5 flag caution: high overlap,
     over your 80% tech cap, near 52-wk high ✓ analyst trend improving ✓ valuation
     in-line"). The user owns every threshold; the dialog renders no verdict.
- **Rate-watch scheduled function** (`rate-watch.mjs`): Gemini + Google Search
  grounding, 1st & 15th, digest to Telegram + push, writes the `RateWatch` tab.

### Phase 3 — Portfolio Insights card + rebalancing

- **Portfolio Insights card** (always-on, no ticker): a new card appended to the
  bottom of the InvestTab scroll, after `InvestSplitDonut` (holdings → visualization
  → insights). Shows concentration verdict + top
  holdings; rate-optimization (cash in the lower-APY HYSA); ETF-overlap map across
  held funds (reuses the Phase 2 EDGAR cache).
- **Rebalancing suggestion** (ws-rebalancer port): drift vs the user's target
  allocation + the exact buy list to close it; buy-only, with a drift-threshold
  alert.
