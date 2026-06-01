# Environment Variables

## Client-side (Vite, prefixed with `VITE_`)

These are embedded in the client bundle at build time via `import.meta.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_GOOGLE_CLIENT_ID` | Yes | Google OAuth 2.0 client ID for login and Sheets/Drive API access |
| `VITE_SHEET_ID` | No | Default Google Sheet ID (fallback if no per-user sheet is set) |
| `VITE_TEMPLATE_SHEET_ID` | Yes | Template sheet ID copied when creating a new month |
| `VITE_VAPID_PUBLIC_KEY` | Yes | VAPID public key for Web Push subscription |
| `VITE_DEV_ACCESS_TOKEN` | No | Dev-only: bypasses Google OAuth in `import.meta.env.DEV` mode |

## Server-side (Netlify env vars)

Set these in Netlify dashboard > Site settings > Environment variables.

| Variable | Required | Used by | Description |
|----------|----------|---------|-------------|
| `ALLOWED_EMAILS` | Yes | verify-user, claude, _auth, _sheets | Comma-separated list of authorized email addresses |
| `VIEWER_EMAILS` | No | verify-user | Comma-separated emails with read-only access (subset of ALLOWED_EMAILS) |
| `ANTHROPIC_API_KEY` | Yes | claude | Anthropic API key for receipt scanning and chat |
| `VAPID_PUBLIC_KEY` | Yes | push-alert, push-digest | VAPID public key for Web Push |
| `VAPID_PRIVATE_KEY` | Yes | push-alert, push-digest | VAPID private key for Web Push |
| `VAPID_EMAIL` | Yes | push-alert, push-digest | Contact email for VAPID (e.g. `mailto:you@example.com`) |

## Not configured via env

- **Card reward rates** are pre-seeded in code, not environment variables. They live in `src/cardRewards.js` (client) and `netlify/functions/_card-rewards.mjs` (bot) — the two must be kept in sync. The cards list and card rules are per-user data stored in the `UserSettings` sheet, editable in Settings → Cards & Payment Methods.
- The Telegram/WhatsApp bot reads cards & rules from `UserSettings` via `getUserSettings()`; no extra env vars are needed for card tracking.

## Build-time

| Variable | Source | Description |
|----------|--------|-------------|
| `COMMIT_REF` | Netlify (auto) | Git commit hash, injected by `vite.config.js` as `__COMMIT_HASH__` for version display |

## Local Development

Create a `.env` file in the project root (gitignored):

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_TEMPLATE_SHEET_ID=your-template-sheet-id
VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
VITE_DEV_ACCESS_TOKEN=ya29.your-dev-token
```

Edge functions read from `Deno.env`, which Netlify CLI populates from the dashboard or a local `.env` file when running `netlify dev`.
