/**
 * Netlify Edge Function — server-side email allowlist verification
 * Emails never live in the client bundle; checked against Netlify env var.
 */

const ALLOWED_ORIGINS = [
  'https://budget-dashboard-tracker.netlify.app',
  'http://localhost:5173',
];

export default async (request) => {
  const origin = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : null;

  if (request.method === 'OPTIONS') {
    if (!corsOrigin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (!corsOrigin) {
    return new Response(JSON.stringify({ allowed: false, error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let accessToken;
  try {
    const body = await request.json();
    accessToken = body.accessToken;
  } catch {
    return new Response(JSON.stringify({ allowed: false, error: 'Invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }

  if (!accessToken) {
    return new Response(JSON.stringify({ allowed: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }

  // Verify token with Google and get profile
  const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!googleRes.ok) {
    return new Response(JSON.stringify({ allowed: false, error: 'Token verification failed' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    });
  }

  const profile = await googleRes.json();
  const email = profile.email?.toLowerCase();

  // Check against server-side env var — never exposed to client
  const allowedEmails = new Set(
    (Deno.env.get('ALLOWED_EMAILS') || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );

  const allowed = allowedEmails.has(email);

  // Viewer emails can sign in but get read-only access
  const viewerEmails = new Set(
    (Deno.env.get('VIEWER_EMAILS') || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
  );
  const role = allowed ? (viewerEmails.has(email) ? 'viewer' : 'owner') : null;

  return new Response(
    JSON.stringify({
      allowed,
      email: allowed ? email : null,
      name: allowed ? profile.given_name : null,
      picture: allowed ? profile.picture : null,
      role,
      allowedEmails: allowed ? [...allowedEmails] : [],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': corsOrigin },
    }
  );
};

export const config = { path: '/api/verify-user' };
