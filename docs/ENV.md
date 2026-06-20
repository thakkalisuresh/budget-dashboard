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

## Server-side (Firebase Secret Manager)

Declared as `defineSecret()` params in `functions/lib/secrets.mjs` and injected
into `process.env` at function cold start. Set each with
`firebase functions:secrets:set <NAME>` (or the Secret Manager web console).
Firebase requires a value for **every** declared secret at deploy time.

| Variable | Required | Used by | Description |
|----------|----------|---------|-------------|
| `ALLOWED_EMAILS` | Yes | verify-user, claude, push-*, bot, mcp | Comma-separated list of authorized email addresses |
| `VIEWER_EMAILS` | No | verify-user | Comma-separated emails with read-only access (subset of ALLOWED_EMAILS) |
| `ANTHROPIC_API_KEY` | Yes | claude, bot | Anthropic API key for receipt scanning and chat |
| `GEMINI_API_KEY` | Yes | bot | Gemini API key for receipt/wallet image extraction |
| `GOOGLE_CLIENT_ID` | Yes | bot, mcp (Sheets/Drive) | OAuth client ID for the server-side refresh-token flow |
| `GOOGLE_CLIENT_SECRET` | Yes | bot, mcp (Sheets/Drive) | OAuth client secret for the refresh-token flow |
| `GOOGLE_DRIVE_REFRESH_TOKEN` | Yes | bot, mcp (Sheets/Drive) | Long-lived refresh token (mint via `scripts/get-refresh-token.mjs`) |
| `VITE_TEMPLATE_SHEET_ID` | Yes | bot, mcp | Template sheet ID (kept in Secret Manager so lib modules need no config file) |
| `VAPID_PUBLIC_KEY` | Yes | push-alert | VAPID public key for Web Push |
| `VAPID_PRIVATE_KEY` | Yes | push-alert | VAPID private key for Web Push |
| `VAPID_EMAIL` | Yes | push-alert | Contact email for VAPID (e.g. `mailto:you@example.com`) |
| `TELEGRAM_BOT_TOKEN` | Yes | telegram | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | telegram | Shared secret echoed in `x-telegram-bot-api-secret-token` |
| `TELEGRAM_ALLOWED_USERS` | Yes | telegram | Comma-separated numeric Telegram user IDs |
| `MCP_API_KEY` | Yes | mcp | Shared bearer key for the MCP server endpoint |
| `WALLET_WEBHOOK_SECRET` | Yes | wallet | Shared API key for the wallet webhook (`/api/wallet`). Set with `firebase functions:secrets:set WALLET_WEBHOOK_SECRET` |

The five `VITE_*` client values are **not** Secret Manager secrets — in CI they
come from GitHub repository variables (see below); they are baked into the public
client bundle and are non-secret by design.

## Not configured via env

- **Card reward rates** — the default rate table is hardcoded in `src/cardRewards.js` (client) and `functions/lib/_card-rewards.mjs` (bot); both must stay in sync (enforced by `cardRewardsSync.test.js`). User overrides are stored in `UserSettings.cardRewardRates` and applied via `getEffectiveRates(settings)` — no env var needed.
- The cards list, card rules, and reward-rate overrides are per-user data in the `UserSettings` sheet, editable in Settings → Cards & Payment Methods.

## CI / build-time

The five client values come from **GitHub repository variables** (Settings →
Secrets and variables → Actions → Variables), injected into `npm run build` by
`.github/workflows/ci.yml`: `VITE_SHEET_ID`, `VITE_TEMPLATE_SHEET_ID`,
`VITE_GOOGLE_CLIENT_ID`, `VITE_ALLOWED_EMAILS`, `VITE_VAPID_PUBLIC_KEY`.

| Variable | Source | Description |
|----------|--------|-------------|
| `GITHUB_SHA` | GitHub Actions (auto) | Full commit SHA; `vite.config.js` slices it to 7 chars as `__COMMIT_SHA__` for version display. Falls back to local `git rev-parse` for dev builds. |

## Local Development

Create a `.env` file in the project root (gitignored):

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_TEMPLATE_SHEET_ID=your-template-sheet-id
VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
VITE_DEV_ACCESS_TOKEN=ya29.your-dev-token
```

The Cloud Functions read from `process.env`, populated by Secret Manager in
production. Locally, `firebase emulators:start` reads `functions/.secret.local`
(or your shell env) for the same names.
