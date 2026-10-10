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
| `MfHoldings` | monthly AMC portfolio lines for the household's Indian funds, one row per holding per fund per `asOf` (server-written; latest + previous month kept). See *Indian MF holdings* below |
| `MfHoldingsStatus` | one row per `fundKey`: what is stored and whether the last attempt succeeded (`ok`/`stale`/`failed`/`missing`) |

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

### MF nudges & planner (`MfNudges.jsx`, pure logic in `investMfNudge.js`)

Self-contained block on the Invest tab (only when an `mf_in` account exists;
SipPlans come from `useInvestData` (passed down as `sipPlans`; no fetch of its own), the live rate once per page load via
`mfNavApi.js` → `/api/mf-nav` `fx`, shown as "unavailable" on failure).

- **Flow-through:** a vendor rule (`wise` / `remitly` → `nro-mf` in Settings →
  Investing; the account dropdown lists every Invest account incl. `nro-mf`, taken
  from the Invest cache via `buildAccountOptions`, with a default list as fallback
  and unknown ids still shown) mirrors the Investment expense as a USD `DEPOSIT`
  (`currency: 'USD'`, `fxToUsd: 1`, no balance bump). `mirrorInvestContribution`
  returns `needsInrReceipt: true` for it.
- **Transfer planner:** target = Σ active SipPlans `amountInr`; suggested send =
  target ÷ live INR-per-USD, shown as a range up to `+ settings.mfBufferPct`
  (default 2%, editable inline). INR already in the account is shown with the USD
  it saves. A low-cash warning fires when `inrCashBalance` < the active-SIP total,
  suppressed until something has been sent (INR_RECEIVED or a USD deposit exists).
- **INR received nudge:** one card per `inTransitDeposits` row. The dialog takes
  INR credited + date, shows implied USD/INR and INR/USD, and warns (never blocks)
  when it is >5% off the live rate (`FX_WARN_PCT`) — a typo guard. Writes
  `INR_RECEIVED` with `fxToUsd = usdSent ÷ inrReceived`, note `settles:<uuid>`.
  Dismissal is permanent (`settings.mfInrDismissed`), with a "Show dismissed →
  Restore" link.
- **SIP confirm cards:** gated on the first `INR_RECEIVED`. For every month from
  that one through today, each active plan without a BUY (symbol = plan id,
  case-insensitive, dated in that YYYY-MM) is pending — so a late Nov
  confirmation survives into Dec. A plan `day` makes a month due only on/after
  that day (clamped to month end). "Skip" hides one plan-month
  (`settings.mfSipSkipped`, keys `planId:YYYY-MM`). The dialog's date defaults to
  today (or the due date when confirming an earlier month), fetches the NAV for
  that date (`history`, auto-retrying 503/502 `retryable` errors, with a manual
  Retry), units default to amount ÷ NAV; NAV and units are overridable. `unmapped`
  plans skip the fetch and require manual NAV + units. The BUY's `fxToUsd` is the
  `inrPool` average computed before the append.

### MF section UI (`MfHoldings.jsx`)

Rendered on the Invest tab after the equities/donut, only when an `mf_in` account
and SipPlans exist. All maths lives in the pure `investMfView.buildMfView`
(tested in `investMfView.test.js`); the component only draws it.

- **Data:** `useInvestData` also fetches `SipPlans` (returned as `sipPlans`, cached
  with the rest; `refresh` refetches it). MF holdings are derived from the
  `mf_in` accounts' activities with `deriveHoldings` (native INR lots), keyed on the
  plan id, so remapping never orphans history. Plans are valued with
  `useMfNav(mappedCodes(plans))`; with no mapped plan there are **no network calls**.
- **Per fund:** units, avg cost, invested, value (units × latest NAV), gain and %,
  XIRR (BUY/FEE out, SELL/DIVIDEND in, plus today's value; hidden under 30 days of
  history); grouped by AMC with a subtotal; a total row and the NRO INR cash line.
  A fund with units but no NAV (unmapped plan, or NAV not yet loaded) is carried at
  cost with a **COST BASIS** badge; unmapped plans also get **NEEDS MAPPING** and a
  banner at the top of the section. Total XIRR and gain are withheld while any fund
  is at cost.
