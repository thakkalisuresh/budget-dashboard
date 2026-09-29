# Phone setup and cutover (wallet auto-logging)

Step-by-step for wiring the two phones to the wallet webhook (contract:
`docs/wallet-ingestion.md`; verification kit: `docs/wallet-verification.md`).
No secrets or real addresses in this file: `<primary email>` is the iPhone owner
(the household primary: all Telegram prompts, nudges and heartbeat alerts go to
their chat), `<other phone email>` is the Android owner, `<test email>` is a
`+wallettest` alias that belongs to nobody, `<test sheet id>` is the bare id of
the throwaway copy from `wallet-verification.md` §1.

The secret (`WALLET_WEBHOOK_SECRET`) is typed by you into each phone app. Do not
paste it into chat, screenshots or this repo.

## The endpoint, header, body

```
POST https://<dashboard hosting domain>/api/wallet
X-API-Key: <WALLET_WEBHOOK_SECRET>
Content-Type: application/json
```

Use the same hosting-domain URL and the same `X-API-Key` header the old Shortcut
already uses (copy the header from it). The server also accepts
`Authorization: Bearer <secret>`; either works, pick one per automation.

```json
{ "text": "<the notification text>", "email": "<phone owner's email>", "source": "<tag>" }
```

Send the **whole notification** as `text` (title, subtitle and body joined by
newlines): the merchant is sometimes in the subtitle, the card name in the title.
Do not send `amount`, `merchant` or `card` from these automations; the server
parses them (structured fields would win over the parsed ones).

### `source` tags

`source` is diagnostic only (max 40 chars; it lands in the heartbeat doc and logs).

| Automation | `source` |
|---|---|
| iPhone, Amex notification | `ios-notif-amex` |
| iPhone, Capital One notification | `ios-notif-capone` |
| iPhone, Chase notification | `ios-notif-chase` |
| iPhone, old Wallet-transaction Shortcut (Bilt only) | `ios-txn-bilt` (if you can add it; not required) |
| Android, wallet tap-to-pay | `android-wallet` |
| Android, Chase SMS | `android-chase-sms` |

### What comes back (the phone banner)

Every response has a `message`; show **only** that. Full table: `wallet-ingestion.md`.

| Situation | Banner starts | Example |
|---|---|---|
| Logged | ✅ | `✅ $17.58 at Little Oddfellows on Amex BCP → Dining. Added to your September 2026 budget in Fundient.` |
| Waiting on a category (Telegram prompt) | 🤔 | not logged yet: tap a category on Telegram |
| Split-receipt vendor | 🧾 | not logged yet: upload receipt or SKIP on Telegram |
| Not a purchase (declined, statement, deposit, autopay, refund, OTP) | ℹ️ | skipped quietly, nothing logged, no error |
| Duplicate within 2 minutes | ⏭ | skipped, Telegram note with "Log it anyway" |
| Could not read amount | ⚠️ | nothing logged |
| No sheet for the month | ⚠️ | create the month in the dashboard |
| Bad or missing secret | ❌ | check the `X-API-Key` / Authorization header |
| Save failed | ❌ | the charge was NOT logged: enter it by hand |

## Cutover order (safe, one automation at a time)

Rule: **build every new automation in test mode first**, prove it, then go live.

**Test mode** = the body also carries `"sheetId": "<test sheet id>"` and `"email"`
is `<test email>`. Real notifications then land in the throwaway copy only, the
2-minute duplicate guard is isolated by email from the old Shortcut (which keeps
logging real charges untouched), and nothing reaches the real sheet.

**Go live** = change exactly two body fields: delete `sheetId`, set `email` to
the phone owner's real email. Nothing else.

Test-mode cautions:

- The `<test email>` has no settings row, so cards do not resolve there. Validate
  card mapping separately with `--raw --raw-as-primary` (below).
- Ambiguous charges send a 🤔 prompt to the primary's Telegram; tapping a category writes to the **copy**. Tap them so tomorrow's 08:00 nudge stays quiet.
- **Never upload a receipt on a split (🧾) prompt from a test-mode charge**; tap SKIP. The split flow looks up the real month.
- Keep the copy sheet (`WALLET TEST COPY - delete me`) until every source has gone live.
- Test posts create `wallet_activity` docs for `<test email>`; delete them in the Firestore console when done, or the heartbeat will page after 4 days.

Order:

1. **Paste-test each real text** (no phone automation yet) — see *Validate a real notification text*.
2. **Capital One**, then **Amex** (single-card issuers): build, test mode, locked-phone test, go live.
3. **Chase** (3 cards): confirm the card-name mapping including the Sapphire Reserve → other person, go live.
4. **Restrict the old Shortcut to Bilt only** in the same sitting as the go-live of Amex/Chase/Capital One, otherwise every charge posts twice (the guard skips the second and Telegram gets a "⏭ skipped duplicate" note each time).
5. **Android**: fix the wallet flow header, add the Chase-SMS flow, battery settings.
6. Watch for a few days: the 08:00 Pacific job sends parked-charge nudges and, if a phone has been silent 4+ days, a 📵 alert.

