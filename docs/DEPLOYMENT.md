# Deployment Guide

## Prerequisites

- Node.js >= 20 (see `.nvmrc`)
- A Google Cloud project with OAuth 2.0 and the Sheets + Drive APIs enabled
- A Netlify account
- An Anthropic API key (for receipt scanning / chat)
- VAPID keys (for push notifications)

## Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Google Sheets API** and **Google Drive API**
4. Go to **APIs & Services > Credentials**
5. Create an **OAuth 2.0 Client ID** (Web application type)
   - Authorized JavaScript origins: `https://your-site.netlify.app`, `http://localhost:5173`
   - Authorized redirect URIs: same as origins
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

## Netlify Setup

1. Connect the repo to Netlify (or use `netlify init`)
2. Build settings (auto-detected from `netlify.toml`):
   - Build command: `npm run build`
   - Publish directory: `dist`
3. Set environment variables in **Site settings > Environment variables**:
   - All variables from [ENV.md](ENV.md) (server-side section)
   - All `VITE_*` variables (client-side section)

## Local Development

```bash
# Install dependencies
npm install

# Start dev server (Vite + HMR)
npm run dev

# Or use Netlify CLI for edge function support
npx netlify dev
```

`npm run dev` starts Vite on port 5173. Edge functions (`/api/claude`, `/api/verify-user`) require `netlify dev` to work locally.

## Build and Preview

```bash
npm run build      # Production build to dist/
npm run preview    # Serve the production build locally
```

## Deployment

Netlify auto-deploys on push to the connected branch. Manual deploy:

```bash
npx netlify deploy --prod
```

## Post-Deploy Checklist

- [ ] Verify OAuth login works (check allowed origins match the deployed URL)
- [ ] Verify `/api/verify-user` returns `allowed: true` for your email
- [ ] Verify receipt scanning works (tests the Claude proxy)
- [ ] Verify push notifications are delivered (check VAPID config)
- [ ] Check security headers at [securityheaders.com](https://securityheaders.com)
