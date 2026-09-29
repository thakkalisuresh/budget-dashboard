# Wallet / notification ingestion contract

How a phone automation logs a transaction into the dashboard without opening it.
One endpoint accepts everything — an iOS Shortcut, an iOS 27 notification
automation, an Android SMS/notification reader, or a bank email alert — and the
backend does the parsing, categorization, card matching, duplicate check and
sheet write.

## Endpoint

```
POST https://<your-domain>/api/wallet          (Firebase Hosting rewrite → walletWebhook)
Authorization: Bearer <WALLET_WEBHOOK_SECRET>  (or  X-Api-Key: <secret>)
Content-Type: application/json
```

Auth is a single shared secret (`WALLET_WEBHOOK_SECRET` in Secret Manager). The
same secret is used by every device and every family member; who a charge
belongs to is carried by the `email` field in the body, not by the credential.

## Request body

Send **either** structured fields **or** raw notification text — whatever the
automation can produce. Anything missing from structured fields is filled in
from the parsed text, so the two can be combined.

| Field | Required | Notes |
|-------|----------|-------|
| `email` | yes | Which user this charge belongs to (see *Multiple people* below). Also the heartbeat and duplicate-guard key. |
| `merchant` | one of `merchant` / `text` | Merchant/vendor name. |
| `text` | one of `merchant` / `text` | Raw notification / SMS / email body. The backend LLM parser pulls out merchant, amount, card and date. Preferred for notification & SMS triggers — no fragile on-device regex. |
| `amount` | recommended | Number or string (`"$1,234.56"` is accepted). Parsed from `text` if omitted. Rounded to cents once on arrival, so float noise like `17.579999999999998` becomes `17.58` everywhere (sheet, message, dedup, push). |
| `currency` | optional | 3-letter ISO code (`EUR`, `GBP`, `INR`…) of `amount`. Omit for dollars. A symbol or code inside the `amount` string (`"€16.00"`, `"16.00 EUR"`) is detected the same way. See *Foreign currency*. |
| `card` | optional | Card / payment method. Resolved against the user's card list (falls back to the raw string if nothing matches). Parsed from `text` if omitted. |
| `date` | optional | `YYYY-MM-DD`. **Send the device's local date.** If omitted, the current day in `APP_TZ` (default America/Los_Angeles) is used. This is what files the charge under the right month. |
| `sheetId` | optional | Force a specific month sheet, bypassing the `Months` registry. Normally omit — the month is derived from `date`. A stale hardcoded `sheetId` writes to that sheet even when the `date` belongs to another month (the `message` still names the transaction's month). |
| `source` | optional | Free-text origin tag (trimmed, max 40 chars), e.g. `"ios-shortcut"`, `"ios-notification"`, `"android-sms"`. Does not affect the write; recorded in the heartbeat doc (`lastSource`), logs, error reports and parked-charge blobs. |

Structured fields win over parsed ones: when both are sent, `merchant`, `amount`, `card` and `date` from the body are kept and `text` only fills the gaps.

### Raw-text path and non-purchase skip

When `text` is present it is parsed once (Groq `openai/gpt-oss-120b` first, then Gemini, then Claude) and the result is reused for categorization. The trigger fires on every bank notification, so the parser also classifies it: anything that is not an approved purchase (declined, statement/bill, deposit, payment/autopay, refund, or other such as an OTP) returns `200 { ok: true, skipped: true, reason: 'not_a_purchase', kind }` — nothing is logged and **no error is reported**. If the parser fails entirely, the request falls back to whatever structured fields were sent (`WAL-003`, degraded); with none, it ends as `WAL-001`.

### Responses

Every response body includes a one-line `message` (an emoji-led sentence) meant for the phone automation's banner: it says whether the charge was logged, is waiting on Telegram, or was **not** logged.

| Status / body | `message` starts | Meaning |
|---|---|---|
| `200 { ok, category, vendor, amount }` | ✅ | Logged to the month sheet. If the ±3-day duplicate check matched an existing row it is still logged and the message adds "⚠️ Possible duplicate" (Telegram gets a note). |
| `200 { ok, pendingCategory: true }` | 🤔 | Not logged yet: the category was not settled by a rule or history and Groq was not sure (or said Misc), so Telegram asked for a category (see *Category resolution*). |
| `200 { ok, split: true }` | 🧾 | Split-receipt vendor (Costco, Amazon…, per the user's `splitReceiptVendors`): parked; upload the receipt in Telegram or tap SKIP to log it as one expense. |
| `200 { ok, skipped: true, reason: 'not_a_purchase', kind }` | ℹ️ | Raw text that is not a purchase. Not an error. |
| `200 { ok, skipped: true, reason: 'vendor_disabled' }` | ℹ️ | Vendor matches the user's `disabledWalletVendors`. |
| `200 { ok, skipped: true, reason: 'duplicate_recent' }` | ⏭ | Same email, same exact cents within 2 minutes (see *Duplicate guard*). |
| `400 WAL-001` | ⚠️ | Missing/invalid merchant, amount or email. Reported to the error digest. |
| `401 AUTH-002` | ❌ | Bad or missing secret. |
| `405` | — | Not a POST. |
| `422 SHT-002 month_not_found` | ⚠️ | No month sheet for the resolved month. Create the month in the dashboard first. |
| `502 WAL-008 currency_conversion_failed` | ⚠️ | A non-USD charge whose exchange rate could not be looked up (or whose currency code is unknown). **Not logged**; the primary gets a Telegram note. See *Foreign currency*. |
| `500 WAL-002` | ❌ | The charge parsed but the sheet write failed (the one error worth alerting on — the charge is otherwise lost). |

The `message` copy lives in `functions/lib/_wallet-messages.mjs`.

### Category resolution

Order: the user's smart rules (authoritative, never asked) → the user's own past filings of the same vendor (this month and last month's rows; used without asking when at least 75% of them agree and enough rows back it: two agreeing rows, or three for an always-ask vendor, so one holiday purchase cannot pin a store's category; with fewer rows the charge goes on to Groq and the threshold, a history of `Misc` is ignored because `Misc` is the unknown bucket (pin a genuinely-Misc vendor with a smart rule), and a vendor split across categories is asked about) → Groq (`openai/gpt-oss-120b`, returns a category and a confidence) → the extractor's own `reward_category` as the fallback when Groq is unavailable. A Groq answer is written straight through only when its confidence is at least `CONFIDENCE_THRESHOLD` (0.85: the model answers in steps and 0.9 and up was right about 95% of the time; the confidence rubric in the prompt is generated from the same file, `functions/lib/_categorize.mjs`), the answer is not `Misc`, and the vendor is not on `ALWAYS_ASK_VENDORS` (Costco, Target, Walmart, Amazon, Zelle, Venmo, PayPal, apple.com, Google *: vendors whose right category depends on what was bought). The weekly audit only flags disagreements at 1.0. Agreeing with the extractor does not bypass this (the two are correlated). History rows written by the older pipeline may themselves be wrong; correcting a row in the sheet corrects future charges. Otherwise the charge is **parked** as `category_pending:<chat>:<id>` and a Telegram prompt with a category keyboard goes to the household primary's chat (tapping a category logs it into the charge's original month). Users can turn Groq categorization off with `llmCategorize: false` in their settings; if Telegram is unreachable, or no chat is mapped, the charge is logged with the best guess instead of being dropped. If Groq rejects its model id, `LLM-004` reaches the digest and categorization silently falls back to the extractor (no confirm prompts).

### Primary routing

Every Telegram message from this endpoint (category prompts, split prompts, duplicate notes, warnings) goes to the **household primary's** chat, whoever's card was charged. The primary email comes from the `HOUSEHOLD_PRIMARY_EMAIL` env var if set, otherwise from the Firestore doc `config/household` field `primaryEmail` (cached 5 minutes; no redeploy needed). That email **must have an entry in `TELEGRAM_EMAIL_MAP`**. If no primary is configured, or it has no mapping, prompts fall back to the requesting email's own chat, and if that has none either the charge is logged with the best-guess category.

### Duplicate guard

One tap-to-pay can fire two sources (Wallet notification + issuer app, Samsung Wallet + bank SMS). The key is the requesting email plus the exact cents; the merchant string is only a hint because sources word it differently. The first request claims the key (Firestore `bot_state`, `wdup:` docs); a second inside **2 minutes** is skipped with `duplicate_recent` and the primary gets a Telegram note with a "➕ Log it anyway" button (`DUPLOG`, blob kept 24h). Tapping it logs the skipped charge. A claim that never settled is taken over after 30 seconds, and a failed write releases its claim so a retry can log. The check runs after category resolution and before the park / split / write steps, so a **parked** charge counts too (no second prompt). If the guard itself errors it fails open, the charge is logged and `WAL-005` is reported. This is separate from the ±3-day History check, which never blocks: it logs the charge and adds the ⚠️ note.

### Foreign currency

Apple Wallet shows a transaction in its **native** currency ("€16.00"), and Amex has no app notification for this, so the webhook converts to USD before anything else. The currency comes from an explicit `currency` field, else from the parser (raw `text`, when the amount came from it), else from a symbol or code in a structured `amount` string. Conversion uses `convertToUSD` (`functions/lib/_currency.mjs`, open.er-api.com, 5-minute cache), and the result is rounded to cents once. Every later step (validation, categorization, the duplicate guard, the sheet write, the push) sees the dollar amount, so the duplicate guard keys on the **converted** cents. USD, `$` and a bare number behave exactly as before.

- **A converted amount is an estimate.** The bank's actual rate and foreign-transaction fee differ by a few percent. The Capital One **app** notification is in USD and exact, so it is the preferred source for that card; the two copies of one charge rarely dedupe: the 2-minute guard needs the same exact cents (an estimate usually differs from the bank's figure) and the History check needs a similar merchant name (`Xt Network Sas` vs `REAL-DEBRID*…`). If both automations are live for a card, expect both rows and delete the Wallet estimate; the better fix is to leave that card's Wallet automation off.
- The `message` and the Telegram prompts show the original: `✅ $18.33 at Xt Network Sas (€16.00 converted at 0.873) on Capital One Quicksilver → Misc. …` (the rate is units of the original currency per USD). Response keys and status codes are unchanged; `message` is additive.
- **If the conversion fails** (rate service down, unknown code) the charge is **not logged**: `502 { ok: false, code: 'WAL-008', error: 'currency_conversion_failed', message }` with "⚠️ Couldn't convert €16.00 to dollars — nothing was logged. Add it by hand.", the failure goes to the error digest, and the household primary gets the same note on Telegram. No duplicate-guard claim is taken, so a retry (or the USD app notification) can still log. There is deliberately no stale-rate fallback.

## iOS 27 "notification received" automation (when it ships)

The raw-text path already exists for this. When the OS exposes a
notification-received trigger, the automation only needs to:

1. Trigger on a notification from your bank app.
2. `POST /api/wallet` with:
   ```json
   { "text": "<the notification text>", "email": "you@example.com", "source": "ios-notification" }
   ```
   plus the `Authorization: Bearer <secret>` header.

No app change is needed on this side — point the automation at the endpoint.

## Android SMS (bank transaction texts)

Use Automate (LlamaLab) or any automation app that can make an HTTP request:

1. **Trigger:** SMS or bank/wallet notification received, from the bank's sender / app.
2. **Action:** HTTP POST (`application/json`) to `/api/wallet`:
   ```json
   { "text": "<the SMS / notification text>", "email": "wife@example.com", "source": "android-sms" }
   ```
   Header: `Authorization: Bearer <secret>`.
3. Show the response's `message` as the banner, if the flow supports it.

The backend parses the SMS, auto-detects the vendor's category, resolves the
card and logs it — identical to the wallet path. Bank SMS formats vary by
region/bank; the LLM parser handles them without per-bank rules.

## Multiple people (shared household budget)

All charges land in the **same** month spreadsheet (found through the `Months`
registry tab of `VITE_TEMPLATE_SHEET_ID`) — this is one shared household budget,
not per-person budgets. The `email` field selects that person's *settings*
(a row in the `UserSettings` tab, matched by exact email: smart rules, disabled
vendors, split vendors, custom categories, card list) and keys the duplicate
guard and heartbeat. Telegram prompts always go to the household primary (see
*Primary routing*). An email with no `UserSettings` row still logs, with default
behaviour (no rules, no card resolution, no split vendors).

To add a second person (e.g. a spouse logging via Android SMS):

1. Have them use their own `email` in the POST body.
2. Add their email to `ALLOWED_EMAILS` (Secret Manager) so the dashboard/app
   recognizes them. *(The wallet endpoint itself gates on the shared secret, not
   the email — this step is for dashboard access and per-user settings.)*
3. Optional: add `email:telegram_chat_id` to `TELEGRAM_EMAIL_MAP` (only needed
   for someone who should receive prompts themselves; the household primary must
   be in it).
4. Make sure the current month sheet exists (create it in the dashboard).

Nothing else is required — the same endpoint, secret and pipeline serve everyone.

## Timezone

The month a charge is filed under is resolved in `APP_TZ` (IANA zone, default
`America/Los_Angeles`), or straight from the `date` you send. This is what keeps
a charge made late on the last day of a month from landing in the next month.
See `functions/lib/_time.mjs`.

## Daily nudge and heartbeat (08:00 Pacific, inside `errorDigest`)

The `errorDigest` job (the project's scheduler slots are limited, so no new job) also runs, each step independently and even when there are no errors:

- **Parked-charge nudge.** `category_pending:` charges parked 12h+ are re-sent daily to the chat in their key, with the original category keyboard (a tap logs into the charge's original month). `split_pending:` charges get one message per chat with SKIP; the list order matches what SKIP acts on. At most 8 nudges per run, then a "…and N more" line. After 30 days a blob gets one "giving up" line and no more reminders. Nothing is ever auto-logged or deleted.
- **Heartbeat.** Every authenticated webhook request stamps `wallet_activity/<hash of email>` (`lastSeenAt`, `lastSource`, `count`). A phone silent for 4+ days triggers a Telegram alert to the household primary, repeated every ~3 days until it posts again. Only emails that have posted at least once are tracked.

If the heartbeat write fails it is reported as `WAL-006`; a step of the 08:00 job that throws is reported as `WAL-007` (the other steps still run). To run the job on demand: `gcloud scheduler jobs run firebase-schedule-errorDigest-us-central1 --project=fundient-dashboard --location=us-central1`.

## Error codes

`WAL-001` rejected request · `WAL-002` sheet write failed (charge lost) · `WAL-003` raw-text parse failed · `WAL-004` vendor skipped by rule · `WAL-005` duplicate guard unavailable (fails open) · `WAL-006` heartbeat write failed · `WAL-007` daily-job step failed · `LLM-004` Groq model unavailable. Definitions and fixes: `functions/lib/_error-codes.mjs`.
