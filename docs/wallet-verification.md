# Verifying the wallet webhook against production

There is no staging project: every push to `main` and `develop` deploys functions
and hosting to `fundient-dashboard`, which is production. The old iOS Shortcut and
the Android Automate flow hit the same code. So verification is done with a
**throwaway copy of a month sheet** and a **distinct test email**, never the real
sheets or the two real phone emails.

`scripts/wallet-roundtrip.mjs` does the scripted part; the rest is a manual
checklist below.

## 1. Make the test sheet copy

How the webhook reaches Google (`functions/lib/_drive.mjs`): it is **not** a
service account. It exchanges a stored OAuth **refresh token** for an access
token, so it acts as the Google account that authorized the dashboard. A copy made
in that account's own Drive needs **no sharing at all**. (If the token ever belonged
to a different account, the copy would have to be shared with it as Editor.)

1. Open one **month sheet** (e.g. the current month) in Google Sheets, signed in as the account that owns the dashboard sheets.
   It must be a month sheet (category tabs such as `Grocery`, `Eating Out`, `Misc` plus a `History` tab), not the registry/template sheet.
2. **File → Make a copy**. Name it `WALLET TEST COPY - delete me`. Same Drive account, any folder.
3. **Do not** add the copy to the `Months` registry (the tab in the template sheet that maps `Jul 2026` → sheet id). The script sends `sheetId` explicitly, which bypasses the registry, so the copy never appears in the dashboard.
4. Copy the id from the URL: `https://docs.google.com/spreadsheets/d/<THIS PART>/edit`. That bare token is `TEST_SHEET_ID`.

How the month is chosen in production (for reference): with no `sheetId` in the
request, the webhook reads `Months!A2:B50` of the template sheet and matches the
label (e.g. `Sep 2026`) derived from the transaction date. With a `sheetId`, that
lookup is skipped, and the month written into the row comes from the date, not the sheet.

### Confirm a row landed in the copy and NOT in the original

Run one case first: `node scripts/wallet-roundtrip.mjs --only purchase_structured`.

- **Copy:** open the copy, go to the category tab named in the output (probably `Grocery`): a new last row `Trader Joe's · 32.47`. The `History` tab has a new row too. (History labels wallet writes "WhatsApp Receipt"; that is a known cosmetic quirk.)
- **Original:** open the real month sheet, same tab: the last row is unchanged. Then **File → Version history → See version history**: there is no edit stamped with the time of your run.

Do this before running the whole suite.

## 2. Set up the environment

You type these in your own terminal; nothing here is read from the repo, and the
script never prints the secret (only the last 4 characters of the sheet id).

```bash
read -s WALLET_WEBHOOK_SECRET && export WALLET_WEBHOOK_SECRET
export WALLET_URL='<the URL from your iOS Shortcut, e.g. https://…/api/wallet>'
export TEST_SHEET_ID='<id of the copy>'
export TEST_EMAIL='<you>+wallettest@gmail.com'
export REAL_EMAILS='<primary phone email>,<other phone email>'   # denylist: TEST_EMAIL must not be one
```

