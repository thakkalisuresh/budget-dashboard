/**
 * Telegram Bot API transport helpers.
 * Ported from netlify/functions/_telegram.mjs. Only `validateTelegramWebhook`
 * changed — it reads the secret-token header via Express `req.get()` instead of
 * the Web `req.headers.get()`. BOT_TOKEN/WEBHOOK_SECRET come from process.env
 * (injected by bound defineSecret params at cold start).
 */

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_API   = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* ── Webhook validation ── */

export function validateTelegramWebhook(req) {
  if (!WEBHOOK_SECRET) return false;
  const header = req.get('x-telegram-bot-api-secret-token');
  return header === WEBHOOK_SECRET;
}

/* ── Send messages ── */

export async function sendMessage(chatId, text, markup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (markup) {
    body.reply_markup = { inline_keyboard: markup };
  }

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('telegram sendMessage failed:', err.description || res.status);
  }
  return res;
}

/* ── Answer callback query (clears button spinner) ── */

export async function answerCallback(callbackQueryId) {
  const res = await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('telegram answerCallbackQuery failed:', err.description || res.status);
  }
  return res;
}

/* ── Download file (for receipt photos / PDFs) ── */

export async function downloadTelegramFile(fileId) {
  // Step 1: get file path
  const infoRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) {
    throw new Error(`getFile failed: HTTP ${infoRes.status}`);
  }
  const info = await infoRes.json();
  const filePath = info.result?.file_path;
  if (!filePath) throw new Error('No file_path in getFile response');

  // Step 2: download the file bytes
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`File download failed: HTTP ${fileRes.status}`);
  }

  return fileRes.arrayBuffer();
}

/* ── User whitelist ── */

export function isAllowedUser(userId, allowedList) {
  if (!allowedList || allowedList.length === 0) return false;
  return allowedList.includes(String(userId));
}

/* ── Inline keyboard builders ── */

export function kbYesCancel() {
  return [[
    { text: '✅ YES', callback_data: 'YES' },
    { text: '❌ CANCEL', callback_data: 'CANCEL' },
  ]];
}

export function kbYesSkip() {
  return [[
    { text: '✅ YES', callback_data: 'YES' },
    { text: '⏭ SKIP', callback_data: 'SKIP' },
  ]];
}

export function kbConfirmDelete() {
  return [[
    { text: '🗑 CONFIRM DELETE', callback_data: 'CONFIRM DELETE' },
    { text: '❌ CANCEL', callback_data: 'CANCEL' },
  ]];
}
