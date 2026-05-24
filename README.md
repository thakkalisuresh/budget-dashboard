# Fundient Budget Dashboard

Personal budget tracking dashboard built with React, backed by Google Sheets.

## Stack

- **Frontend**: React 19, Vite 8, Tailwind CSS 4, D3.js
- **Backend**: Netlify Edge Functions (Deno) + Netlify Functions (Node.js)
- **Data**: Google Sheets API + Google Drive API
- **AI**: Anthropic Claude (receipt scanning, statement parsing, chat)
- **PWA**: Workbox service worker, Web Push notifications

## Quick Start

```bash
nvm use           # Node 20+ (see .nvmrc)
npm install
npm run dev       # Vite dev server on :5173
```

For edge function support: `npx netlify dev`

## Documentation

- [Architecture Overview](docs/ARCHITECTURE.md)
- [Security Model](docs/SECURITY-MODEL.md)
- [Environment Variables](docs/ENV.md)
- [Deployment Guide](docs/DEPLOYMENT.md)
- [Security Notes](SECURITY.md) (biometric token tradeoff)

## Testing

```bash
npm test          # 86 tests across 5 suites
npm run test:watch
```
