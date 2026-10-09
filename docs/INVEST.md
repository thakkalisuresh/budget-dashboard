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
| `Accounts` | one row per account: id, name, type (`hysa`/`brokerage`/`mf_in`), institution, APY, balance anchor, balanceAsOf, goal (250000 for HYSAs), `currency` (`USD`; `INR` for `mf_in`; blank reads as that default) |
| `Activities` | append-only event log: date, accountId, type (`BUY SELL DIVIDEND DEPOSIT WITHDRAW INTEREST FEE INR_RECEIVED`), symbol, qty, price, amount, note, uuid, `currency` (`USD`/`INR`), `fxToUsd`. Holdings + FIFO lots are **derived** client-side (`investMath.deriveHoldings`) — Ghostfolio-style, nothing stored twice |
| `SipPlans` | Indian MF SIP config, edited in place: id (stable slug), schemeCode (`unmapped` until the user picks a scheme), name, amc, amountInr, day (optional), accountId, active |
| `Snapshots` | balance history points (written on every balance update) |
| `RateWatch` | scan log written by the Phase-2 scheduled function; the Rate-watch card shows an empty state until the first run |

## Indian mutual funds (`mf_in`)

Tracks monthly USD sent to an Indian NRO account (Wise/Remitly) and the SIPs it
funds. Everything lives on one account (`nro-mf`, currency INR) in the same
append-only Activities log:

1. `DEPOSIT` (USD, `fxToUsd` 1) — the mirror of the Investment-category expense;
   the real USD cost. It is "in transit" until step 2 references it
   (`investMf.inTransitDeposits`).
2. `INR_RECEIVED` (INR) — INR actually credited; `fxToUsd` = USD sent ÷ INR
   received (true FX); note `settles:<depositUuid>` (`settlesNote`).
3. `BUY` (INR) — a confirmed SIP debit: `symbol` = SipPlan id (upper-cased on
   write, e.g. `BIRLA-FLEXI`; compare case-insensitively), `qty` = units, `price`
   = NAV, `amount` = INR debited, `fxToUsd` = the **average-cost INR pool** rate at
   confirm time (`investMf.inrPool`). Because the symbol is the plan id, remapping
   a scheme code later never orphans history; NAV lookup is planId → schemeCode
   (`unmapped` ⇒ no NAV, cost-only).

`fxToUsd` always means *USD per 1 unit of the row's `currency`*; legacy rows
(no currency) are USD, fx 1. INR rows without an fx read `null` — never guessed.

Derived, never stored: INR cash = INR received − BUY − FEE (`inrCashBalance`);
holdings via `deriveHoldings` (native INR lots); USD cost basis per fund
`mfUsdCostBasis` (BUY × stored fx, SELL removes the proportional share);
returns via `investMath.xirr` (dated flows, Newton → bisection, `null` when
undefined); display conversion `convert` / `activityUsd`.

USD isolation: `INR_RECEIVED` is excluded from the manual Add-activity types
(`MANUAL_ACTIVITY_TYPES`), `mf_in` is filtered out of that dialog, and
`monthlyDeposits` counts USD DEPOSITs only (mf_in USD deposits count as
contributions). HYSA/brokerage aggregates are type-filtered so INR never mixes in.

**Upgrading older sheets:** `ensureInvestMf` (called from `useInvestData` before
the first fetch) adds missing tabs, appends missing header columns
(`ensureInvestColumns`; data rows untouched) and seeds `nro-mf` plus the four
SIPs (INR 5,000 each, `unmapped`, names provisional/editable).

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

