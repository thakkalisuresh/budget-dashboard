import { onRequest } from 'firebase-functions/v2/https';

// Health check — verifies the project, hosting rewrites, and deploy pipeline.
export const ping = onRequest({ region: 'us-central1' }, (req, res) => {
  res.json({ ok: true, service: 'fundient-dashboard' });
});

// Phase 3 — auth + Claude proxy (ported from Netlify edge functions).
export { verifyUser } from './verify-user.mjs';
export { claude } from './claude.mjs';