- **INR/USD toggle** (`settings.mfDisplayCurrency`, default `INR`, read-only users
  toggle locally without saving). USD view: invested = `mfUsdCostBasis` (each BUY at
  its stored `fxToUsd`), value = INR value ÷ live INR-per-USD rate, XIRR flows via
  `activityUsd`. The footnote states the basis and rate; the gain is split into
  "fund returns" and "INR/USD move" (`fxGain` = INR cost × live rate − USD cost).
  No live rate ⇒ USD values show `—`, never a guess.
- **Scheme picker** (`MfSchemePicker.jsx`): debounced `/api/mf-nav` search seeded per
  plan (never a preselected result), "loading, retrying" on `503 retryable`, shows
  name / AMC / Direct-Regular / Growth-IDCW / NAV, warns when results hold several
  sub-plans (SBI Retirement Benefit). Saves via `updateSipPlan` (schemeCode, and
  the name when "Also rename" is ticked); a re-map shows a confirm step because
  units and cost stay put and only the NAV source changes. No scheme codes are
  hardcoded.
- **Mock mode** (`VITE_DEV_MOCK=true`): `mockData.js` carries an `nro-mf` account,
  four plans (two mapped, two unmapped), three months of SIPs, NAVs, an FX rate and
  canned search results; nothing hits `/api/mf-nav` or the sheet.

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

## Indian mutual fund NAVs ($0, no keys)

`/api/mf-nav` (`functions/mf-nav.mjs`, data layer `functions/lib/_mf-nav.mjs`) serves
NAVs for Indian mutual funds. Same auth stack as `/api/quotes`. Sources:

- **Latest NAV + search:** AMFI's official `https://portal.amfiindia.com/spages/NAVAll.txt`
  (~1.5 MB, ~14k schemes, redirected from `www.amfiindia.com/spages/NAVAll.txt`).
  Parsed once per instance and cached 6h (`maxInstances: 2`, 512 MiB, 60s timeout).
  The in-flight download is shared; while the *first* one is running the endpoint
  answers `503 {retryable:true}`. If a later refresh fails, the previous parse is
  served with `stale: true`. Parser handles per-category/AMC header lines, blanks,
  `N.A.` NAVs (→ `null`), blank Plan/Option columns (inferred from the name) and
  the option text variants (`GROWTH`, `Growth Option`, `IDCW Payout`, …).
- **Historical NAV:** mfapi.in (`/mf/{code}?startDate&endDate`, free, unofficial).
  If it is down, AMFI's `DownloadNAVHistoryReport_Po.aspx` report (all schemes, so
  only used for windows ≤ 7 days). Both down → `502 {retryable:true}`.
- **FX:** `open.er-api.com` via `getRate('INR')` in `functions/lib/_currency.mjs`
  (latest only, no historical rate).

`POST /api/mf-nav` with `{ action, ... }`, dates are ISO `YYYY-MM-DD`:

| action | request | response |
|---|---|---|
| `latest` | `codes: ["147919", …]` (≤20, numeric), `includeFx?: true` | `{ data: { "147919": { schemeCode, name, amc, plan, option, nav, date } \| null }, stale, fx? }` |
| `search` | `q` (≤60 chars) | `{ results: [{ code, name, amc, plan, option, nav, date }] (≤50), stale }` |
| `history` (one date) | `code`, `date` | `{ schemeCode, date, resolvedDate, fellBack, nav, source }` |
| `history` (range) | `code`, `from`, `to` (≤366 days) | `{ schemeCode, from, to, series: [{ date, nav }], source }` |
| `fx` | — | `{ fx: { currency: "INR", rate, updatedAt } }` (INR per 1 USD) |

`plan` is `direct`/`regular`/`null`; `option` is `growth`/`idcw`/`other`. Search
covers open-ended schemes with an inferable plan (others only on an exact name or
code match) and lists Direct Growth first. `history` returns the NAV for exactly
`date`, or the previous available one with `resolvedDate` and `fellBack: true`
(weekends/holidays); `nav: null` if nothing exists in the 10 days before. The server
applies **no** allotment-day offset — callers decide, and the UI lets the user
override NAV/units because the real allotment NAV can differ.

