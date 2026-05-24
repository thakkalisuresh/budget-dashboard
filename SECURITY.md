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
