# Error codes

> **Generated file — do not edit by hand.**
> Source of truth: `functions/lib/_error-codes.mjs`. Regenerate with `npm run errdoc`.

67 codes across 14 domains.

Codes appear wherever the failure surfaces: in the bot's reply, on the
dashboard crash screen, in the wallet webhook response body, in Cloud Logging,
and in the daily Telegram digest.

**You can also just ask the bot.** Send it a code — `SHT-009`, or
"what does SHT-009 mean" — and it replies with the entry below.

## Severity

- 🔴 fatal — the action did not happen; the user must retry
- 🟡 degraded — the action happened but something was lost or skipped
- ⚙️ config — nothing will work until a setting or secret is changed

## Index

| Code | Severity | What it means |
|---|---|---|
| [`CFG-001`](#cfg-001) | config | VITE_TEMPLATE_SHEET_ID not configured |
| [`CFG-002`](#cfg-002) | config | Google Drive credentials missing |
| [`CFG-003`](#cfg-003) | config | GEMINI_API_KEY not configured |
| [`CFG-004`](#cfg-004) | config | ANTHROPIC_API_KEY not configured |
| [`CFG-005`](#cfg-005) | config | GROQ_API_KEY not configured |
| [`CFG-006`](#cfg-006) | config | Telegram bot not configured |
| [`CFG-007`](#cfg-007) | degraded | No Telegram chat mapping for this user |
| [`CFG-008`](#cfg-008) | config | ALLOWED_EMAILS not configured |
| [`CFG-009`](#cfg-009) | config | WALLET_WEBHOOK_SECRET not configured |
| [`AUTH-001`](#auth-001) | config | Google token refresh failed — token revoked or expired |
| [`AUTH-002`](#auth-002) | fatal | Wallet webhook rejected an unauthorized request |
| [`AUTH-003`](#auth-003) | fatal | Telegram webhook signature rejected |
| [`AUTH-004`](#auth-004) | fatal | Telegram user not on the allow list |
| [`AUTH-005`](#auth-005) | fatal | Sheets access denied |
| [`SHT-001`](#sht-001) | fatal | Sheets API returned an error |
| [`SHT-002`](#sht-002) | fatal | No sheet found for month |
| [`SHT-003`](#sht-003) | fatal | Unknown category |
| [`SHT-004`](#sht-004) | fatal | Row with UUID not found |
| [`SHT-005`](#sht-005) | fatal | Sheet tab not found |
| [`SHT-006`](#sht-006) | fatal | Salary row not found in Totals |
| [`SHT-007`](#sht-007) | fatal | Totals sheet is full |
| [`SHT-008`](#sht-008) | fatal | Category already exists |
| [`SHT-009`](#sht-009) | fatal | Expense write failed |
| [`SHT-010`](#sht-010) | degraded | History append failed |
| [`DRV-001`](#drv-001) | degraded | Drive API error |
| [`DRV-002`](#drv-002) | degraded | Receipt upload failed |
| [`DRV-003`](#drv-003) | degraded | Receipt file move failed |
| [`EXTR-001`](#extr-001) | fatal | Vision model API error |
| [`EXTR-002`](#extr-002) | fatal | Model returned no usable JSON |
| [`EXTR-003`](#extr-003) | fatal | Extraction produced no transactions |
| [`EXTR-004`](#extr-004) | degraded | Implausible purchase year corrected |
| [`EXTR-005`](#extr-005) | fatal | All extraction models exhausted |
| [`LLM-001`](#llm-001) | degraded | Groq API error |
| [`LLM-002`](#llm-002) | fatal | Agent API error |
| [`LLM-003`](#llm-003) | degraded | Category suggestion unusable |
| [`PUSH-001`](#push-001) | degraded | Push subscription change failed |
| [`PUSH-002`](#push-002) | degraded | Push notification send failed |
| [`MCP-001`](#mcp-001) | fatal | MCP tool call failed |
| [`TG-001`](#tg-001) | degraded | Telegram sendMessage failed |
| [`TG-002`](#tg-002) | fatal | Telegram file download failed |
| [`BOT-001`](#bot-001) | fatal | Receipt could not be logged |
| [`BOT-002`](#bot-002) | fatal | Undo failed |
| [`BOT-003`](#bot-003) | fatal | Delete failed |
| [`BOT-004`](#bot-004) | fatal | Entry has no tracking id |
| [`BOT-005`](#bot-005) | fatal | Split could not be logged |
| [`BOT-006`](#bot-006) | fatal | Daily receipt limit reached |
| [`BOT-007`](#bot-007) | fatal | Parked charge could not be logged |
| [`BOT-008`](#bot-008) | fatal | Category move left a duplicate |
| [`WAL-001`](#wal-001) | fatal | Wallet request rejected as invalid |
| [`WAL-002`](#wal-002) | fatal | Wallet transaction write failed |
| [`WAL-003`](#wal-003) | degraded | Wallet text parse failed |
| [`WAL-004`](#wal-004) | degraded | Vendor skipped by user rule |
| [`FX-001`](#fx-001) | degraded | Currency conversion failed |
| [`FX-002`](#fx-002) | degraded | Unknown currency |
| [`WEB-001`](#web-001) | fatal | Dashboard render crashed |
| [`WEB-002`](#web-002) | degraded | Unhandled promise rejection in the dashboard |
| [`WEB-003`](#web-003) | degraded | Offline — write refused |
| [`WEB-004`](#web-004) | fatal | Receipt file rejected |
| [`WHS-001`](#whs-001) | degraded | Warehouse write failed — queued for retry |
| [`WHS-002`](#whs-002) | degraded | Warehouse outbox write failed |
| [`WHS-003`](#whs-003) | degraded | Warehouse event rejected as malformed |
| [`WHS-004`](#whs-004) | degraded | Warehouse outbox entry dead-lettered |
| [`WHS-005`](#whs-005) | degraded | Warehouse reconciliation aborted on a partial read |
| [`WHS-006`](#whs-006) | degraded | Warehouse backfill gate failed |
| [`WHS-007`](#whs-007) | config | Warehouse dataset has an expiration policy set |
| [`WHS-008`](#whs-008) | degraded | Warehouse notify rejected an unknown spreadsheet |
| [`WHS-009`](#whs-009) | degraded | Warehouse skipped a tab whose header does not match the contract |

## CFG — Configuration & secrets

### CFG-001

**VITE_TEMPLATE_SHEET_ID not configured** · `config`

**Why it happens.** The functions runtime has no template spreadsheet id, so no month sheet can ever be resolved.

**What to do.** Set VITE_TEMPLATE_SHEET_ID in the Firebase functions config and redeploy. Everything sheet-related stays broken until this exists.

### CFG-002

**Google Drive credentials missing** · `config`

**Why it happens.** One of GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN is unset.

**What to do.** Set all three as Firebase secrets. Note the OAuth client lives in the "Budget Tracker" GCP project, not fundient-dashboard.

### CFG-003

**GEMINI_API_KEY not configured** · `config`

**Why it happens.** Receipt extraction has no primary vision model available.

**What to do.** Set GEMINI_API_KEY. Extraction falls back to Claude, so receipts may still work but slower and at cost.

### CFG-004

**ANTHROPIC_API_KEY not configured** · `config`

**Why it happens.** The Claude fallback for extraction and the conversational agent are unavailable.

**What to do.** Set ANTHROPIC_API_KEY. If GEMINI_API_KEY is also missing, receipt scanning cannot work at all.

### CFG-005

**GROQ_API_KEY not configured** · `config`

**Why it happens.** Natural-language queries and LLM category correction fall back or no-op.

**What to do.** Set GROQ_API_KEY. Not fatal: categorization degrades to the extractor and queries fall back to Claude.

### CFG-006

**Telegram bot not configured** · `config`

**Why it happens.** TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET is unset, so the bot cannot receive or reply.

**What to do.** Set both, then re-register the webhook with Telegram so the secret token matches.

### CFG-007

**No Telegram chat mapping for this user** · `degraded`

**Why it happens.** TELEGRAM_EMAIL_MAP has no entry for the email, so nothing can be sent to them.

**What to do.** Add "email:chatId" to TELEGRAM_EMAIL_MAP. Affects wallet confirmations, duplicate warnings, and all digests.

### CFG-008

**ALLOWED_EMAILS not configured** · `config`

**Why it happens.** Scheduled jobs have no user to act for and skip entirely.

**What to do.** Set ALLOWED_EMAILS. The first entry is treated as the primary household account.

### CFG-009

**WALLET_WEBHOOK_SECRET not configured** · `config`

**Why it happens.** The wallet webhook rejects every request because it has nothing to compare the key against.

**What to do.** Set WALLET_WEBHOOK_SECRET and use the same value in the phone automation.

## AUTH — Authentication & access

### AUTH-001

**Google token refresh failed — token revoked or expired** · `config`

**Why it happens.** The Drive/Sheets refresh token is no longer valid. Most often the OAuth consent screen is in Testing mode, which expires refresh tokens after 7 days.

**What to do.** Regenerate GOOGLE_DRIVE_REFRESH_TOKEN and publish the OAuth consent screen to Production so it stops expiring.

### AUTH-002

**Wallet webhook rejected an unauthorized request** · `fatal`

**Why it happens.** Missing or wrong API key on the wallet webhook.

**What to do.** Expected if someone is probing the endpoint. If it is your own phone, the key in the automation no longer matches WALLET_WEBHOOK_SECRET.

### AUTH-003

**Telegram webhook signature rejected** · `fatal`

**Why it happens.** The request did not carry the expected secret token header.

**What to do.** Expected for random internet traffic. If your own bot stopped working, re-register the webhook so its secret matches TELEGRAM_WEBHOOK_SECRET.

### AUTH-004

**Telegram user not on the allow list** · `fatal`

**Why it happens.** A Telegram account not in TELEGRAM_ALLOWED_USERS messaged the bot.

**What to do.** Expected for strangers. Add the numeric user id to TELEGRAM_ALLOWED_USERS if it should be you.

### AUTH-005

**Sheets access denied** · `fatal`

**Why it happens.** The credentials are valid but not permitted on that spreadsheet.

**What to do.** Share the sheet with the service account / OAuth user, or check ALLOWED_EMAILS.

## SHT — Google Sheets

### SHT-001

**Sheets API returned an error** · `fatal`

**Why it happens.** Generic non-2xx from the Sheets API. Status is in the message: 429 is rate limiting, 5xx is Google-side.

**What to do.** Retry. If 429 repeats, something is polling too aggressively. If 403, see AUTH-005.

### SHT-002

**No sheet found for month** · `fatal`

**Why it happens.** The Months tab has no row for the month a transaction belongs to. Common on the 1st, and for back-dated transactions.

**What to do.** Create the month in the dashboard, or via the bot. The wallet webhook returns 422 month_not_found for this.

### SHT-003

**Unknown category** · `fatal`

**Why it happens.** A category name was used that has no tab in the sheet map — usually a custom category that was renamed or deleted.

**What to do.** Check the category exists in Totals and in the sheet map. Re-add it, or correct the transaction.

### SHT-004

**Row with UUID not found** · `fatal`

**Why it happens.** A delete or edit targeted a transaction that is no longer where it was — already deleted, or moved between tabs.

**What to do.** Usually benign: the row is already gone. If it persists, the UUID column may be in an unexpected position for that tab.

### SHT-005

**Sheet tab not found** · `fatal`

**Why it happens.** A tab named in the sheet map does not exist in this month, typically an older sheet created before a category was added.

**What to do.** Add the missing tab to that month, or recreate the month from the current template.

### SHT-006

**Salary row not found in Totals** · `fatal`

**Why it happens.** The Totals tab does not have the expected salary row.

**What to do.** The sheet was edited by hand or created from an old template. Restore the Totals layout.

### SHT-007

**Totals sheet is full** · `fatal`

**Why it happens.** All 20 category rows (2–21) are used, so no new category can be added.

**What to do.** Delete an unused category first.

### SHT-008

**Category already exists** · `fatal`

**Why it happens.** Tried to create a category whose name is already taken.

**What to do.** Expected user error. Pick a different name.

### SHT-009

**Expense write failed** · `fatal`

**Why it happens.** appendExpense could not write the row. The transaction was NOT recorded.

**What to do.** Retry from the dashboard. Check SHT-001/SHT-002 in the same window for the underlying cause.

### SHT-010

**History append failed** · `degraded`

**Why it happens.** The expense was written but the History log entry was not. Deliberately non-fatal.

**What to do.** The money is correct; History and anything reading it (Split, Duplicates) will be missing that row.

## DRV — Google Drive

### DRV-001

**Drive API error** · `degraded`

**Why it happens.** Non-2xx from Drive while creating a folder or reading metadata.

**What to do.** The expense still logs; only the receipt image is affected. Check AUTH-001 for an expired token.

### DRV-002

**Receipt upload failed** · `degraded`

**Why it happens.** The receipt image could not be stored. The expense itself is unaffected.

**What to do.** Re-attach the receipt from the bot with ATTACH if you want the image kept.

### DRV-003

**Receipt file move failed** · `degraded`

**Why it happens.** The image uploaded but could not be filed into its category folder.

**What to do.** The file exists in Drive, just in the wrong folder. Cosmetic.

## EXTR — Receipt & text extraction

### EXTR-001

**Vision model API error** · `fatal`

**Why it happens.** Gemini or Claude returned a non-2xx while reading a receipt. 429 means rate limited.

**What to do.** Retry. The chain falls back gemini-flash → gemini-pro → Claude, so seeing this repeatedly means several providers failed.

### EXTR-002

**Model returned no usable JSON** · `fatal`

**Why it happens.** The response could not be parsed into a transaction, usually a blurry or non-receipt image.

**What to do.** Retake the photo. The bot falls back to asking for the details by text.

### EXTR-003

**Extraction produced no transactions** · `fatal`

**Why it happens.** The model parsed the image but found nothing that looks like a purchase.

**What to do.** Expected for non-receipts. If it is a real receipt, retake it with the total visible.

### EXTR-004

**Implausible purchase year corrected** · `degraded`

**Why it happens.** The model returned a date far in the past or future — typically an Amex statement showing MM/DD with no year.

**What to do.** Informational. repairPurchaseYear already remapped it. Frequent hits mean the date prompt is not landing.

### EXTR-005

**All extraction models exhausted** · `fatal`

**Why it happens.** Every model in the fallback chain failed — gemini-flash, then gemini-pro, then Claude. The receipt was not read at all.

**What to do.** Almost always a key or quota problem across providers at once, or a total outage. Check CFG-003 and CFG-004, then provider status.

## LLM — AI (Groq, agent, categorization)

### LLM-001

**Groq API error** · `degraded`

**Why it happens.** Non-2xx from Groq during a query or category check.

**What to do.** Queries fall back to Claude; categorization falls back to the extractor. No data is lost.

### LLM-002

**Agent API error** · `fatal`

**Why it happens.** The conversational agent could not reach Claude.

**What to do.** The bot cannot answer free-form questions until this clears. Structured commands still work.

### LLM-003

**Category suggestion unusable** · `degraded`

**Why it happens.** The model returned a category that is not one of the sheet tabs, so it was discarded.

**What to do.** Informational. Repeated hits mean the category list sent in the prompt is out of sync with the sheet.

## PUSH — Web push notifications

### PUSH-001

**Push subscription change failed** · `degraded`

**Why it happens.** A browser could not register or remove its push subscription.

**What to do.** The dashboard still works; only background alerts are affected. Re-enable notifications in Settings.

### PUSH-002

**Push notification send failed** · `degraded`

**Why it happens.** A notification could not be delivered, usually an expired browser subscription.

**What to do.** Expected after a browser clears site data. The subscription is pruned automatically; re-enable in Settings.

## MCP — MCP server

### MCP-001

**MCP tool call failed** · `fatal`

**Why it happens.** A tool invoked through the MCP server threw.

**What to do.** Affects external assistants talking to the budget, not the dashboard or bot. The tool name is in the message.

## TG — Telegram transport

### TG-001

**Telegram sendMessage failed** · `degraded`

**Why it happens.** The reply could not be delivered. The underlying action usually already happened.

**What to do.** Check the bot token and that the chat still exists. The expense is likely logged despite the silence.

### TG-002

**Telegram file download failed** · `fatal`

**Why it happens.** The receipt photo could not be fetched from Telegram.

**What to do.** Ask the user to resend the photo. Files expire on Telegram after a while.

## BOT — Bot conversation flows

### BOT-001

**Receipt could not be logged** · `fatal`

**Why it happens.** The confirm step failed to write the expense to the sheet.

**What to do.** See the SHT-* code logged alongside. The receipt stays pending, so confirming again may work.

### BOT-002

**Undo failed** · `fatal`

**Why it happens.** The entry to undo could not be found or removed — often already edited or deleted.

**What to do.** Remove it from the dashboard instead.

### BOT-003

**Delete failed** · `fatal`

**Why it happens.** The delete passed its three confirmations but the sheet write failed.

**What to do.** See SHT-004 if the row had already moved. Retry, or delete from the dashboard.

### BOT-004

**Entry has no tracking id** · `fatal`

**Why it happens.** A pre-UUID legacy row cannot be targeted safely, so the bot refuses to delete it.

**What to do.** Delete it from the dashboard, which can address rows by position.

### BOT-005

**Split could not be logged** · `fatal`

**Why it happens.** A category-split receipt failed partway through writing its parts.

**What to do.** Check the sheet — some categories may have been written already. Reconcile before retrying.

### BOT-006

**Daily receipt limit reached** · `fatal`

**Why it happens.** More than 50 receipts in one day from one user.

**What to do.** Expected guard against a runaway loop. Resets at midnight.

### BOT-007

**Parked charge could not be logged** · `fatal`

**Why it happens.** A wallet charge held for category confirmation failed to write when the user tapped.

**What to do.** The pending record is kept deliberately so tapping again retries. Do not clear it.

### BOT-008

**Category move left a duplicate** · `fatal`

**Why it happens.** A weekly-audit recategorization added the row to its new category but could not remove the old one. The expense is now counted twice.

**What to do.** Delete the old entry in the dashboard. The move deliberately appends before deleting, so a half-failure duplicates rather than destroys.

## WAL — Wallet webhook

### WAL-001

**Wallet request rejected as invalid** · `fatal`

**Why it happens.** Missing or unparseable merchant, amount, or email in the webhook body.

**What to do.** The phone automation is sending the wrong shape — check the field mapping after any OS or app update.

### WAL-002

**Wallet transaction write failed** · `fatal`

**Why it happens.** The charge arrived but could not be written to the sheet. It is LOST unless re-entered.

**What to do.** Add it manually. This is the most important error in the system to act on.

### WAL-003

**Wallet text parse failed** · `degraded`

**Why it happens.** The raw notification text could not be parsed, so fields fall back to whatever the automation sent directly.

**What to do.** Often still logs correctly. Repeated hits mean the bank changed its notification wording.

### WAL-004

**Vendor skipped by user rule** · `degraded`

**Why it happens.** The vendor matches a disabled-wallet-vendor rule and was intentionally not logged.

**What to do.** Working as configured. Remove the rule in Settings if this vendor should be logged.

## FX — Currency conversion

### FX-001

**Currency conversion failed** · `degraded`

**Why it happens.** The exchange-rate API was unreachable or returned an unusable response.

**What to do.** The amount is logged in its original currency without conversion. Correct it by hand if it matters.

### FX-002

**Unknown currency** · `degraded`

**Why it happens.** The extracted currency code is not one the converter knows.

**What to do.** Usually a misread symbol on the receipt. Check the logged amount.

## WEB — Dashboard (frontend)

### WEB-001

**Dashboard render crashed** · `fatal`

**Why it happens.** A React render threw and the error boundary caught it. The user saw a fallback screen.

**What to do.** Reproduce in the browser console. This is the only class of error the user sees as a blank/fallback page.

### WEB-002

**Unhandled promise rejection in the dashboard** · `degraded`

**Why it happens.** An async operation failed with nobody catching it.

**What to do.** Often a failed fetch during navigation. Harmless individually; a pattern means a missing catch.

### WEB-003

**Offline — write refused** · `degraded`

**Why it happens.** A change needing the network was attempted with no connection.

**What to do.** Expected. Retry when back online; simple expense adds queue offline, category moves do not.

### WEB-004

**Receipt file rejected** · `fatal`

**Why it happens.** Unsupported file type, or a PDF over the size limit.

**What to do.** Expected user error. Send an image, or a screenshot instead of a large PDF.

## WHS — WHS

### WHS-001

**Warehouse write failed — queued for retry** · `degraded`

**Why it happens.** A BigQuery Storage Write API append errored or blew the hot-path timeout, so the rows went to the Firestore outbox instead.

**What to do.** Nothing to do immediately — the warehouse cron drains the outbox every 15 minutes. A steady stream of these means BigQuery is unreachable or the table schema drifted.

### WHS-002

**Warehouse outbox write failed** · `degraded`

**Why it happens.** BigQuery AND Firestore both failed, so the event was not persisted anywhere. This is the only path where a warehouse row is genuinely dropped.

**What to do.** The reconciler is the backstop: it diffs the actual sheet and re-emits the row with state_reason=missed_notify on its next pass. Check that Firestore is healthy.

### WHS-003

**Warehouse event rejected as malformed** · `degraded`

**Why it happens.** An ingest event was missing a REQUIRED column or carried an unknown one. That is a caller bug, not a transient failure, so it is not queued for retry.

**What to do.** Look at the reported table and column. A new field needs a NULLABLE column added in _warehouse-schema.mjs before any caller sends it.

### WHS-004

**Warehouse outbox entry dead-lettered** · `degraded`

**Why it happens.** An outbox entry exhausted MAX_OUTBOX_ATTEMPTS drains and will not be retried again.

**What to do.** Read the entry in the warehouse_outbox collection; lastError says why. Usually a schema mismatch. Fix the schema, then clear the dead flag to have it retried.

### WHS-005

**Warehouse reconciliation aborted on a partial read** · `degraded`

**Why it happens.** One or more ranges in a month failed to read, so the sheet snapshot was incomplete. Emitting deletes from a partial snapshot would mark live transactions as deleted.

**What to do.** Usually a transient Sheets 429/500 — the next tick retries the whole month. Persistent failures mean the month sheet was renamed, deleted, or unshared.

### WHS-006

**Warehouse backfill gate failed** · `degraded`

**Why it happens.** A staged month did not reconcile against the spreadsheet, so nothing was promoted into the archive.

**What to do.** Read load_audits for the failing check_name. category_sum and month_sum are exact integer-cent comparisons; a mismatch is a real data problem, not rounding.

### WHS-007

**Warehouse dataset has an expiration policy set** · `config`

**Why it happens.** defaultTableExpirationMs or defaultPartitionExpirationMs is set on the archive dataset. Either one silently deletes the archive on a timer, with no error anywhere.

**What to do.** Unset both immediately: bq update --default_table_expiration 0 --default_partition_expiration 0 <project>:fundient_warehouse

### WHS-008

**Warehouse notify rejected an unknown spreadsheet** · `degraded`

**Why it happens.** A client asserted a write against a spreadsheet id that is not in month_dim, so it was refused rather than recorded.

**What to do.** Expected if a month was created outside the app. Run the month_dim snapshot, or check whether something is calling the notify endpoint with a bad id.

### WHS-009

**Warehouse skipped a tab whose header does not match the contract** · `degraded`

**Why it happens.** A category tab has a header row the V2 reader does not recognise — usually a custom category, which addCategory writes with 5 columns and no UUID.

**What to do.** Not an error by itself; the tab is skipped and excluded from both sides of the month_sum gate. Convert the tab to the V2 shape if you want it archived.

---

## Adding a code

1. Add an entry to `ERROR_CODES` in `functions/lib/_error-codes.mjs`.
2. Use the next free number in that domain. **Never reuse a retired number** —
   an old log line should still resolve to what it meant when it was written.
3. Call it: `await reportError('SHT-011', err, { sheetId, category })`.
4. Run `npm run errdoc` and commit the regenerated doc.