Rollback for any step is under that step.

## Validate a real notification text (before building anything)

From the repo, in your own terminal (secret typed with `read -s`, never echoed):

```bash
read -s WALLET_WEBHOOK_SECRET && export WALLET_WEBHOOK_SECRET
export WALLET_URL='https://<dashboard hosting domain>/api/wallet'
export TEST_SHEET_ID='<test sheet id>' TEST_EMAIL='<test email>'
export REAL_EMAILS='<primary email>,<other phone email>'
node scripts/wallet-roundtrip.mjs --raw "Little Oddfellows, Portland, OR
\$17.58"
```

To see whether the **card** resolves (uses the primary's card list; the row still
goes to the copy, and it refreshes the primary's heartbeat, which is fine):

```bash
export PRIMARY_EMAIL='<primary email>' SETTINGS_EMAIL='<primary email>'
node scripts/wallet-roundtrip.mjs --raw-as-primary --raw "<pasted Chase notification>"
```

It prints the status, vendor, category, amount and the exact `message` the phone
would show. Every rail of the round-trip kit stays on: refused without
`TEST_SHEET_ID`, `sheetId` always sent, a real email as `TEST_EMAIL` refused.
If the amount, merchant or card is wrong, stop and report it with the text
(redact first: see the end of this file).

## iPhone (iOS 27): Shortcuts "Notification" automations

What is documented (Apple Support "Event triggers", MacStories iOS 27 review):
Shortcuts → Automation → **Notification** trigger: choose the app, optionally
filter on Title / Subtitle / Message; the automation gets a **Notification**
magic variable with title, subtitle and body. **Not documented anywhere I could
find**, so test it yourself: whether it fires while the phone is locked, whether
"Run Immediately" is offered for this trigger, latency, and how notifications
from the same app are grouped. Step 1 below includes a locked-phone test.

### A. Build one automation (repeat per issuer)

1. Shortcuts → **Automation** → **+** → **Notification**.
2. **App**: choose the issuer's app (Capital One, or **Wallet** for Apple Wallet
   notifications; see the per-issuer notes). Optional filter to narrow (e.g. Title
   contains the issuer name).
3. Set to **Run Immediately** if offered (otherwise "Run After Confirmation" cannot
   work unattended: note that in your report). Turn **Notify When Run** off.
4. Add the actions:
   1. **Text**: three lines, the variable pills from the *Notification* variable: `Title`, `Subtitle`, `Body` (one per line). An empty subtitle is harmless.
   2. **Get Contents of URL**: URL as above; Method **POST**; Headers: `X-API-Key` = `<secret>` (same as the old Shortcut), `Content-Type` = `application/json`; Request Body **JSON** with fields: `text` (the Text from step 1), `email`, `source`, and, **in test mode**, `sheetId`.
   3. **Get Dictionary Value**: key `message` from the *Contents of URL*.
   4. **Show Notification** with that value. (Title e.g. "Fundient".)
5. Test mode body: `email` = `<test email>`, `sheetId` = `<test sheet id>`.
6. Test: (a) run the shortcut by hand from the Shortcuts app with pasted real text in the Text action; (b) a real notification with the phone unlocked; (c) a real notification with the phone **locked** and screen off. For each, check: the banner, the Telegram messages, and the row in the **test copy**.
7. Go live: delete the `sheetId` field, set `email` to `<primary email>`.

Rollback: switch the automation off (or delete it). Delete any wrongly logged row from the category tab and History in the month sheet (or use the dashboard delete).

### B. Per issuer

- **Capital One** (`source: ios-notif-capone`). The app's notification names the card in-body and the merchant can be ugly (`REAL-DEBRID*…`); the server normalizes it. App: Capital One.
- **Amex** (`source: ios-notif-amex`). Amex usually arrives via **Wallet** titled "American Express" with the merchant and amount in the body; if the Amex app also sends purchase notifications, pick one source only, or the same charge posts twice (the 2-minute guard skips the second and Telegram gets a note). Ask which one fires.
- **Chase** (`source: ios-notif-chase`). Three cards share the notification; the **notification prints the card name**, so the server maps it (`resolveCardName`). Before go-live, run `--raw-as-primary` with a real text from each card you can capture (Debit, Freedom Rise, Sapphire Reserve) and confirm the card resolves. The Sapphire Reserve belongs to the other person, so the row should attribute to them through the card-owner setting even though it posts from the primary's phone.

### C. Old "Wallet Logger" Shortcut: restrict to Bilt only

