import { onRequest } from 'firebase-functions/v2/https';

// Placeholder function to verify the Firebase project, hosting rewrites,
// and deploy pipeline before the real functions are ported in later phases.
export const ping = onRequest((req, res) => {
  res.json({ ok: true, service: 'fundient-dashboard' });
});