The client hook `useMfNav(codes, accessToken)` (`src/useMfNav.js`) fetches `latest`
with `includeFx` on mount and then every 6h, only while the Invest tab is mounted
and the app is visible. It ignores empty / `"unmapped"` codes and returns
`{ navs, fx, stale, lastUpdated, refresh }`; the last response is cached per device
in `localStorage` (`fundient.mfNav.v1`) — a convenience, not a source of truth.

## Indian MF holdings (monthly, $0, no keys)

Phase 2 "portfolio health" needs what each held fund actually owns. AMCs publish a
monthly portfolio statement (SEBI template); `functions/mf-holdings.mjs` ingests it
for the household's funds into two Invest-sheet tabs. Pure logic and the contract live in
`functions/lib/_mf-holdings.mjs`; the per-AMC fetch + parse in
`functions/lib/mf-holdings/{absl,sbi,iti}.mjs`; the shared sheet parser in
`mf-holdings/_sheet.mjs`.

**Funds (`fundKey`, one per *scheme*, not per Direct/Regular plan — the portfolio is identical):**
`absl-flexi-cap`, `absl-conglomerate`, `iti-small-cap`, and all four SBI Retirement
Benefit Fund sub-plans (`sbi-retirement-aggressive-hybrid`, `-aggressive`,
`-conservative-hybrid`, `-conservative`; which one is held is not pinned down, so none
is privileged). `FUND_KEYS` / `FUND_REGISTRY` are exported from `_mf-holdings.mjs`.

**`MfHoldings`** — `asOf | fundKey | isin | name | industry | assetClass | weightPct | marketValueInrLakh | sourceFile`

