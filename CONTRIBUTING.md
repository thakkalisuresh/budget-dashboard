# Contributing

## Dev Setup

```bash
nvm use        # Node 20+ required
npm install
cp .env.example .env   # fill in credentials — see docs/ENV.md
npm run dev    # Vite at localhost:5173
```

The `/api/*` endpoints (`/api/verify-user`, `/api/claude`, push, telegram, mcp)
are Firebase Cloud Functions — run them locally with the Firebase emulators:

```bash
firebase emulators:start --only functions,hosting
```

## Secret Phrase Gate

`CLAUDE.md` at the root enforces a session gate for AI-assisted work on this repo. Don't remove it.

## Project Structure

```
src/
  App.jsx                  # top-level orchestrator, ~30 state vars via hooks
  useAuth.js               # Google OAuth, session, PIN/biometric unlock
  useSheetData.js          # Sheets API fetch + localStorage cache
  useMonthSelection.js     # month navigation and creation
  useOfflineSync.js        # offline queue drain + background sync
  offlineQueue.js          # localStorage-backed write queue
  sheetsApi.js             # barrel re-export of 9 data modules
  sh*.js                   # individual sheet operation modules
  PinLock.jsx              # PIN hashing (PBKDF2), AES-GCM encryption, WebAuthn
  sw.js                    # Workbox service worker (precache + background sync)
functions/                 # Firebase Cloud Functions (2nd gen, Express onRequest)
  index.js                 # exports all 8 functions
  verify-user.mjs claude.mjs push-*.mjs telegram-webhook.mjs mcp-server.mjs
  lib/                     # secrets, http-common, firestore, bot-store, ported data layer
```

## Code Conventions

- **No comments by default.** Only add one when the WHY is non-obvious — a hidden constraint, a workaround, a subtle invariant. Never explain what the code does.
- **No error handling for impossible cases.** Only validate at system boundaries (user input, external APIs).
- **No premature abstractions.** Three similar lines is better than a helper that only gets called twice.
- **Tailwind for styling.** Avoid inline `style` props except for dynamic values that can't be expressed as class names (e.g. CSS custom properties like `--bar-pct`).
- **Named exports only.** No default exports for components.

## Testing

Tests live in `src/__tests__/`. Run with:

```bash
npm test
```

Tests use Vitest. Mock at the boundary — fake `fetch`, not internal modules. Don't mock the data layer when testing the data layer.

## Making Changes

1. Branch from `develop` (feature work merges to `develop`; `main` is the deploy target)
2. Run `npm test` before opening a PR — the full suite must pass
3. For visual changes: start the dev server (`npm run dev`) and verify in a browser before marking done
4. For Cloud Function changes: use `firebase emulators:start` to test locally — Vite alone won't run them
5. Never commit `.env`, `.env.local`, or any file containing secrets

## Commit Style

Short imperative subject line, present tense. No trailing period. Body optional (use for non-obvious context).

```
Add biometric offline unlock

Allows PWA to load cached dashboard via Face ID / fingerprint when
reopened without internet, instead of blocking on Google OAuth.
```

No `Co-Authored-By` trailers.

## PR Checklist

- [ ] `npm test` passes
- [ ] Tested in Chrome (desktop) and Safari (iOS) if touching auth, PWA, or animations
- [ ] `docs/ARCHITECTURE.md` updated if a hook, component, or data flow changed
- [ ] `SECURITY.md` or `docs/SECURITY-MODEL.md` updated if touching auth, token storage, or CSP
- [ ] `CHANGELOG.md` entry added for user-visible changes
- [ ] No new `.env` values without updating `docs/ENV.md` and `.env.example`

## Deployment

CI auto-deploys to Firebase on push to `main` or `develop` (the `deploy-live`
job in `.github/workflows/ci.yml`). Manual deploy:

```bash
firebase deploy --only functions,hosting --project <your-project>
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for full setup.
