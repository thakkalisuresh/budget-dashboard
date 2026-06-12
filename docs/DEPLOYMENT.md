# Deployment Guide

## Prerequisites

- Node.js >= 20 (see `.nvmrc`)
- A Google Cloud project with OAuth 2.0 and the Sheets + Drive APIs enabled
- A Firebase project on the **Blaze** plan (required for 2nd-gen Cloud Functions; usage for a single household stays inside the free tier)
- An Anthropic API key (for receipt scanning / chat)
- VAPID keys (for push notifications)

## Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Google Sheets API** and **Google Drive API**
4. Go to **APIs & Services > Credentials**
5. Create an **OAuth 2.0 Client ID** (Web application type)
   - Authorized JavaScript origins: `https://<your-project>.web.app`, `https://<your-project>.firebaseapp.com`, `http://localhost:5173`
   - (The app uses the implicit token flow — no authorized redirect URIs are needed for login. `http://localhost:3000/oauth2callback` is only required if you run `scripts/get-refresh-token.mjs` to mint the server-side Drive refresh token.)
6. Copy the Client ID -- this becomes `VITE_GOOGLE_CLIENT_ID`

### OAuth Consent Screen
- Set to **External** (or Internal if using Google Workspace)
- Add scopes: `openid`, `email`, `profile`, `https://www.googleapis.com/auth/spreadsheets`, `https://www.googleapis.com/auth/drive.file`
- Add test users if the app is in "Testing" mode

### Template Sheet
1. Create a Google Sheet with the budget template structure (categories in columns, months as tabs)
2. Copy the sheet ID from the URL -- this becomes `VITE_TEMPLATE_SHEET_ID`

## VAPID Keys

Generate a VAPID key pair for Web Push:

```bash
npx web-push generate-vapid-keys
```

This gives you `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`.

## Firebase Setup

Hosting (`dist/`) and the API (Cloud Functions, 2nd gen) live in one Firebase
project. Routing, headers, and the `/api/*` → function rewrites are declared in
`firebase.json`; Firestore lock-down is in `firestore.rules` (default-deny — all
data access goes through the Admin SDK in functions).

1. Create a Firebase project and upgrade it to the **Blaze** plan.
2. Enable the **Cloud Billing API** and **Secret Manager API** on the underlying
   GCP project.
3. **Server secrets → Secret Manager.** Every server-side value (see
   [ENV.md](ENV.md)) is a `defineSecret()` param declared in
   `functions/lib/secrets.mjs`. Set each one:
   ```bash
   firebase functions:secrets:set ALLOWED_EMAILS   # repeat per secret
   ```
   (The Secret Manager web console is faster if the CLI is slow on your machine.)
   Firebase requires a value for **every** declared secret at deploy time.
4. **Client `VITE_*` vars → GitHub repository variables.** These are baked into
   the client bundle at build time and are non-secret. In the GitHub repo:
   *Settings → Secrets and variables → Actions → Variables*, set
   `VITE_SHEET_ID`, `VITE_TEMPLATE_SHEET_ID`, `VITE_GOOGLE_CLIENT_ID`,
   `VITE_ALLOWED_EMAILS`, `VITE_VAPID_PUBLIC_KEY`. The CI workflow injects them
   into `npm run build`.
5. **CI deploy service account.** Create a GCP service account for CI, download a
   JSON key, and add it as the `FIREBASE_SERVICE_ACCOUNT` GitHub **secret**. Grant
   it: `roles/firebase.admin`, `roles/secretmanager.admin`, Cloud Functions
   Developer, Cloud Run Admin, Firebase Hosting Admin, Artifact Registry Writer,
   Service Account User. (Secret Manager Admin is required because the deploy
   grants the runtime SA `secretAccessor` on each bound secret via
   `setIamPolicy`.)

## Local Development

```bash
# Install dependencies
npm install

# Start dev server (Vite + HMR) on localhost:5173
npm run dev

# Run the Cloud Functions + hosting locally (needs the Firebase CLI + emulators)
firebase emulators:start --only functions,hosting
```

`npm run dev` alone serves the SPA; the `/api/*` endpoints (`/api/claude`,
`/api/verify-user`, push, telegram, mcp) only run under the emulator, which reads
secrets from a local `functions/.secret.local` or your shell env.

## Build and Preview

```bash
npm run build      # Production build to dist/
npm run preview    # Serve the production build locally
```

## Deployment

CI (`.github/workflows/ci.yml`) auto-deploys on push to `main` or `develop`: the
`deploy-live` job builds `dist/`, installs `functions/` deps, and runs
`firebase deploy --only functions,hosting`. Pull requests get a hosting preview
channel. Manual deploy:

```bash
firebase deploy --only functions,hosting --project <your-project>
```

## Post-Deploy Checklist

- [ ] Verify OAuth login works (check allowed origins match the `*.web.app` URL)
- [ ] Verify `/api/verify-user` returns `allowed: true` for your email
- [ ] Verify receipt scanning works (tests the Claude proxy)
- [ ] Verify push notifications are delivered (re-subscribe if VAPID keys rotated)
- [ ] Verify the Telegram webhook points at the deployed function
- [ ] Check security headers at [securityheaders.com](https://securityheaders.com)
