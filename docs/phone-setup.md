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
{ "text": "<title + subtitle + body>", "card": "<the notification Title>", "email": "<phone owner's email>", "source": "<tag>" }
```

Send the notification **Title as `card`** as well as inside `text`. The parser does
not reliably pick a card name out of the first line (a real Capital One test came back
with no card); an explicit `card` wins over the parsed one and is then matched to your
Fundient card list.

Send the **whole notification** as `text` (title, subtitle and body joined by
newlines): the merchant is sometimes in the subtitle, the card name in the title.
Do not send `amount` or `merchant` from these automations; the server parses them
(structured fields would win over the parsed ones).

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
| Foreign charge, converted | ✅ | `✅ $18.33 at Xt Network Sas (€16.00 converted at 0.873) → Misc…`: an estimate, the bank's rate differs a few percent |
| Foreign charge, could not convert | ⚠️ | NOT logged: add it by hand (the Capital One app's USD notification is exact) |
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
2. **Capital One**: build the notification automation (app = Capital One) in test mode, locked-phone test, go live. Then take Capital One (and Apple Cash) out of the old Wallet Logger's card list.
3. **Amex**: a Wallet-notification automation (app = **Wallet**, Title filter "American Express"). Wallet also notifies for **online** Amex purchases, which the old Wallet-transaction trigger (taps) misses. Test mode, then go live, then take Amex out of the old Logger's list. Until then Amex stays in the old Logger so nothing goes unlogged; the duplicate guard skips any overlap while testing.
4. **Chase: no automation.** The Chase app sends no notifications to the iPhone, so there is nothing to forward. Chase stays in the old Wallet Logger (Wallet-transaction trigger, taps only). Chase online / card-not-present purchases are a known gap.
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
node scripts/wallet-roundtrip.mjs --raw-as-primary --card "<the notification Title>" --raw "<pasted Chase notification>"
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
   2. **Get Contents of URL**: URL as above; Method **POST**; Headers: `X-API-Key` = `<secret>` (same as the old Shortcut), `Content-Type` = `application/json`; Request Body **JSON** with fields: `text` (the Text from step 1), `card` (the *Title* pill), `email`, `source`, and, **in test mode**, `sheetId`.
   3. **Get Dictionary Value**: key `message` from the *Contents of URL*.
   4. **Show Notification** with that value. (Title e.g. "Fundient".)
5. Test mode body: `email` = `<test email>`, `sheetId` = `<test sheet id>`.
6. Test: (a) run the shortcut by hand from the Shortcuts app with pasted real text in the Text action; (b) a real notification with the phone unlocked; (c) a real notification with the phone **locked** and screen off. For each, check: the banner, the Telegram messages, and the row in the **test copy**.
7. Go live: delete the `sheetId` field, set `email` to `<primary email>`.

Rollback: switch the automation off (or delete it). Delete any wrongly logged row from the category tab and History in the month sheet (or use the dashboard delete).

### B. Per issuer

- **Capital One** (`source: ios-notif-capone`). Trigger: app = **Capital One**. The app's notification is titled with the card ("Quicksilver Credit Card") and reads "Your purchase for $17.68 at YouTube was approved." (dollars, readable merchant; sometimes `REAL-DEBRID*…`, which the server normalizes). Send the Title as `card`; the server maps "Quicksilver Credit Card" to the held Capital One card. The real title also carries the card's last four digits after an ellipsis ("Quicksilver Credit Card…NNNN"); the server strips that suffix before matching, so send the Title unchanged.
  **Capital One can notify twice for one purchase.** An online purchase from a foreign merchant produced, in the same minute, the app notification (`$18.26 at REAL-DEBRID*…`, USD) **and** a Wallet-badged one ("Capital One Mobile / Xt Network Sas / €16.00", native currency, operator name). **Decision: automate only the Capital One app notification.** Never build an automation on the Wallet-badged "Capital One Mobile" one: the two amounts differ, so the 2-minute duplicate guard would not catch the second post.
  *Watch item:* if you ever see a charge that produced **only** the Wallet-badged notification (no app banner), note the merchant and time and report it; that is the case that would make us revisit this decision. Foreign-currency amounts are converted to dollars by the server.
- **Amex** (`source: ios-notif-amex`). Amex has no purchase notifications of its own; they come from **Wallet** (for taps, and for online purchases), grouped under "Wallet" with the Amex logo. Observed layout: Title **American Express**; then the merchant line (`Little Oddfellows, Seattle, WA`, sometimes only `Mcdonalds`, long names shortened with "…" in the stack, the full text is in the notification body); then the amount (`$17.58`). Trigger: app = **Wallet**, Add Filter → **Title contains "American Express"** (so other Wallet notifications do not fire it). Text = Title, Subtitle, Body joined (Subtitle may be empty); `card` = Title (the server resolves "American Express" to the single held Amex card). A foreign-currency Wallet amount is converted to dollars by the server. Check a real one with `--raw --card "American Express"` before building.
- **Chase**: no automation. The Chase app sends no notifications on the iPhone, so nothing can be forwarded. The old Wallet Logger keeps covering Chase card taps.

### C. Old "Wallet Logger" Shortcut: final card list

What it is (from its editor): trigger **Wallet transaction**, "When **Bilt Blue Card and 6
more** is tapped" (7 cards selected), Categories: Any, Merchants: Any, Automation on,
Notify on, Confirm Before Run off. Variables `amount`, `merchant`, `Card` (the Wallet
card name), then **Get contents of** the hosting-domain `/api/wallet` URL, POST, header
`X-API-Key`, JSON body `amount`, `merchant`, `email`, `card` (no `sheetId`, no `source`),
then **Show notification** with the raw *Contents of URL*.

The final list is **Bilt Blue Card + the three Chase cards** (Sapphire Reserve, Freedom Rise, Chase Debit). Bilt has no notifications at all and Chase sends none to this phone, so the Wallet-transaction trigger is the only thing that sees them. Capital One and Amex move to their notification automations (which also catch online purchases) and Apple Cash is dropped.

Edit the trigger's card list **one issuer at a time, only after that issuer's new automation is proven live and you confirm**:

1. After Capital One goes live: open Shortcuts → Wallet Logger → tap the "... and N more" pill and deselect **Capital One Quicksilver** and **Apple Cash** (Apple Cash is added by default; structured posts skip the server's non-purchase check, so a transfer would otherwise look like a purchase).
2. After Amex goes live: deselect **Amex**.
3. Optional, safe now: before **Show notification** add **Get Dictionary Value** (key `message`, from *Contents of URL*) and show that instead of the raw JSON. Structured posts keep working.
4. The `card` value is the Wallet card name. Confirm the exact text for Bilt and each Chase card by running once and checking that it maps to the Fundient card name. Chase has two debit cards saved (one per person): a bare "Chase Debit" is ambiguous and is now kept as the raw string rather than guessed, so use the full Fundient name where possible.
5. One real purchase per remaining card should land once.

Do not change the other actions. Rollback: reselect the card (the 2-minute duplicate guard covers the overlap, at the cost of a "skipped duplicate" Telegram note per charge).

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

## Rotating the webhook key

Do this once **after all sources are live** (and any time the key may have been seen, for
example in a screenshot or a chat). Rotating breaks every phone until it has the new key,
so do it in one sitting with both phones to hand. Nothing here contains a secret.

1. **Pick the new key** (a long random string) and keep it in your password manager. Type
   it only into your own terminal and phone apps; never paste it into chat or the repo.
2. **Set it in Firebase** (this creates a new version of the `WALLET_WEBHOOK_SECRET`
   secret):
   ```bash
   firebase functions:secrets:set WALLET_WEBHOOK_SECRET --project fundient-dashboard
   ```
   It prompts for the value.
3. **Redeploy the functions** so they pick up the new version (a merge to `develop`
   deploys them, or deploy by hand):
   ```bash
   firebase deploy --only functions --project fundient-dashboard
   ```
   From this moment every request with the old key gets `401` (❌ banner).
4. **Update the key everywhere it lives:**
   - the old Wallet Logger Shortcut (header `X-API-Key`),
   - every new notification Shortcut (header `X-API-Key`),
   - the Android Automate flows (Request headers dictionary).
5. **Verify** with the round-trip kit (`docs/wallet-verification.md`), for example
   `node scripts/wallet-roundtrip.mjs --only auth_bad,purchase_structured` with the new
   key exported via `read -s`: `auth_bad` must still be 401 and `purchase_structured` 200.
6. **Watch the heartbeat**: a phone that still holds the old key posts nothing, and after
   4 days the primary gets a 📵 alert. Trigger a real notification on each phone to be sure.

## Cutover checklist

Per source, in this order (one source at a time; the old Wallet Logger is edited only after the matching automation is live and you confirm):

**Capital One (app notification)**
- [ ] Real text pasted through `--raw --card "Quicksilver Credit Card"`: amount, vendor, card `Capital One Quicksilver`
- [ ] Test mode (alias email + test `sheetId`): a real notification lands in the test copy; banner shows the ✅/🤔 message
- [ ] **Locked-phone test:** a real notification while the phone is locked and the screen is off still runs the automation (note the result here)
- [ ] Go live: delete `sheetId`, set `email` to the phone owner; one real charge lands **once** in the real sheet
- [ ] Only then remove Capital One (and Apple Cash) from the old Wallet Logger's card list

**Amex (Wallet notification)**
- [ ] Real text (a tap, ideally also an online purchase) through `--raw --card "American Express"`
- [ ] Test mode, locked-phone test, go live as above (`source: ios-notif-amex`)
- [ ] Only then remove Amex from the old Wallet Logger's card list

**Old Wallet Logger**
- [ ] Final list is Bilt Blue Card + the three Chase cards; optionally show `message` in the banner
- [ ] One real Bilt purchase and one Chase purchase still land once

**Android (her phone)**
- [ ] Wallet flow: header set, test mode → live
- [ ] Chase-SMS flow: test mode → live
- [ ] Battery settings done; heartbeat visible in Firestore `wallet_activity`

**Finish**
- [ ] Watch item reviewed (a Capital One charge with only the Wallet-badged notification?)
- [ ] Test-email `wallet_activity` docs deleted; test copy sheet deleted
- [ ] Webhook key rotated (see *Rotating the webhook key*) and every phone updated

## Contributing real texts as test fixtures (public repo)

Redact **before** pasting anywhere: card last-4, account numbers, names, phone
numbers, addresses, balances, and swap a real merchant for a generic one when it
identifies you. Keep the structure (line breaks, punctuation, `$` amounts) exactly.
