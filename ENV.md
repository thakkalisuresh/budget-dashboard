# Environment Variables

## Production (`.env`)

| Variable | Description |
|---|---|
| `VITE_SHEET_ID` | Google Sheets ID of the Months registry (template sheet) |
| `VITE_TEMPLATE_SHEET_ID` | Google Sheets ID used as template for new months |
| `VITE_GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `VITE_ALLOWED_EMAILS` | Comma-separated list of allowed user emails (fallback for dev; server-side in production) |
| `VITE_VAPID_PUBLIC_KEY` | Web Push VAPID public key for push notification subscriptions |

## Local development (`.env.local`)

| Variable | Description |
|---|---|
| `VITE_DEV_MOCK` | Set to `true` to enable full mock mode — no Google auth, no API calls, instant fake data |
| `VITE_DEV_ACCESS_TOKEN` | A real Google OAuth access token — skips the login popup but still hits real APIs |

## Mock mode (`VITE_DEV_MOCK=true`)

When `VITE_DEV_MOCK=true`, the app:
- Auto-logs in as a fake user (`demo@fundient.app / Anupa`) with no real token
- Serves fake June 2026 budget data from `src/mockData.js` (mixed budget states — some over, some under, one at limit)
- Serves fake month list: June 2026, May 2026, April 2026
- Uses `DEFAULT_SETTINGS` (no sheet reads, onboarding skipped)
- Blocks all API writes (`saveUserSettings` is a no-op)
- Ledger, History, Cards, and Split tabs will show empty/error states (they make their own API calls; full mock support is a future phase)

## Cloud Functions (server-side, via Secret Manager / function env)

These are read by the bot webhooks (`functions/`), not baked into the client bundle.

| Variable | Description |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API token |
| `TELEGRAM_WEBHOOK_SECRET` | Shared secret validated on every webhook call |
| `TELEGRAM_ALLOWED_USERS` | Comma-separated allowed Telegram user IDs |
| `ANTHROPIC_API_KEY` | Claude API key (receipt extraction fallback + conversational agent) |
| `GEMINI_API_KEY` | Gemini API key (primary receipt extraction) |
| `GROQ_API_KEY` | Groq API key (free first tier for budget queries) |
| `BOT_AGENT_MODEL` | *(optional)* Claude model for the conversational agent fallback. Defaults to `claude-haiku-4-5` — fast + cheap, suited to per-message routing/lookups. Override to trade cost for capability (e.g. `claude-sonnet-5`). |

### One-time Firestore TTL for idempotency markers

The Telegram webhook writes `seen:<update_id>` docs (in the `bot_state` collection) to dedupe retries; each carries an `expireAt` Timestamp. Enable the native TTL policy once so they auto-purge (no other `bot_state` doc has this field, so only seen markers are affected):

```sh
gcloud firestore fields ttls update expireAt \
  --collection-group=bot_state --enable-ttl
```

## Notes

- `.env` and `.env.local` are both gitignored — never committed. In CI the `VITE_*` values come from GitHub repository variables (non-secret; baked into the public client bundle).
- Production auth uses the server-side Cloud Function (`functions/verify-user.mjs`, checking Secret Manager `ALLOWED_EMAILS`) — `VITE_ALLOWED_EMAILS` is only a dev/client-UX fallback.
