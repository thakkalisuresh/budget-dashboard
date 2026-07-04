/**
 * Telegram Bot API transport helpers.
 * Ported from netlify/functions/_telegram.mjs. `validateTelegramWebhook` reads
 * the secret-token header via Express `req.get()` (was Web `req.headers.get()`)
 * and now compares in constant time. BOT_TOKEN/WEBHOOK_SECRET come from
 * process.env (injected by bound defineSecret params at cold start).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const TELEGRAM_API   = `https://api.telegram.org/bot${BOT_TOKEN}`;

const sha256 = (s) => createHash('sha256').update(String(s)).digest();

/* ── Webhook validation ── */

export function validateTelegramWebhook(req) {
  if (!WEBHOOK_SECRET) return false;
  const header = req.get('x-telegram-bot-api-secret-token');
  if (!header) return false;
  // Constant-time compare over fixed-length digests (avoids the length leak of
  // comparing raw strings of differing length).
  return timingSafeEqual(sha256(header), sha256(WEBHOOK_SECRET));
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

/* ── R10: button-driven expense editing ──
   callback_data is capped at 64 bytes and category/card names contain spaces, so
   pickers encode the choice as an INDEX into the caller-supplied list. */

/** Receipt confirmation keyboard — YES / CANCEL plus an Edit button. */
export function kbConfirmReceipt() {
  return [
    [
      { text: '✅ YES', callback_data: 'YES' },
      { text: '❌ CANCEL', callback_data: 'CANCEL' },
    ],
    [{ text: '✏️ Edit', callback_data: 'edit:menu' }],
  ];
}

/** Field picker for a pending (unconfirmed) receipt. */
export function kbEditMenu() {
  return [
    [
      { text: 'Category', callback_data: 'edit:f:cat' },
      { text: 'Amount',   callback_data: 'edit:f:amt' },
    ],
    [
      { text: 'Store', callback_data: 'edit:f:store' },
      { text: 'Date',  callback_data: 'edit:f:date' },
    ],
    [
      { text: 'Card', callback_data: 'edit:f:card' },
      { text: 'Tip',  callback_data: 'edit:f:tip' },
    ],
    [{ text: '⬅️ Back', callback_data: 'edit:back' }],
  ];
}

/** Category picker. `prefix` is e.g. 'edit:setcat' (pending) or 'edit:lastcat' (logged). */
export function kbCategoryPicker(categories, prefix) {
  const rows = [];
  for (let i = 0; i < categories.length; i += 2) {
    const row = [{ text: categories[i], callback_data: `${prefix}:${i}` }];
    if (i + 1 < categories.length) {
      row.push({ text: categories[i + 1], callback_data: `${prefix}:${i + 1}` });
    }
    rows.push(row);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'edit:back' }]);
  return rows;
}

/** Card picker (index -1 = clear/None). `prefix` is e.g. 'edit:setcard'. */
export function kbCardPicker(cards, prefix) {
  const rows = [];
  for (let i = 0; i < cards.length; i += 2) {
    const row = [{ text: cards[i], callback_data: `${prefix}:${i}` }];
    if (i + 1 < cards.length) {
      row.push({ text: cards[i + 1], callback_data: `${prefix}:${i + 1}` });
    }
    rows.push(row);
  }
  rows.push([
    { text: 'None', callback_data: `${prefix}:-1` },
    { text: '⬅️ Back', callback_data: 'edit:back' },
  ]);
  return rows;
}

/** Actions shown under a freshly-logged expense. */
export function kbLoggedActions() {
  return [[
    { text: '✏️ Edit', callback_data: 'edit:last' },
    { text: '↩️ Undo', callback_data: 'UNDO' },
  ]];
}

/** Field picker for an already-logged expense (category / amount only). */
export function kbEditLoggedMenu() {
  return [
    [
      { text: 'Category', callback_data: 'edit:lf:cat' },
      { text: 'Amount',   callback_data: 'edit:lf:amt' },
    ],
    [{ text: '❌ Cancel', callback_data: 'CANCEL' }],
  ];
}

/**
 * Inline keyboard for picking the category of one uncategorized split item.
 * Each button's callback_data is `SPLITCAT:<itemIndex>:<category>` (well under
 * Telegram's 64-byte limit). Categories are laid out two per row; an optional
 * AI-suggested category is pinned to the top row, prefixed with a ⭐.
 */
export function kbSplitCategory(itemIndex, categories, suggestion = null) {
  const rows = [];
  if (suggestion && categories.includes(suggestion)) {
    rows.push([{ text: `⭐ ${suggestion}`, callback_data: `SPLITCAT:${itemIndex}:${suggestion}` }]);
  }
  const rest = categories.filter(c => c !== suggestion);
  for (let i = 0; i < rest.length; i += 2) {
    const row = rest.slice(i, i + 2).map(c => ({ text: c, callback_data: `SPLITCAT:${itemIndex}:${c}` }));
    rows.push(row);
  }
  rows.push([{ text: '❌ CANCEL', callback_data: 'CANCEL' }]);
  return rows;
}