- **Full EDGAR N-PORT look-through** (`edgarService.mjs` + `etf-holdings.mjs` Cloud
  Function, `/api/etf-holdings?ticker=…`): resolve ticker → CIK → latest `NPORT-P`
  filing → parse the holdings XML
  (`…/Archives/edgar/data/{cik}/{accession}/primary_doc.xml`, via `fast-xml-parser`),
  cache in a new **`EtfHoldings`** sheet tab (refresh on a cadence; N-PORT is filed
  quarterly — `isHoldingsFresh` serves cache while the cached `asOf` is in the current
  quarter). This is the accuracy foundation for *any* ETF overlap, not just known indexes.
  - **Ticker → fund resolution (two sources)**: `company_tickers.json` lists stocks
    and *standalone-trust* ETFs (SPY, DIA) but **not multi-series ETFs** — VOO, QQQ,
    VTI, IVV, SCHD and most Vanguard/iShares/Schwab funds are absent. Those resolve via
    SEC's **Investment Company Series & Class dataset** (a yearly CSV), which maps a
    class ticker → its trust CIK + `seriesId`. A standalone trust is one CIK = one fund,
    so the latest `NPORT-P` is correct; a multi-series trust hosts many series under one
    CIK, so the service **scans recent `NPORT-P` filings (cap `maxSeriesScan`, default
    40, newest first) and matches `genInfo.seriesId`**, early-exiting on the hit. Each
    scanned filing is one `primary_doc.xml` fetch (the target series is usually within
    the first ~dozen); the 24h cache makes this a rare cost.
  - **Identity keys**: N-PORT identifies a holding by name + CUSIP + LEI and **often has
    no ticker**. The normalized shape (`{ name, cusip, ticker, weight }`, weight = percent,
    renormalized to sum ~100) exposes both CUSIP and a best-effort ticker; overlap/
    concentration key on **CUSIP → normalized ticker → normalized name** (see
    `investInsights.holdingKey`). Weights renormalize against the actual `pctVal` column
    sum, so partial filings are handled. Multi-series fund-family trusts: the latest
    `NPORT-P` for a CIK may be a sibling series (single-series ETF trusts resolve exactly).
  - **CUSIP↔ticker reconciliation (PR2)**: because ETF underlyings are CUSIP-keyed and
    direct stocks are ticker-keyed, Apple-in-VOO (`C:037833100`) and a direct `AAPL`
    position (`T:AAPL`) would otherwise count as *distinct* holdings — understating
    overlap and concentration. A CUSIP→ticker map closes the gap in two tiers, cheap
    first: (1) **cache-derived** — `investInsights.buildCusipTickerMap` scans the
    `EtfHoldings` cache for rows carrying both a CUSIP and a best-effort ticker (the
    megacaps that dominate overlap almost always do), free; (2) **OpenFIGI fallback** —
    the `/api/openfigi` Cloud Function (`openfigi.mjs`) resolves still-unmapped CUSIPs via
    Bloomberg's free OpenFIGI `/v3/mapping` (server-side so any `OPENFIGI_API_KEY` stays
    off the client), persisted to a new **`CusipMap`** sheet tab (`cusip | ticker | source`)
    so a CUSIP is resolved at most once. `canonicalizeHoldings(holdings, map)` rewrites a
    holding to its ticker when the CUSIP resolves (PR1's `holdingKey` is left intact);
    `aggregatePortfolio` accepts the map and applies it, and the candidate's holdings are
    canonicalized too, so both sides share one identity space before overlap/concentration.
    `OPENFIGI_API_KEY` is **optional** (key-less OpenFIGI works at ~25 req/min, 10 jobs/req;
    a free key lifts both) — a `defineString` param, not a secret.
  - **Descriptive User-Agent (SEC fair-access, non-negotiable)**: SEC EDGAR rejects
    requests without a descriptive `User-Agent` and browsers forbid overriding it, which
    is *why* the fetch lives in a Cloud Function. The UA comes from the **`EDGAR_USER_AGENT`**
    param (a plain string param in `functions/lib/secrets.mjs`, **not** a secret), format
    `"Name email@example.com"`. The owner sets the real contactable value at deploy:
    add `EDGAR_USER_AGENT="Fundient <you@example.com>"` to `functions/.env` (or answer the
    deploy prompt). The committed fallback (`Fundient/1.0 (contact via app owner)`) keeps
    dev working but SEC may throttle a generic UA, so set a real one before relying on it.
    **Verify in dev**: `firebase emulators:start --only functions` with `EDGAR_USER_AGENT`
    set, then `GET http://localhost:5001/<project>/us-central1/etfHoldings?ticker=VOO` with a
    valid Google bearer token and `sec-fetch-site: same-origin` — or just open the Invest
    tab from `localhost:5173` (vite proxies `/api/*` to the deployed function).
- **Candidate Check dialog** (`CandidateCheckDialog.jsx`): a modal (same pattern
  as `AddActivityDialog` / `ImportCsvDialog`), opened from a new **"Check"** button
  in the InvestTab header action row; because it is *read-only analysis* the button
  shows even in view-only mode (unlike Import / Activity). A secondary entry point is a
  per-row **check** affordance on the equity rows that opens it pre-filled. Type a ticker
  (+ optional hypothetical add amount) →
  1. fetch its holdings (ETF → EDGAR look-through via `investApi.fetchEtfHoldings`,
     cache-first; stock → itself at 100%), reconciled into the user's identity space via
     the CUSIP↔ticker map above;
  2. **overlap** vs the user's combined look-through portfolio (`aggregatePortfolio` +
     `computeOverlap`) — overlap % + top shared names;
  3. **concentration delta** — `concentration(current)` vs `concentration(current +
     candidate)` (effective-N before → after) plus the single-name % (`concentrationAfterBuy`);
     needs the amount, else overlap + current concentration only;
  4. **market factors** (data relay, Finnhub via the `metric` / `recommendation` / `quote`
     kinds): 52-week position, analyst recommendation trend, P/E + beta — facts only. There
     is **no free sector P/E baseline**, so the P/E is shown with a neutral label, never a
     fabricated "vs sector" number;
  5. **"Worth it?" rule-check** — `investInsights.evaluateCandidate`, transparent flags from
     `settings.preBuyThresholds` showing *which checks fired and why* (high overlap >
     `overlapPct`, single-name > `concentrationPct`, diversification narrows (effective-N
     drops), near 52-wk high within `near52wkPct`, analyst trend). Each flag has an icon +
     text (caution = amber, pass = teal — never colour alone); it ends with an explicit
     "you set every threshold; no verdict" line. **Sector cap (`sectorCapPct`) is deferred**:
     a true sector number needs every N-PORT underlying classified by sector, which no free
     Finnhub endpoint gives cheaply, so the flag is not shown (a `// TODO sector-cap` marks
     it); the concentration-delta flag is the robust diversification signal instead.
