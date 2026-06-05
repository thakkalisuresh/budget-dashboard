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
- Ledger, History, and Cards tabs will show empty/error states (they make their own API calls; full mock support is a future phase)

## Notes

- `.env.local` is gitignored — never committed
- `.env` is committed and contains non-secret configuration only (no API keys or tokens)
- Production auth uses the server-side edge function (`netlify/functions/verify-user`) — `VITE_ALLOWED_EMAILS` is only a dev fallback
