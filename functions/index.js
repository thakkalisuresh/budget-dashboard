import { onRequest } from 'firebase-functions/v2/https';

// Health check — verifies the project, hosting rewrites, and deploy pipeline.
export const ping = onRequest({ region: 'us-central1' }, (req, res) => {
  res.json({ ok: true, service: 'fundient-dashboard' });
});

// Phase 3 — auth + Claude proxy (ported from Netlify edge functions).
export { verifyUser } from './verify-user.mjs';
export { claude } from './claude.mjs';

// Mobile biometric login — OAuth authorization-code broker (refresh token in Firestore).
export { googleToken } from './google-token.mjs';

// Phase 4 — Telegram bot webhook (WhatsApp out of scope).
export { telegramWebhook } from './telegram-webhook.mjs';

// Phase 5 — push notifications (Netlify Blobs → Firestore).
export { pushSubscribe } from './push-subscribe.mjs';
export { pushUnsubscribe } from './push-unsubscribe.mjs';
export { pushAlert } from './push-alert.mjs';

// Phase 6 — MCP server (JSON-RPC; rate-limit state Netlify Blobs → Firestore).
export { mcp } from './mcp-server.mjs';