- **Contribution itemization** (brokerage-only): the flow-through already routes a
  vendor-matched *Investment* expense to an account and, for `type: 'hysa'` (Amex /
  Happen), silently bumps the balance anchor (`investFlowThrough.js:44`). Add the
  missing `else if (type === 'brokerage')` branch: the Fidelity contribution still
  posts as a cash `DEPOSIT`, then queues a **dismissible "itemize" nudge** on the
  Invest tab (badge/card — *not* a forced modal, since brokerage cash can sit in the
  SPAXX sweep for days before a trade). Tapping it opens a pre-filled dialog (amount +
  date, reusing the `AddActivityDialog` BUY form) where the user enters BUY lines
  (ticker · shares · price) with a running remainder vs the deposit; leftover stays as
  cash. The lines become `BUY` activities → holdings/FIFO lots derive automatically, so
  overlap and concentration light up for that money. HYSA vs brokerage is **inferred
  from the resolved account's `type`** — no per-transaction flag. Only requirement: a
  vendor rule mapping Fidelity → the brokerage account (Settings → Investing); an
  unmatched contribution mirrors nothing (current non-fatal behaviour).

- **Rate-watch scheduled function** (`rate-watch.mjs`): Gemini + Google Search
  grounding, 1st & 15th, digest to Telegram + push, writes the `RateWatch` tab.

- **HYSA rate history with effective dates**: HYSA APY is variable — the bank can
  change it any time, and a new rate applies from its **effective date forward**
  (interest accrued at the old rate is unaffected). Phase 1 stores only the current
  `apy` on the Accounts row, overwritten on edit, with no history. Add a new
  **`RateHistory`** tab (`accountId | apy | effectiveDate | source`) appended on
  every rate change (same pattern as `Snapshots` for balance). Projections keep
  using the current APY (good enough — they're estimates), but the history gives an
  auditable "4.40% from 2026-07-08, 4.75% from 2026-10-01" trail for reconciliation
  and a richer rate-watch digest.
  - **Capture is semi-automatic, not silent.** The rate-watch scan already runs on a
    cadence (1st & 15th); when it detects that a held bank's **advertised** APY moved,
    it surfaces a one-tap nudge ("Amex now advertises 3.85%, up from your 3.70% —
    update?") pre-filled with the rate and the effective date it found. The user
    **confirms or corrects** before it writes to `RateHistory` + the account, because
    the advertised new-customer rate is not guaranteed to equal *your* rate (promo
    tiers, grandfathering). It is never auto-applied silently. Manual edit (tap the
    gauge) stays available and also appends to `RateHistory`. Actual credited interest
    still reconciles via dated `INTEREST` activities from the statement.

### Phase 3 — Portfolio Insights card + rebalancing

- **Portfolio Insights card** (always-on, no ticker): a new card appended to the
  bottom of the InvestTab scroll, after `InvestSplitDonut` (holdings → visualization
  → insights). Shows concentration verdict + top
  holdings; rate-optimization (cash in the lower-APY HYSA); ETF-overlap map across
  held funds (reuses the Phase 2 EDGAR cache).
- **Rebalancing suggestion** (ws-rebalancer port): drift vs the user's target
  allocation + the exact buy list to close it; buy-only, with a drift-threshold
  alert.
