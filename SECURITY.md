# Security Notes

## Token storage — PIN vs. biometric unlock

**PIN path**: the Google access token is AES-encrypted (PBKDF2-derived key) before
being stored in `sessionStorage`. An attacker who reads storage sees only ciphertext.

**Biometric (WebAuthn) path**: WebAuthn assertions authenticate the user but do not
yield stable key material suitable for encryption. The access token is therefore
stored in `sessionStorage` as plaintext when biometric unlock is active.

### Why this is accepted

- `sessionStorage` is same-origin and scoped to a single tab — it is cleared when
  the tab closes.
- An attacker would need an XSS vulnerability on the app's origin to read it.
- An XSS capable of reading storage could equally intercept the token from JS
  memory after decryption, so the encryption layer does not raise the bar
  meaningfully in that threat model.
- CSP (`style-src` aside) is configured to mitigate XSS.

### Decision

Accepted as a known architectural limitation (SEC-11, reviewed 2026-05-24).
Biometric unlock remains enabled; the convenience tradeoff is appropriate for this
app's threat model.

---

## Offline biometric session

When the PWA is reopened without an internet connection and a prior session exists,
`useAuth` loads a cached profile from `localStorage` (`budget_auth_cache`) after a
successful WebAuthn assertion (Face ID / fingerprint). This is distinct from the
PIN/biometric **lock screen** — it gates access to cached data when no live Google
session exists at all.

**What the offline session contains**
- `email`, `name`, `picture`, `role`, `expiresAt` (from last successful auth)
- No `accessToken` — no Google API calls can be made

**What it does not protect**
- `localStorage` itself is readable by anyone with physical device access and dev
  tools. The offline session's biometric gate protects the UI, not the raw storage.
- If biometric is not registered (no PIN was ever set), the offline session is not
  available — the user must be online to authenticate.

**Write queue behaviour**
Expenses added during an offline session are queued in `localStorage`
(`budget_offline_queue`). They are only synced to Google Sheets after a real
OAuth token is established (silent refresh on reconnect). No data reaches Google's
servers without a valid access token.

**Session upgrade**
When the `online` event fires, `useAuth` attempts a silent Google token refresh.
On success the offline session is replaced with a full session transparently.
On failure (wrong account, token revoked) the session stays offline until the user
explicitly signs in.

### Decision

Accepted. The biometric gate raises the bar meaningfully above "no gate at all" for
the primary threat model (unattended device), while the underlying `localStorage`
data was already accessible to anyone who could open dev tools regardless of the UI
gate. Reviewed 2026-05-27.