- `asOf` is the file's own portfolio date (`YYYY-MM-DD`, always a month-end).
- `weightPct` is **percent of NAV, 0-100**, normalised at parse time (ABSL/ITI publish
  fractions, SBI percent; the unit is read from the sheet's own GRAND TOTAL row, with the
  AMC's usual unit only as a fallback).
- `assetClass` ∈ `equity | debt | cash | derivative | other`, taken from the sheet's
  section headings (equity / debt & money-market / TREPS & net receivables / mutual-fund
  units, ETFs, gold, InvIT/REIT → `other`). `industry` is the industry for equity and the
  **credit rating for debt rows**. Cash lines may be negative (net payables). `derivative`
  rows (ITI stock futures, SBI interest-rate-swap notionals) are notional exposure shown
  after the GRAND TOTAL, signed by Long/Short, with no ISIN, and are **excluded from the
  weight sum and should be ignored by overlap/allocation maths**.
- Duplicate ISINs within a scheme are aggregated (weights and values summed, names joined).
  `marketValueInrLakh` is blank when unavailable. Sub-total / total rows and zero or
  "NIL" lines are dropped. All writes are `RAW`, so AMC text is never evaluated as a formula.
- The **latest and previous** `asOf` per `fundKey` are kept; re-running the same `asOf`
  replaces that fund's rows for it (idempotent); a backfill never evicts the latest month.

**`MfHoldingsStatus`** — `fundKey | asOf | status | checkedAt | rowCount | weightSum | reason | sourceFile`.
`asOf` is the asOf of the rows **currently stored** for the fund. `status`:
`ok` (stored rows are for the target month and passed the checks), `stale` (the AMC still
serves last month's file), `missing` (not published yet / ITI link not supplied) or
`failed` (see `reason`). On `stale`/`missing`/`failed` the previous rows stay untouched, so
the UI can always show "holdings as of <asOf>" plus a banner.

**Checks** (a fund that fails keeps its previous rows and records the reason): the sheet's
portfolio date equals the target month-end exactly; at least one row; weights over all
non-derivative rows sum to **90-102**; no negative weight outside cash/derivative rows;
at most 5% of weight unclassified. The sheet is located by its code **and** the scheme-name
text in its first rows; a mismatch fails that fund with a clear reason — another sheet is
never picked silently.

**Job.** `mfHoldingsRefresh` runs at 02:00 IST on days 8-12 each month and targets the
previous month-end. Per fund house: skipped if all its funds already have rows for the
target month, otherwise fetched, parsed, checked and merged; each house runs in its own
try/catch, so one failing never blocks the others. Failures (not "not published yet") are
logged through `reportError('INV-001', …, { stage: 'mf-holdings' })` — no new error code,
no Telegram/push. Written in one pass at the end of the run (holdings, then status).

| AMC | Fetch | Notes |
|---|---|---|
| ABSL | `GET` the JSON listing `…/FactsheetAccordionById?id=3ccab227-…&month=&year=0` (the `month`/`year` params are required), pick the item "Monthly Portfolios as on <date>" for the target, `GET` its ~2 MB zip (host allowlist: `abcscprod.azureedge.net`, `mutualfund.adityabirlacapital.com`), unzip the single legacy `.xls` in memory | File names change nearly monthly, so the link comes only from the listing. The accordion id is a constant; if that listing fails or has no monthly items, the job reads the portfolio page's `data-accordian-api` links and tries up to 4 other accordions (an unpublished month never triggers this). Zip guarded: ≤ 3 entries, ≤ 40 MB uncompressed. |
| SBI | `GET` `www.sbimf.com/docs/default-source/scheme-portfolios/all-schemes-monthly-portfolio---as-on-<D><st/nd/rd/th>-<month>-<year>.xlsx`; 404 = not out yet | Sheets `SRBF-AHP`, `-AP`, `-CHP`, `-CP`. |
| ITI | **Semi-manual.** The AMC's listing API is client-side-encrypted (`{"eData": ciphertext}`; we deliberately do not reverse it) and the file name contains the upload epoch, so it cannot be discovered | The owner pastes the link via `POST /api/mf-holdings {action:'ingest', house:'iti', url}` (see below). Until then the scheduled job records ITI as `missing` with reason "awaiting manual link". |

All requests: honest identifying `User-Agent`, ≤ 1 request/second per host, 45 s timeout,
bounded response size (streamed, aborted at the cap), https + host allowlist (also after
redirects).

**On-demand endpoint** `POST /api/mf-holdings` (same auth stack as `/api/mf-nav`: allowlisted
origin, `sec-fetch-site`, Google bearer + `ALLOWED_EMAILS`; **read-only viewers (`VIEWER_EMAILS`) get `403 {ok:false, error:'Read-only users cannot load holdings'}` on `refresh`/`ingest` and may only call `status`**, because those write to the household sheet with the server's credentials; 300 s / 1 GiB; one refresh at a
time → `409 {retryable:true}`):

| action | request | response |
|---|---|---|
| `status` | — | `{ target, status: [MfHoldingsStatus rows] }` |
| `refresh` | optional `asOf` (a month-end ≤ the latest one, ≤ 3 months back — backfill), `houses` (subset of `absl`, `sbi`, `iti`), `force` (re-ingest a stored month), `itiUrl` (same rules as `ingest`'s `url`) | `{ target, houses: { absl: { status, funds, details }, … }, wrote, status }` |
| `ingest` | `house: 'iti'`, `url: 'https://itiamc.com/admin/pdf/<epoch>-ITIMF_Monthly_Portfolio_<DDMMYYYY>.xlsx'` | `{ ok, fundKey, asOf, status, rowCount, weightSum, reason }` (`status` as in `MfHoldingsStatus`) |

House `status` is `done | skipped | partial | missing | failed`. **`ingest` (ITI's manual path)**:
the link is validated before any request — https only, host exactly `itiamc.com` or
`www.itiamc.com`, no credentials/query/fragment, path exactly
`/admin/pdf/<digits>-ITIMF_Monthly_Portfolio_<DDMMYYYY>.xlsx`, and the filename date must be a
month-end within the last 3 months (so August can be backfilled). Then: no redirects followed,
≤ 6 MB, must start with the zip/`.xlsx` signature, and the sheet's own portfolio date must equal the
filename date (else `status: 'stale'`, nothing written). It then takes the same
parse → check → replace path as the job (re-pasting a link replaces that month, idempotent).
Invalid input → `400`; a bad/old link (404, HTML page, wrong date, failed check) → `200 { ok: false, status, reason }`.
Hosting forwards `/api/*` to the function with a 60 s limit, so a refresh should be limited with
`houses` if the AMCs are slow.

**Dependencies.** `xlsx` is SheetJS **0.20.3 installed from the official tarball**
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, Apache-2.0), because the npm
registry copy (0.18.5) carries two unfixed high advisories (prototype pollution
GHSA-4r6h-8v6p-xvw6, ReDoS GHSA-5pgg-2g8v-p4x9) and ABSL's legacy `.xls` (BIFF) needs SheetJS.
The lockfiles record the tarball's SHA-512 integrity, so `npm ci` is reproducible and a changed
tarball fails the install. Cost: `functions/` (and the root, for tests — same pattern as
`fast-xml-parser`) fetches the tarball from `cdn.sheetjs.com` at install time, so a CDN outage
at deploy time would fail that install; the CI deploy job has no other config to change.
Dependabot cannot see a non-registry tarball: bump it by hand when SheetJS publishes
a newer version (check `cdn.sheetjs.com` and the advisories). `fflate` 0.8.3 (MIT) unzips ABSL's
download. Parsing ABSL's 8 MB, 105-sheet `.xls` takes ~160 ms and ~120 MB of RSS, hence 1 GiB.

**Secrets.** No new secret or param: the functions bind `SHEETS_DRIVE_SECRETS` (which includes
`ALLOWED_EMAILS`), the HTTP function also the existing `VIEWER_EMAILS` (read via `.value()`), and the User-Agent is a constant, so non-interactive deploys are unaffected
(`functionSecrets.test.js` covers both entry points).

**Fixtures / tests.** `src/__tests__/fixtures/mf-holdings/{absl.xls,sbi.xlsx,iti.xlsx}` are the
real 30-Sep-2026 disclosures cut down to the held schemes' sheets (the ABSL file is a genuine
BIFF8 `.xls`); regenerate with `node scripts/build-mf-holdings-fixtures.mjs <absl.xls> <sbi.xlsx> <iti.xlsx>`.
Tests mock `fetch`; none touch the network.

**Failure modes (all tested).** ABSL: listing 500 (the `month=&year=0` params missing, or the Sitecore
accordion id changed → fallback above), listing not JSON / no `AccordionList`, month not listed yet
(`missing`), link on an unexpected host or not a `.zip`, zip with > 3 entries / oversized / no spreadsheet /
corrupt, sheet code renamed or title mismatch (that fund fails; Index is not trusted for another
sheet). SBI: 404 = not published yet (`missing`); wrong day suffix would also 404; sheet missing or
title of another sub-plan → that sub-plan fails alone. ITI: link not supplied (`missing`), bad link,
redirect, HTML instead of xlsx, wrong filename date, sheet renamed. Everywhere: truncated downloads
(fewer bytes than `Content-Length`, or an unreadable workbook), duplicate ISINs (aggregated), `NIL`/blank/
`$0.00%` weights, fraction↔percent mix-ups (unit read from the GRAND TOTAL; a sum far outside 90-102
still fails the fund), and a stale file (the AMC still serves last month's → `stale`).

**Not built.** A generic file-upload fallback (`ingest { house, fileName, contentBase64 }`, ≤ ~12 MB checked
before decoding, feeding the same parse → check → merge → write path) — ITI's pasted-link `ingest` covers
the one house that needs a manual step.

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
    a free key lifts both) — a plain `process.env` read (set in `functions/.env` to use one), deliberately
    not a `defineString` param: the CLI aborts non-interactive deploys on a param with no `.env` value.
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

## First-load behaviour

- `useInvestData` reads sequentially (Accounts → Activities → RateWatch → SipPlans);
  `ensureRateHistoryTab` + `ensureInvestMf` run first, once per sheet per session,
  and are skipped for a sheet this hook just created (`createInvestSheet` already
  writes every tab, column and seed row).
- `sheetInvest.js` wraps its Sheets calls in `withRetry429` (waits 1s/3s/9s on a
  429, then rethrows SHT-001). `sheetApi.js` is unchanged, so other tabs don't retry.
- Mock mode (`VITE_DEV_MOCK=true`) includes an in-transit USD deposit to `nro-mf`
  (no INR_RECEIVED yet) and uses `MOCK_MF_NAV.fx.rate`, so the INR-received nudge,
  transfer planner and pending SIP cards render locally.
