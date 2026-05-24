# Security Model

This document describes the security architecture of the Fundient Budget Dashboard.

## Authentication

### Google OAuth 2.0
- Users authenticate via Google OAuth 2.0 (implicit flow via `@react-oauth/google`)
- Access tokens are validated server-side against Google's userinfo endpoint
- Email addresses are checked against the `ALLOWED_EMAILS` env var (server-side, never in client bundle)
- `VIEWER_EMAILS` grants read-only access (a subset of ALLOWED_EMAILS)

### Token Validation Caching
- Edge functions cache validated tokens by SHA-256 hash (never raw tokens) for 5 minutes
- Failed tokens are cached separately with a 30-second TTL and a 50-entry cap to prevent cache poisoning (SEC-15)
- Valid tokens use a 500-entry cap with FIFO eviction

### Session Management
- Access tokens are stored in `sessionStorage` (tab-scoped, cleared on tab close)
- Session expiry triggers a silent refresh attempt, then sign-out

## Encryption at Rest

### PIN Lock (optional)
- PIN is hashed with PBKDF2 (200,000 iterations, SHA-256, random 32-byte salt)
- A separate salt derives an AES-256-GCM key from the PIN
- The Google access token is encrypted with this key before storage
- Brute-force protection: 5 attempts per 24h window, persisted in localStorage

### Biometric Unlock (optional)
- Uses WebAuthn for user verification
- WebAuthn assertions do not yield key material, so the token remains in plaintext in `sessionStorage` when biometric is active
- This is an accepted architectural limitation (see [SECURITY.md](../SECURITY.md))

## Authorization

### Edge Functions
- `/api/verify-user`: validates token, returns role (owner/viewer)
- `/api/claude`: requires valid Bearer token + allowlisted email
  - Model allowlist: only `claude-haiku-4-5`
  - `max_tokens` capped at 4096
  - Request body capped at 8MB
  - `sec-fetch-site` header required (blocks non-browser requests like curl)

### Rate Limiting
- IP-based: 20 requests/minute (stops unauthenticated floods)
- Email-based: 10 requests/minute (tighter cap on authenticated users)
- Both use sliding window with FIFO eviction at 500 entries

## Content Security

### CSP (Content-Security-Policy)
Configured in `netlify.toml`:
- `script-src 'self'` (no unsafe-inline for scripts)
- `style-src 'self' 'unsafe-inline'` (required for runtime accent color injection)
- `connect-src` allowlists googleapis.com, open.er-api.com, accounts.google.com
- `frame-ancestors 'none'` (clickjacking prevention)
- `object-src 'none'`, `base-uri 'self'`

### Additional Headers
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Strict-Transport-Security` with preload
- `Referrer-Policy: strict-origin-when-cross-origin`

## Input Validation

### Formula Injection
- `safeText()` prefixes dangerous characters (`=`, `+`, `-`, `@`, `\r`, `\n`, `\t`) with a single quote before writing to Sheets
- Also catches formulas hidden after leading whitespace (SEC-09)

### File Upload
- MIME type validated via magic bytes (not file extension)
- Allowed types: JPEG, PNG, GIF, WebP, HEIC, PDF
- PDF size capped at 5MB
- Images compressed to max 1600px before sending to Claude

### FX Rates
- Plausibility bounds for known currencies prevent malicious rate injection
- Last known good rate cached for 24h as fallback

## Offline Security
- Service Worker caches Sheets API responses with NetworkFirst strategy
- Cache entries limited to 50 items, max age 1 hour (SEC-05)
- All caches and IndexedDB are cleared on sign-out (awaited to prevent stale data race)

## Secrets Management
- `.env` is gitignored and was never committed (verified via `git log --all --full-history -- .env`)
- `ANTHROPIC_API_KEY` only exists server-side (edge function env)
- `VITE_DEV_ACCESS_TOKEN` is gated on `import.meta.env.DEV` (stripped in production builds)
