# Fundient Budget Dashboard

Personal budget dashboard built with React and backed by Google Sheets. Tracks monthly spending by category, compares actual vs. budget, surfaces insights, and supports bank reconciliation — all from a live spreadsheet you own.

## Features

- **Budget vs. actual tracking** — per-category bars with gradient fill (green → amber → red based on % spent)
- **Spending distribution** — animated donut chart with D3 arc morphing between months
- **Bank reconciliation** — import CSV/PDF bank statements and match against recorded expenses
- **Receipt scanning** — photograph a receipt and Claude extracts the amount, vendor, and category
- **AI chat** — ask questions about your budget in plain language
- **Offline PWA** — biometric unlock (Face ID / fingerprint) restores cached dashboard without internet; expenses queued offline sync automatically on reconnect
- **Push notifications** — daily/weekly spending digests and over-budget alerts
- **Split by person** — separates household spending by who owns the card (you vs. partner) in a dedicated Split tab, plus an auto-updating "By Person" Google Sheet tab; owner is derived live from each transaction's card, so no tagging or backfill
- **Multi-user** — owner + viewer roles, shared access to the same sheet
- **Dark mode** — full light/dark support with per-user accent colour picker
- **PIN lock + biometrics** — optional AES-encrypted session with auto-lock on background

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, Tailwind CSS v4 |
| Charts | D3.js (tree-shaken sub-packages) |
| Backend | Firebase Cloud Functions (2nd gen, Node 22) + Firestore |
| Data | Google Sheets API + Google Drive API |
| Auth | Google OAuth 2.0 (implicit flow) + WebAuthn |
| AI | Anthropic Claude (receipt scanning, statement parsing, chat) |
| PWA | Workbox service worker, Web Push (VAPID), Background Sync |

## Quick Start

```bash
nvm use           # Node 20+ (see .nvmrc)
npm install
cp .env.example .env   # fill in your credentials
npm run dev       # Vite dev server at localhost:5173
```

For API support (receipt scanning, auth verification, push, bot, MCP):

```bash
firebase emulators:start --only functions,hosting   # runs the /api/* Cloud Functions locally
```

## Setup

### 1. Google Cloud

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **Google Sheets API** and **Google Drive API**
3. Create an **OAuth 2.0 Client ID** (Web application)
   - Authorized origins: `http://localhost:5173`, `https://<your-project>.web.app`, `https://<your-project>.firebaseapp.com`
4. Copy the client ID → `VITE_GOOGLE_CLIENT_ID`

### 2. Google Sheet

Create a spreadsheet with your budget categories. Expected structure:

- Row 1: headers (`Expense`, `Actual`, `Remaining`, ...)
- Rows 2–N: one category per row
- Each month is a separate sheet tab named `Month YYYY` (e.g. `May 2026`)

Copy a working template sheet, or use an existing one. Its ID (from the URL) → `VITE_TEMPLATE_SHEET_ID`.

### 3. Environment variables

Create `.env` in the project root (gitignored):

```env
VITE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
VITE_TEMPLATE_SHEET_ID=your-template-sheet-id
VITE_VAPID_PUBLIC_KEY=your-vapid-public-key
```

See [docs/ENV.md](docs/ENV.md) for the full list including the server-side secrets (Firebase Secret Manager).

## Testing

```bash
npm test            # run all tests once
npm run test:watch  # watch mode
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — component map, data flow, offline model, animation architecture
- [Environment Variables](docs/ENV.md) — all `VITE_*` and server-side vars
- [Deployment](docs/DEPLOYMENT.md) — Google Cloud setup, VAPID keys, Firebase config (Secret Manager, CI deploy)
- [Security Model](docs/SECURITY-MODEL.md) — auth, token encryption, CSP, input validation
- [Security Notes](SECURITY.md) — known tradeoffs and accepted limitations
- [Contributing](CONTRIBUTING.md) — dev setup, conventions, PR workflow
- [Changelog](CHANGELOG.md) — significant changes by milestone
