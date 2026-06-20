/**
 * Central registry of Cloud Functions 2nd-gen secrets (Secret Manager-backed).
 *
 * Each `defineSecret(NAME)` declares intent only — it does NOT require the
 * secret to exist until a function that lists it in its `secrets: [...]` option
 * is deployed. Set values with:  firebase functions:secrets:set NAME
 *
 * When a function binds a secret here, its plaintext value is injected into
 * `process.env.<NAME>` for that instance at cold start. That is why the ported
 * lib modules (_sheets, _drive, _query, _extraction, _auth) can keep reading
 * `process.env.X` unchanged — no per-module refactor needed.
 *
 * Names match the original Netlify env var names exactly (including the legacy
 * VITE_ prefix on VITE_TEMPLATE_SHEET_ID) so the lib modules stay byte-identical
 * to their source and behave the same.
 */
import { defineSecret } from 'firebase-functions/params';

// ── Google Sheets / Drive (OAuth refresh-token flow) ───────────────────────
export const GOOGLE_CLIENT_ID         = defineSecret('GOOGLE_CLIENT_ID');
export const GOOGLE_CLIENT_SECRET     = defineSecret('GOOGLE_CLIENT_SECRET');
export const GOOGLE_DRIVE_REFRESH_TOKEN = defineSecret('GOOGLE_DRIVE_REFRESH_TOKEN');
// Template sheet ID is technically a data ID, but kept in Secret Manager so the
// lib modules need no committed config file and stay verbatim (read at top level).
export const VITE_TEMPLATE_SHEET_ID   = defineSecret('VITE_TEMPLATE_SHEET_ID');

// ── Access control ─────────────────────────────────────────────────────────
export const ALLOWED_EMAILS = defineSecret('ALLOWED_EMAILS');
export const VIEWER_EMAILS  = defineSecret('VIEWER_EMAILS');

// ── AI providers ───────────────────────────────────────────────────────────
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
export const GEMINI_API_KEY    = defineSecret('GEMINI_API_KEY');

// ── Web Push (VAPID) ───────────────────────────────────────────────────────
export const VAPID_PUBLIC_KEY  = defineSecret('VAPID_PUBLIC_KEY');
export const VAPID_PRIVATE_KEY = defineSecret('VAPID_PRIVATE_KEY');
export const VAPID_EMAIL       = defineSecret('VAPID_EMAIL');

// ── Telegram bot (bound in Phase 4) ────────────────────────────────────────
export const TELEGRAM_BOT_TOKEN      = defineSecret('TELEGRAM_BOT_TOKEN');
export const TELEGRAM_WEBHOOK_SECRET = defineSecret('TELEGRAM_WEBHOOK_SECRET');
export const TELEGRAM_ALLOWED_USERS  = defineSecret('TELEGRAM_ALLOWED_USERS');

// NOTE: WhatsApp/Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// WHATSAPP_ALLOWED_PHONES) are intentionally NOT declared — WhatsApp is out of
// scope for this migration. Firebase requires a value for every declared
// secret at deploy time, so declaring unset secrets blocks deploys. Re-add
// here (and set the values) if WhatsApp is ever revived.

// ── MCP server (bound in Phase 6) ──────────────────────────────────────────
export const MCP_API_KEY = defineSecret('MCP_API_KEY');

// ── Wallet webhook (iOS Shortcuts / Android MacroDroid) ──────────────────
export const WALLET_WEBHOOK_SECRET = defineSecret('WALLET_WEBHOOK_SECRET');

/** Secrets needed by any function that touches the Sheets/Drive data layer. */
export const SHEETS_DRIVE_SECRETS = [
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_DRIVE_REFRESH_TOKEN,
  VITE_TEMPLATE_SHEET_ID,
  ALLOWED_EMAILS,
];
