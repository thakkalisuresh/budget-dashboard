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
| Duplicate within 2 minutes (same email), or same card + amount from the other phone within 3 minutes | ⏭ | skipped, Telegram note with "Log it anyway" |
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
2. **Capital One**: notification automation (app = Capital One), built as a thin caller of the core. Done; Capital One and Apple Cash are already out of the old Wallet Logger's card list.
3. **Amex**: a Wallet-notification automation (app = **Wallet**, Title filter "American Express"), also a thin caller. Wallet also notifies for **online** Amex purchases, which the old Wallet-transaction trigger (taps) misses. Built; Amex stays in the old Logger as overlap until its first real charge shows the core banner.
4. **Bilt and Chase**: these send no notifications to the iPhone, so the only source is the Wallet-transaction trigger (taps only). "Wallet Bilt + Chase" is a thin caller on that trigger for those four cards. Chase online / card-not-present purchases are a known gap.
4b. **Go live**: MODE flipped to `live` (see *The MODE switch, and going live*). Real charges now reach the real sheet; the old Wallet Logger runs in parallel as overlap and the 2-minute duplicate guard skips the second post of the same charge (expect a "⏭ skipped duplicate" Telegram note and a "⏭" core banner on charges both paths cover).
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

## iPhone current layout: one core Shortcut + thin callers

The iPhone is wired as **one core Shortcut plus thin automations**. Only the core
knows the secret, the endpoint and who the phone owner is; the automations just
hand it a small dictionary. (The per-automation "Get Contents of URL" recipe in the
next section is the older direct design; keep it for reference, but build new
callers as described here.)

**The core, "Fundient Logger"** (a plain Shortcut, not an automation):

1. *Receive* input (Shortcut Input), from anywhere, continue if no input.
2. **Text** action holding the mode word: `test` or `live`, lowercase, nothing else. Rename it `MODE`.
3. **Get Dictionary from** Shortcut Input.
4. **If MODE is test**: set `email` to `<test email>` and `sheetId` to `<test sheet id>`.
   **Otherwise, If MODE is live**: set `email` to `<primary email>` and send **no** `sheetId`.
   Any other value matches neither branch: no `email` goes out and nothing is logged (fail-safe: a typo cannot reach the real sheet).
5. **Get Contents of URL**: POST to the endpoint above, `X-API-Key` header, JSON body = the dictionary.
6. **Get Dictionary Value** `message`, then **Show Notification**.

**A thin caller** (an automation) builds a dictionary and runs the core with that dictionary as input:

- **Keys are lowercase and case-sensitive**: `text`, `card`, `merchant`, `amount`, `source`. A capitalised key (`Card`, `Amount`) is not read. This bites when the iOS "describe an automation" assistant scaffolds one: it capitalises dictionary keys, so check them.
- **No secret, no email, no `sheetId` in a caller.** The core adds them. A caller therefore never changes when the key is rotated or when going live.
- **Structured callers send `amount` as text.** A Dictionary action's value pills are text, and the server accepts that (`"17.58"` works as well as a number), so do not fight the Number type.
- Notification callers send `text` (Title, Subtitle, Body joined), `card` (the Title) and `source`; Wallet-tap callers send `amount`, `merchant`, `card` and `source`.
- **One-time prompt:** the first time each caller runs the core, iOS asks "Allow ... to run another shortcut?". Tap **Allow**. Do this by running the caller by hand from its editor once (while MODE is `test`, with empty or placeholder values, which the server rejects harmlessly), so the prompt is not left for the first real charge.
- Automation callers work with the phone locked and unlocked (Automation on, Notify off).

**Current iPhone set** (`source` tag in brackets):

| Shortcut | Trigger | Does |
|---|---|---|
| Fundient Logger | none (called) | the core above |
| Wallet Bilt + Chase | Wallet, card tapped: Bilt and the three Chase cards only | Dictionary `amount`, `merchant`, `card` from the Wallet transaction's Amount, Merchant, Card or Pass, plus `source` (`ios-wallet-tap`), then Run Shortcut core |
| Cap One | app notification, Capital One | Text(Title, Subtitle, Body) into Dictionary `text`, `card` = Title, `source` (`ios-notif-capone`), then Run Shortcut core |
| Amex | app notification, Wallet, Title contains "American Express" | same shape (`ios-notif-amex`) |
| Wallet Logger (old) | Wallet, card tapped: remaining overlap cards | the old direct post; kept as overlap and rollback until retired (see section C) |

### The MODE switch, and going live

`MODE` is the only thing that changes between test and live. In `test`, the core
sends the alias email and the test sheet id, so a real notification lands in the
throwaway copy. In `live` it sends the real email and no sheet id.

To go live, edit that one Text action from `test` to `live` (lowercase, nothing else; do
not open or touch the URL action or its header). Then prove it **without a purchase**:
run a caller (or a throwaway one) by hand with clearly non-purchase text such as
"Your statement is ready to view". The expected response is the "Not a purchase" banner
(skipped quietly, nothing logged). The signal that live mode reached the server as the
real owner is the owner's `wallet_activity` heartbeat doc updating (`lastSeenAt`,
`lastSource`). **After the flip, never test with a fake charge: it would log to the real
sheet.** Delete any throwaway caller afterwards.

