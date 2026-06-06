/**
 * One-time script to obtain a Google OAuth refresh token for server-side use.
 * Run: node scripts/get-refresh-token.mjs
 * Requires: npm install googleapis open
 */

import { google } from 'googleapis';
import { createServer } from 'http';
import { createRequire } from 'module';
import { URL } from 'url';

const require = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REDIRECT_URI  = 'http://localhost:3000/oauth2callback';

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
];
// ─────────────────────────────────────────────────────────────────────────────

if (!CLIENT_ID) {
  console.error('\n❌  Set GOOGLE_CLIENT_ID before running:');
  console.error('    $env:GOOGLE_CLIENT_ID="your-client-id"  (PowerShell)');
  console.error('    export GOOGLE_CLIENT_ID="your-client-id" (bash)\n');
  process.exit(1);
}

if (!CLIENT_SECRET) {
  console.error('\n❌  Set GOOGLE_CLIENT_SECRET before running:');
  console.error('    $env:GOOGLE_CLIENT_SECRET="your-secret"  (PowerShell)');
  console.error('    export GOOGLE_CLIENT_SECRET="your-secret" (bash)\n');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',        // forces refresh_token to be returned every time
  scope: SCOPES,
});

console.log('\n🔗  Opening browser for Google consent...');
console.log('    If it does not open automatically, visit:\n');
console.log('   ', authUrl, '\n');

// Try to open the browser automatically
try {
  const { default: open } = await import('open').catch(() => ({ default: null }));
  if (open) await open(authUrl);
} catch { /* non-fatal */ }

// Spin up a one-shot local server to catch the redirect
await new Promise((resolve, reject) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:3000');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');

    if (error) {
      res.end('<h2>❌ Access denied. Close this tab and check the terminal.</h2>');
      server.close();
      reject(new Error(`OAuth error: ${error}`));
      return;
    }

    if (!code) {
      res.end('<h2>Waiting for authorization...</h2>');
      return;
    }

    try {
      const { tokens } = await oauth2Client.getToken(code);

      res.end('<h2>✅ Done! Refresh token printed in your terminal. You can close this tab.</h2>');
      server.close();

      console.log('\n✅  SUCCESS — copy this token into Netlify:\n');
      console.log('━'.repeat(60));
      console.log('GOOGLE_DRIVE_REFRESH_TOKEN =', tokens.refresh_token);
      console.log('━'.repeat(60));
      console.log('\n(Access token expires — only the refresh token above matters)\n');

      resolve();
    } catch (err) {
      res.end('<h2>❌ Token exchange failed. See terminal.</h2>');
      server.close();
      reject(err);
    }
  });

  server.listen(3000, () => {
    console.log('⏳  Waiting for Google to redirect to http://localhost:3000 ...');
  });

  server.on('error', reject);
});
