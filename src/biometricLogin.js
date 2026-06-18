export const LOGIN_BIOMETRIC_KEY = 'budget_biometric_login_id';

function b64encode(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function b64decode(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

export function isLoginBiometricRegistered() {
  return !!localStorage.getItem(LOGIN_BIOMETRIC_KEY);
}

export async function registerLoginBiometric(email) {
  try {
    const available = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!available) return null;

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'Budget Dashboard', id: window.location.hostname },
        user: {
          id: new TextEncoder().encode('budget-login-user-v1'),
          name: email || 'user',
          displayName: email || 'Budget User',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60000,
      },
    });

    if (!credential) return null;
    const id = b64encode(credential.rawId);
    localStorage.setItem(LOGIN_BIOMETRIC_KEY, id);
    return id;
  } catch {
    return null;
  }
}

export async function verifyLoginBiometric() {
  const stored = localStorage.getItem(LOGIN_BIOMETRIC_KEY);
  if (!stored) return false;
  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{
          type: 'public-key',
          id: b64decode(stored),
          transports: ['internal'],
        }],
        userVerification: 'required',
        timeout: 60000,
      },
    });
    return !!credential;
  } catch (err) {
    if (err?.name === 'InvalidStateError') {
      localStorage.removeItem(LOGIN_BIOMETRIC_KEY);
    }
    return false;
  }
}

export function clearLoginBiometric() {
  localStorage.removeItem(LOGIN_BIOMETRIC_KEY);
}