What it is (from its editor): trigger **Wallet transaction**, "When **Bilt Blue Card and 6
more** is tapped" (7 cards selected), Categories: Any, Merchants: Any, Automation on,
Notify on, Confirm Before Run off. Variables `amount`, `merchant`, `Card` (the Wallet
card name), then **Get contents of** the hosting-domain `/api/wallet` URL, POST, header
`X-API-Key`, JSON body `amount`, `merchant`, `email`, `card` (no `sheetId`, no `source`),
then **Show notification** with the raw *Contents of URL*.

Once the Capital One / Amex / Chase notification automations work:

1. Shortcuts → Automation → Wallet Logger → tap the "Bilt Blue Card and 6 more" pill and **deselect the other six cards**, leaving only *Bilt Blue Card*. (List the seven cards first; any card that is not in your Fundient settings would resolve to its raw Wallet name.)
2. Optional but recommended: before **Show notification** add **Get Dictionary Value** (key `message`, from *Contents of URL*) and show that instead of the raw JSON. Structured posts keep working.
3. The `card` value is the Wallet card name ("Bilt Blue Card" presumably). Confirm the exact text by running the Shortcut once and check it maps to the Fundient card name.
4. One real Bilt purchase: it should land once, on Bilt Blue.

Do not change the other actions. Rollback: reselect the six cards (all cards again; the 2-minute duplicate guard covers the overlap, at the cost of a "skipped duplicate" Telegram note per charge).

## Android (Samsung, Automate by LlamaLab)

Automate, **not** Tasker or MacroDroid. Flows are block diagrams; the pieces:

- **HTTP request** block: Request URL; Request method POST; **Request headers** (a dictionary) `{"X-API-Key":"<secret>"}` or `{"Authorization":"Bearer <secret>"}` (this is the field an earlier attempt stalled at); Request content type `application/json`; Request content: a JSON string or dictionary with `text`, `email`, `source` (and `sheetId` in test mode). Default timeout 15 s: raise to 45 s (cold start). Response content goes to a variable.
- Show the banner from the response: `jsonDecode(response)["message"]` in a **Toast/Notification** block. *(Expression syntax should be checked on the device; the function `jsonDecode` exists in Automate's function list. If it is awkward, `replaceAll` with a regex on the raw text works too, or show the whole response while testing.)*

### A. Wallet flow (Samsung Wallet tap-to-pay) — `source: android-wallet`

1. **Notification posted** block: package = Samsung Wallet (pick it from the app list; note the exact package on your phone), "when transition". Output: the notification dictionary → title and text into variables.
2. **Expression / Variable set**: `text = title & "\n" & text` (join title and body).
3. **HTTP request** as above with `email` = `<other phone email>`.
4. Toast the `message`. Loop back to step 1 (Automate flows must loop).
5. Test mode first (`sheetId`, `<test email>`), then live.

### B. Chase SMS flow — `source: android-chase-sms`

1. **SMS received** block; sender = Chase's short code or sender ID (check the number in a real text). This block sees **SMS only**: if her Chase texts arrive over RCS in Google Messages, the block will not fire. Fallback: a **Notification posted** block on the Messages app package.
2. Same HTTP request; `text` = the message body; `email` = `<other phone email>`.

### C. Keep Automate alive (this is where it fails silently)

- Settings → Apps → Automate → Battery → **Unrestricted**.
- Settings → Battery → Background usage limits: remove Automate from "sleeping/deep sleeping apps", turn off "Put unused apps to sleep".
- Recents: lock Automate's card (so a clear-all does not kill it).
- Grant Automate notification access and SMS permission when prompted.
- The heartbeat is the safety net: 4+ days without a post raises a 📵 alert to the primary's Telegram, repeating every ~3 days.

Rollback: stop the flow in Automate (the app's flow list → Stop).

## Cutover checklist

- [ ] Real text captured per source and pasted through `--raw`; parse looks right
- [ ] Capital One: test mode proven (locked-phone too) → live → old Shortcut still fine
- [ ] Amex: same
- [ ] Chase: card mapping verified for each card, Sapphire Reserve attributed to the other person
- [ ] Old Shortcut restricted to Bilt; one Bilt purchase logged once
- [ ] Android wallet flow: header set, test mode → live
- [ ] Android Chase SMS flow: test mode → live
- [ ] Battery settings done; heartbeat visible in Firestore `wallet_activity`
- [ ] Test-email `wallet_activity` docs deleted; test copy sheet deleted

## Contributing real texts as test fixtures (public repo)

Redact **before** pasting anywhere: card last-4, account numbers, names, phone
numbers, addresses, balances, and swap a real merchant for a generic one when it
identifies you. Keep the structure (line breaks, punctuation, `$` amounts) exactly.