Rollback: set the Text back to `test` (nothing more reaches the real sheet), or switch an
individual automation off. A wrongly logged row is deleted in the dashboard.

## iPhone (iOS 27): Shortcuts "Notification" automations (direct design)

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

**Status:** the old Logger now covers five cards: Bilt Blue, Amex, and the three Chase cards. Capital One and Apple Cash are already deselected. It is **overlap and rollback** only: Bilt and the three Chase cards are also covered by "Wallet Bilt + Chase", and Amex by the "Amex" notification automation, all through the core. The end state is to retire the old Logger entirely. Bilt has no notifications and Chase sends none to this phone, so for those the Wallet-transaction trigger is the only source; it just lives in the thin caller now.

Edit the trigger's card list **one card at a time, only after that card's first real charge through the new path shows a core banner** ("✅ ..." or "⏭ ...", proof the new path fired) and you confirm:

1. Done: **Capital One Quicksilver** and **Apple Cash** deselected (Apple Cash is added by default; structured posts skip the server's non-purchase check, so a transfer would otherwise look like a purchase).
2. After the first real Amex charge shows the core banner: deselect **Amex**.
3. After the first real charge on each of Bilt Blue, Chase Sapphire Reserve, Chase Freedom Rise and Chase Debit shows the core banner: deselect that card.
4. When no cards remain, delete the old Wallet Logger, then rotate the key (below).
5. The `card` value is the Wallet card name. Chase has two debit cards saved (one per person): a bare "Chase Debit" is ambiguous and is kept as the raw string rather than guessed, so check the card maps to the right Fundient card name on the first real charge.

Do not edit the old Logger's actions or header. If a real charge produces **no** core banner, the old Logger still covers it; report it. Rollback of a deselect: reselect the card (the duplicate guard covers the overlap, at the cost of a "skipped duplicate" Telegram note per charge).

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

**What the text looks like** (synthetic example; the real alerts come from short code 24273):

```
Chase Example Card Visa: You made a $12.34 transaction with EXAMPLE STORE #0001 on Sep 18, 2026 at 9:46 PM ET.
```

- **Send the body verbatim.** The backend parses card, vendor and amount; the card prefix ("Chase Sapphire Reserve Visa") is resolved to the card name held in that user's settings. Other Chase texts (one-time codes, balance alerts, "payment received") are skipped as non-purchases.
- **The time in the text is Eastern ("ET"), not local.** The backend converts it to the household's timezone before choosing the day and month sheet, so a charge made at 11:30 PM Pacific on the last day of a month (shown as 2:30 AM ET on the 1st) is filed under the earlier month. A delayed text keeps its true date. Texts without a date (Amex, Capital One) use the arrival day.
- **Descriptors are raw** (`DD *...`, `SQ *...`, store numbers, `... TEMP AUTH ...` pre-authorisations). A pre-authorisation and the later final charge both arrive as separate purchases.

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
   - the core "Fundient Logger" Shortcut (its URL action's `X-API-Key` header: the only place on the iPhone besides the old Wallet Logger, until that is retired; the thin callers hold no key),
   - the old Wallet Logger Shortcut, if it still exists (header `X-API-Key`),
   - the Android Automate flows (Request headers dictionary).
5. **Verify** with the round-trip kit (`docs/wallet-verification.md`), for example
   `node scripts/wallet-roundtrip.mjs --only auth_bad,purchase_structured` with the new
   key exported via `read -s`: `auth_bad` must still be 401 and `purchase_structured` 200.
6. **Watch the heartbeat**: a phone that still holds the old key posts nothing, and after
   4 days the primary gets a 📵 alert. Trigger a real notification on each phone to be sure.

## Cutover checklist

Per source, in this order (one source at a time; the old Wallet Logger is edited only after the matching automation is live and you confirm):

**Core + go live**
- [x] Core "Fundient Logger" built; callers are thin (lowercase keys, no secret/email/`sheetId`)
- [x] Wallet-tap caller proven to reach the core and the webhook (placeholder run rejected, one-time Allow prompt granted)
- [x] MODE flipped to `live`; a non-purchase run returned "Not a purchase" and the owner's heartbeat updated
- [ ] First real charge on each source shows a core banner (Capital One, Amex, Bilt, each Chase card)

**Capital One (app notification)**
- [ ] Real text pasted through `--raw --card "Quicksilver Credit Card"`: amount, vendor, card `Capital One Quicksilver`
- [ ] Test mode (alias email + test `sheetId`): a real notification lands in the test copy; banner shows the ✅/🤔 message
- [ ] **Locked-phone test:** a real notification while the phone is locked and the screen is off still runs the automation (note the result here)
- [ ] Go live: delete `sheetId`, set `email` to the phone owner; one real charge lands **once** in the real sheet
- [x] Capital One and Apple Cash removed from the old Wallet Logger's card list

**Amex (Wallet notification)**
- [ ] Real text (a tap, ideally also an online purchase) through `--raw --card "American Express"`
- [ ] Test mode, locked-phone test, go live as above (`source: ios-notif-amex`)
- [ ] Only then remove Amex from the old Wallet Logger's card list

**Old Wallet Logger**
- [ ] Overlap phase: each remaining card deselected after its first real charge shows the core banner
- [ ] Old Wallet Logger deleted once empty
- [ ] One real Bilt purchase and one Chase purchase land once through "Wallet Bilt + Chase"

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
