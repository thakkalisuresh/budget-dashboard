/**
 * Just-in-time Google Drive token.
 *
 * The default session only requests the Sheets scope (see LoginScreen.jsx).
 * Drive-scoped operations — copying the template, sharing files — request a
 * separate, transient access token via Google Identity Services here.
 *
 * The user will see the Google consent dialog the first time they create a new
 * month; subsequent requests are silent because Google remembers the grant.
 */

const CLIENT_ID  = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

let cached = null; // { token, expiresAt }

export async function requestDriveToken() {
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.token;
  }

  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google Identity not loaded — refresh the page');
  }

  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope:     DRIVE_SCOPE,
      prompt:    '', // silent if previously granted; consent shown only first time
      callback:  (resp) => {
        if (resp?.access_token) {
          cached = {
            token: resp.access_token,
            expiresAt: Date.now() + ((resp.expires_in ?? 3600) - 60) * 1000,
          };
          resolve(resp.access_token);
        } else {
          reject(new Error('Drive permission required to create or share month sheets'));
        }
      },
      error_callback: (e) => reject(new Error(e?.message || 'Drive permission denied')),
    });
    client.requestAccessToken();
  });
}

export function clearDriveTokenCache() {
  cached = null;
}
