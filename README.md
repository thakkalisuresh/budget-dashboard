<div align="center">

<img src="src/assets/hero.png" alt="Fundient logo" width="110" />

# Fundient Budget Dashboard

**A personal budget dashboard backed by a Google Sheet you own.**
Track monthly spending by category, compare actual vs. budget, scan receipts with AI,
reconcile bank statements, and split household spending by person — all from a live
spreadsheet, with an offline-capable PWA on top.

[![CI](https://github.com/thakkalisuresh/budget-dashboard/actions/workflows/ci.yml/badge.svg)](https://github.com/thakkalisuresh/budget-dashboard/actions/workflows/ci.yml)
&nbsp;![React 19](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
&nbsp;![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)
&nbsp;![Tailwind CSS v4](https://img.shields.io/badge/Tailwind_CSS-v4-38BDF8?logo=tailwindcss&logoColor=white)
&nbsp;![Firebase](https://img.shields.io/badge/Firebase-Functions_%2B_Firestore-FFCA28?logo=firebase&logoColor=black)
&nbsp;![Google Sheets](https://img.shields.io/badge/data-Google_Sheets-34A853?logo=googlesheets&logoColor=white)
&nbsp;![Claude](https://img.shields.io/badge/AI-Anthropic_Claude-D97757?logo=anthropic&logoColor=white)
&nbsp;![PWA](https://img.shields.io/badge/PWA-offline_ready-5A0FC8?logo=pwa&logoColor=white)
&nbsp;![License: private](https://img.shields.io/badge/license-private-lightgrey)

</div>

---

## Table of Contents

- [Features](#features)
- [Screenshots](#screenshots)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Setup](#setup)
- [Testing](#testing)
- [Architecture](#architecture)
- [Deployment](#deployment)
- [Documentation](#documentation)
- [Security](#security)
- [Contributing](#contributing)
- [License](#license)

## Features

- ✅ **Budget vs. actual tracking** — per-category bars with gradient fill (green → amber → red by % spent)
- ✅ **Spending distribution** — animated donut chart with D3 arc morphing between months
- ✅ **Split by person** — separate household spending by who owns the card (you vs. partner) in a dedicated Split tab + an auto-updating "By Person" Google Sheet tab; owner is derived live from each card, so no tagging or backfill
- ✅ **Receipt scanning** — photograph a receipt and Claude extracts amount, vendor, and category
- ✅ **Bank reconciliation** — import CSV/PDF statements and match against recorded expenses
- ✅ **Card rewards engine** — MCC-based rewards per card, best-card-per-category recommendations, and a Cards analytics tab
- ✅ **AI chat** — ask questions about your budget in plain language
- ✅ **Mobile wallet capture** — iOS Shortcuts / Android MacroDroid forward payment notifications to a webhook that auto-categorizes and writes to the sheet
- ✅ **Offline PWA** — biometric unlock (Face ID / fingerprint) restores a cached dashboard with no internet; expenses queued offline sync on reconnect
- ✅ **Push notifications** — daily/weekly digests and over-budget alerts
- ✅ **Multi-user** — owner + viewer roles, shared access to the same sheet
- ✅ **Dark mode** — full light/dark support with a per-user OKLCH accent-colour picker
- ✅ **PIN lock + biometrics** — optional AES-encrypted session with auto-lock on background

## Screenshots

> _Dashboard, Split, and Cards captures will be added here._
> Drop images into [`docs/screenshots/`](docs/screenshots/) (see that folder's README for the suggested set + embed snippet).
<!-- Once captured, embed e.g.:
<p align="center"><img src="docs/screenshots/dashboard.png" width="80%" alt="Dashboard" /></p> -->

## Tech Stack

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

> **Tip:** set `VITE_DEV_MOCK=true` in `.env.local` to run the UI against mock data with no Google login (see [ENV.md](ENV.md)).

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

See [ENV.md](ENV.md) and [docs/ENV.md](docs/ENV.md) for the full list, including the server-side secrets stored in Firebase Secret Manager.

## Testing

```bash
npm test            # run all tests once (vitest)
npm run test:watch  # watch mode
```

## Architecture

A React SPA reads/writes a Google Sheet directly from the client; a small set of Firebase
Cloud Functions handle anything that needs a server secret (Claude proxy, auth verification,
push, the Telegram bot, the MCP server, and the wallet webhook). See
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the component map, data flow, sheet
schema, the card-rewards engine, and the offline/animation models.

## Deployment

Pushes to `main`/`develop` deploy to Firebase Hosting + Cloud Functions via GitHub Actions
(no build-minute billing). See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for Google Cloud
setup, VAPID keys, and Secret Manager configuration.

## Documentation

| Doc | What's in it |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Component map, data flow, sheet schema, card rewards, offline + animation models |
| [Environment Variables](docs/ENV.md) · [ENV.md](ENV.md) | All `VITE_*` and server-side vars; dev-mock mode |
| [Deployment](docs/DEPLOYMENT.md) | Google Cloud, VAPID, Firebase Secret Manager, CI deploy |
| [Security Model](docs/SECURITY-MODEL.md) | Auth, token encryption, CSP, input validation |
| [Security Notes](SECURITY.md) | Known tradeoffs and accepted limitations |
| [Contributing](CONTRIBUTING.md) | Dev setup, conventions, PR workflow |
| [Changelog](CHANGELOG.md) | Significant changes by milestone |

## Security

Auth uses Google OAuth with an allowlisted email set; access tokens can be AES-encrypted
behind a PIN/biometric lock. Server endpoints enforce origin + `sec-fetch-site` checks,
bearer verification, rate limits, and a model allowlist. Report anything sensitive privately
rather than opening a public issue — see [SECURITY.md](SECURITY.md).

## Contributing

This is a personal/household project, but the workflow is documented in
[CONTRIBUTING.md](CONTRIBUTING.md) (branch naming, commit conventions, running tests, and the
client ⇄ server rewards-table sync rule). PRs target `develop`; `main` is the deploy branch.

## License

Personal project — **all rights reserved**. Not currently released under an open-source
license. If you'd like to reuse any of it, please reach out first.
