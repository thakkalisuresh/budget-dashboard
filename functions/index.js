import { onRequest } from 'firebase-functions/v2/https';

// Health check — verifies the project, hosting rewrites, and deploy pipeline.
export const ping = onRequest({ region: 'us-central1' }, (req, res) => {
  res.json({ ok: true, service: 'fundient-dashboard' });
});

// Phase 3 — auth + Claude proxy.
export { verifyUser } from './verify-user.mjs';
export { claude } from './claude.mjs';

// Mobile biometric login — OAuth authorization-code broker (refresh token in Firestore).
export { googleToken } from './google-token.mjs';

// Phase 4 — Telegram bot webhook (WhatsApp out of scope).
export { telegramWebhook } from './telegram-webhook.mjs';

// Phase 5 — push notifications (subscriptions in Firestore).
export { pushSubscribe } from './push-subscribe.mjs';
export { pushUnsubscribe } from './push-unsubscribe.mjs';
export { pushAlert } from './push-alert.mjs';

// Phase 6 — MCP server (JSON-RPC; rate-limit state in Firestore).
export { mcp } from './mcp-server.mjs';

// Phase 7 — wallet webhook (iOS Shortcuts / Android MacroDroid).
export { walletWebhook } from './wallet-webhook.mjs';

// Batched LLM categorization of receipt line items (split-receipt screen).
export { itemCategorize } from './item-categorize.mjs';

// Weekly LLM category audit (scheduled).
export { categoryAudit } from './category-audit.mjs';

// Daily backend error digest (scheduled). See docs/ERROR_CODES.md.
export { errorDigest } from './error-digest.mjs';
