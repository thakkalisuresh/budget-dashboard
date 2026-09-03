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
| `email` | yes | Which user this charge belongs to (see *Multiple people* below). |
| `merchant` | one of `merchant` / `text` | Merchant/vendor name. |
| `text` | one of `merchant` / `text` | Raw notification / SMS / email body. The backend LLM parser pulls out merchant, amount, card and date. Preferred for notification & SMS triggers — no fragile on-device regex. |
| `amount` | recommended | Number or string (`"$1,234.56"` is accepted). Parsed from `text` if omitted. |
| `card` | optional | Card / payment method. Resolved against the user's card list. Parsed from `text` if omitted. |
| `date` | optional | `YYYY-MM-DD`. **Send the device's local date.** If omitted, the current day in `APP_TZ` (default America/Los_Angeles) is used. This is what files the charge under the right month. |
| `sheetId` | optional | Force a specific month sheet. Normally omit — the month is derived from `date`. |
| `source` | optional | Free-text origin tag for diagnostics, e.g. `"ios-shortcut"`, `"ios-notification"`, `"android-sms"`. Does not affect the write; shows up in logs / error reports. |

### Responses

- `200 { ok: true, ... }` — logged (may include `pendingCategory`, `split`, `skipped`, or a duplicate note).
- `400 WAL-001` — missing/invalid merchant, amount or email.
- `401 AUTH-002` — bad or missing secret.
- `422 SHT-002 month_not_found` — no month sheet for the resolved month. Create the month in the dashboard first.
- `500 WAL-002` — the charge parsed but the sheet write failed (the one error worth alerting on — the charge is otherwise lost).

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

Use MacroDroid or Tasker:

1. **Trigger:** SMS received, from the bank's sender/short-code.
2. **Action:** HTTP POST (`application/json`) to `/api/wallet`:
   ```json
   { "text": "{sms_body}", "email": "wife@example.com", "source": "android-sms" }
   ```
   (`{sms_body}` = the app's incoming-SMS-text variable; MacroDroid `[sms_message]`, Tasker `%SMSRB`.)
   Header: `Authorization: Bearer <secret>`.

The backend parses the SMS, auto-detects the vendor's category, resolves the
card and logs it — identical to the wallet path. Bank SMS formats vary by
region/bank; the LLM parser handles them without per-bank rules.

## Multiple people (shared household budget)

All charges land in the **same** month spreadsheet (`VITE_TEMPLATE_SHEET_ID`) —
this is one shared household budget, not per-person budgets. The `email` field
selects that person's *settings* (disabled vendors, custom categories, card
list) and, if mapped, who gets Telegram prompts for ambiguous categories or
receipt splits.

To add a second person (e.g. a spouse logging via Android SMS):

1. Have them use their own `email` in the POST body.
2. Add their email to `ALLOWED_EMAILS` (Secret Manager) so the dashboard/app
   recognizes them. *(The wallet endpoint itself gates on the shared secret, not
   the email — this step is for dashboard access and per-user settings.)*
3. Optional: add `email:telegram_chat_id` to `TELEGRAM_EMAIL_MAP` so category /
   split prompts reach the right person.
4. Make sure the current month sheet exists (create it in the dashboard).

Nothing else is required — the same endpoint, secret and pipeline serve everyone.

## Timezone

The month a charge is filed under is resolved in `APP_TZ` (IANA zone, default
`America/Los_Angeles`), or straight from the `date` you send. This is what keeps
a charge made late on the last day of a month from landing in the next month.
See `functions/lib/_time.mjs`.