Optional, enables the split-vendor and disabled-vendor cases. `SETTINGS_EMAIL` must
be the household primary (the always-on phone), never the other phone (a test post
refreshes that email's heartbeat and would mask a silent phone):

```bash
export PRIMARY_EMAIL='<primary email>' SETTINGS_EMAIL='<primary email>'
export SPLIT_VENDOR='Costco'          # a vendor in that user's splitReceiptVendors (defaults: Costco, Amazon)
export DISABLED_VENDOR='<pattern>'    # a vendor pattern in that user's disabledWalletVendors, if any
```

Why the settings email: user settings (smart rules, split vendors, disabled
vendors, cards, custom categories) are looked up by exact email in the real
template sheet's `UserSettings` tab. The `+alias` has no row, so it can exercise
only default behaviour.

## 3. Run

```bash
node scripts/wallet-roundtrip.mjs --list        # dry: shows every case, sends nothing
node scripts/wallet-roundtrip.mjs --only purchase_structured
node scripts/wallet-roundtrip.mjs               # all cases (asks you to type "yes")
```

Flags: `--only a,b`, `--pause <seconds>` (default 3), `--yes`, `--json`.

Safety rails (all enforced before any request is sent, and unit-tested in
`src/__tests__/walletRoundtrip.test.js`): refuses without the required env; refuses
a `TEST_EMAIL` that is in `REAL_EMAILS`; refuses a pasted sheet URL; refuses a
`SETTINGS_EMAIL` that is not `PRIMARY_EMAIL`; every case carries `sheetId=TEST_SHEET_ID`
except `month_not_found`, which uses `2031-01-15` (no real month) and can only 422;
each case uses different cents so the 2-minute duplicate guard never trips by
accident (only the deliberate `dup_second`).

### Cases and expected results

| Case | Expected |
|---|---|
| `purchase_structured` | 200, written, message ✅ |
| `raw_amex_oddfellows` | 200, amount exactly 17.58; written or parked (Groq confidence) |
| `raw_capone_realdebrid` | 200, amount 23.10, vendor "Real-Debrid"-ish (no `*17886754`) |
| `ugly_float` | 200, `8.229999999999999` returns `8.23` |
| `ambiguous_sq_bloom`, `ambiguous_amzn` | parked, message 🤔, Telegram prompt (WARN if Groq is confident and it writes) |
| `dup_first` / `dup_second` | first written; second `skipped duplicate_recent`, message ⏭, Telegram note with "Log it anyway" |
| `dup_notice_seed` / `dup_notice` | second written with ⚠️ "Possible duplicate", Telegram note |
| `np_declined`, `np_statement`, `np_deposit`, `np_autopay`, `np_refund`, `np_otp` | 200 `skipped not_a_purchase`, **no Telegram, no digest entry** |
| `unreadable_amount` | 400 `WAL-001`, message ⚠️ (lands one WAL-001 in tomorrow's digest: expected) |
| `month_not_found` | 422 `SHT-002` |
| `auth_bad` | 401 |
| `split_vendor` (settings email) | 200 `split`, 🧾, Telegram prompt |
| `disabled_vendor` (settings email) | 200 `skipped vendor_disabled` |

`PASS` = as expected; `WARN` = a valid alternative outcome that depends on the LLM
(e.g. Groq was confident about an "ambiguous" vendor) or a cosmetic issue; `FAIL` =
wrong. Paste the whole output when reporting.

## 4. Manual checklist (needs the real Telegram)

Do all of this in the same sitting as the run, so tomorrow's 12h nudge stays quiet.

1. **Ambiguous prompts (CATFIX).** The primary chat has 🤔 prompts for `SQ *Bloom` and `AMZN Mktp US*2K4`. Tap a category on each. Expect a "Logged … as X" reply and a new row in the **test copy** (the pending blob carries the test `sheetId`), not the real sheet.
2. **Duplicate note (DUPLOG).** Tap "➕ Log it anyway" on the ⏭ note for `Blue Bottle Coffee $12.34`. Expect a row in the test copy. Tapping again does nothing harmful ("already being logged"/"no longer waiting").
3. **±3-day note.** The ⚠️ Possible-duplicate note for `Peet's Coffee` is informational; the row is already in the copy.
4. **Split prompt (only if `SETTINGS_EMAIL` was set).** Tap **SKIP immediately. NEVER upload a receipt for it.**
   The split flow re-resolves the *real* month sheet from the charge's date instead of using the test `sheetId` (`handleSplitSkip` in `functions/lib/_bot-core.mjs`; the parked blob carries no sheetId). The case is dated `2031-01-15` on purpose, so SKIP finds no month, deletes the blob and writes nothing. A `SHT-002` line in tomorrow's digest from that tap is expected.
5. **No alert for non-purchases.** Confirm no Telegram message and, tomorrow, no digest line came from the six `np_*` cases.

### Parked-charge nudge

Leave one ambiguous prompt **untapped**, then either wait for the next 08:00
Pacific run or force it: back-date the blob and run the job.

1. Firestore console → `bot_state` → doc `category_pending:<chatId>:<id>` → map field `v` → `createdAt`: set it to an ISO time about 13 hours ago.
2. Run the job (this is the `errorDigest` function's scheduler job):

```bash
gcloud scheduler jobs run firebase-schedule-errorDigest-us-central1 --project=fundient-dashboard --location=us-central1
```

Expect a "⏰ Still waiting on a category" message with the category keyboard and a
"From <test email>" line. Tap a category: the row goes to the test copy. (If the
job is named differently, list jobs with `gcloud scheduler jobs list --project=fundient-dashboard --location=us-central1`.)

### Heartbeat (`wallet_activity`)

1. After the run, Firestore console → `wallet_activity`: a doc for the test email (and for `SETTINGS_EMAIL` if used) with `lastSeenAt` just now, `lastSource: "roundtrip-test"`, and `count` matching the requests. Doc id is the first 16 hex chars of the SHA-256 of the lowercased email; searching the `email` field is easier.
2. To test the 4-day alert: edit **only the test email's** doc, set `lastSeenAt` to an ISO time 5 days ago (leave `lastAlertedAt` null), then run the scheduler job above. Expect "📵 No wallet activity from <test email> in 5 days" in the primary chat. Run the job again right away: no second alert (repeats only after about 3 days).
3. **Clean up:** delete the test email's `wallet_activity` doc when finished. Otherwise it goes silent and pages you after 4 days. (The `SETTINGS_EMAIL` doc is the real primary's; leave it, it just refreshed.)

### Configuration checks

- Firestore `config/household` exists with field `primaryEmail` (or the `HOUSEHOLD_PRIMARY_EMAIL` env is set on the functions). Without it, prompts go to the requesting email's chat, which for the test email is nobody.
- `TELEGRAM_EMAIL_MAP` contains the primary (`email:chatId`). If not, the prompts fall back and you will see none. That the prompts arrived in the primary chat proves both checks.

## 5. Clean up

- Untapped test prompts: tap them (test sheet) or delete the `category_pending:`, `dup_skipped:`, `split_pending:` docs in `bot_state` whose `v.email` is the test email.
- Delete the test copy spreadsheet and the test `wallet_activity` doc.
- `wdup:` claim docs expire on their own.
