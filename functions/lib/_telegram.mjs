/**
 * Telegram Bot API transport helpers.
 * `validateTelegramWebhook` reads the secret-token header via Express
 * `req.get()` and compares in constant time. BOT_TOKEN/WEBHOOK_SECRET come from
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
    console.error('TG-001 — Telegram sendMessage failed:', err.description || res.status);
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
    console.error('TG-001 — Telegram answerCallbackQuery failed:', err.description || res.status);
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

/**
 * Confirmation for something we think is already logged. Same callback_data as
 * kbYesCancel — the confirm handler is unchanged — but the affirmative button
 * is relabelled so accepting a duplicate is a deliberate act, not the same
 * reflex tap as a normal receipt.
 */
export function kbLogAnywayCancel() {
  return [[
    { text: '⚠️ Log anyway', callback_data: 'YES' },
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

/**
 * Duplicate-suspect variant of kbConfirmReceipt. Same callback_data throughout,
 * so the handlers are untouched; only the affirmative label changes, matching
 * how kbLogAnywayCancel relates to kbYesCancel.
 *
 * Exists because kbYesCancel/kbLogAnywayCancel are shared with the salary,
 * budget, new-month and split flows, where an Edit button would be meaningless —
 * so the Edit row is added here rather than to those.
 */
export function kbLogAnywayReceipt() {
  return [
    [
      { text: '⚠️ Log anyway', callback_data: 'YES' },
      { text: '❌ CANCEL', callback_data: 'CANCEL' },
    ],
    [{ text: '✏️ Edit', callback_data: 'edit:menu' }],
  ];
}

/**
 * Confirmation for one item of a multi-transaction batch.
 *
 * SKIP drops only this item and moves to the next; CANCEL ALL abandons the whole
 * queue. Plain CANCEL is deliberately absent: it used to wipe every queued item,
 * so the destructive action now has to be named explicitly.
 */
export function kbBatchReceipt() {
  return [
    [
      { text: '✅ YES', callback_data: 'YES' },
      { text: '⏭ SKIP', callback_data: 'SKIP' },
    ],
    [
      { text: '✏️ Edit', callback_data: 'edit:menu' },
      { text: '❌ CANCEL ALL', callback_data: 'CANCEL ALL' },
    ],
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

/**
 * Offer to remember a repeated category correction as a smart rule.
 * "Not again" mutes the vendor rather than just declining once, so the bot cannot
 * nag about a vendor the user has deliberately kept mixed.
 */
export function kbLearnOffer() {
  return [[
    { text: '✅ Yes, always',  callback_data: 'lrn:yes' },
    { text: 'No',             callback_data: 'lrn:no' },
    { text: '🔕 Not again',   callback_data: 'lrn:never' },
  ]];
}

/**
 * Generic one-question chooser, two buttons per row.
 *
 * Used by the multi-expense discrepancy prompts, where the options differ per
 * question ("Just Shell" / "Split evenly" / "Enter each") and so cannot come from
 * a fixed keyboard. `data` must stay inside Telegram's 64-byte callback limit.
 */
export function kbMultiChoice(options = []) {
  const rows = [];
  for (let i = 0; i < options.length; i += 2) {
    rows.push(options.slice(i, i + 2).map(o => ({ text: o.text, callback_data: o.data })));
  }
  return rows;
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

/**
 * Field picker for an already-logged expense.
 *
 * Booking method only exists on the Travel/Holiday sheets (col G), so its button
 * is opt-in rather than always shown — offering it elsewhere would advertise a
 * field the row cannot store.
 */
export function kbEditLoggedMenu({ booking = false } = {}) {
  const rows = [
    [
      { text: 'Category', callback_data: 'edit:lf:cat' },
      { text: 'Amount',   callback_data: 'edit:lf:amt' },
    ],
    [
      { text: 'Store', callback_data: 'edit:lf:store' },
      { text: 'Date',  callback_data: 'edit:lf:date' },
    ],
    [{ text: 'Card', callback_data: 'edit:lf:card' }],
  ];
  if (booking) rows[2].push({ text: 'Booking', callback_data: 'edit:lf:booking' });
  rows.push([{ text: '❌ Cancel', callback_data: 'CANCEL' }]);
  return rows;
}

/**
 * Post-write enrichment menu: offered *after* an expense has already been logged
 * from a typed message, listing only the fields that were guessed or defaulted.
 *
 * `fields` is an ordered subset of ['cat','card','date','booking'] — the caller
 * decides what counts as missing, and puts a low-confidence category first so the
 * shakiest value is the one under the user's thumb. An empty list means the bot
 * got everything right and no menu is shown at all.
 *
 * Undo sits here rather than in a separate message because "cancel" on a
 * write-first flow means reversing the row, not dismissing the prompt.
 */
export function kbEnrichMenu(fields = []) {
  const LABELS = {
    cat:     { text: '🏷 Category', callback_data: 'enr:cat' },
    card:    { text: '💳 Card',     callback_data: 'enr:card' },
    date:    { text: '📅 Date',     callback_data: 'enr:date' },
    booking: { text: '🧾 Booking',  callback_data: 'enr:booking' },
  };
  const buttons = fields.map(f => LABELS[f]).filter(Boolean);
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([
    { text: '👍 All good', callback_data: 'enr:done' },
    { text: '↩️ Undo',      callback_data: 'UNDO' },
  ]);
  return rows;
}

/**
 * Category picker for a wallet charge the categorizer wasn't confident about.
 * callback_data is `CATFIX:<pendingId>:<category>`; pendingId is a short id
 * (not a UUID) so the whole payload stays inside Telegram's 64-byte limit.
 * The suggested category is pinned first so the common case is one tap.
 */
export function kbCategoryConfirm(pendingId, categories, suggestion = null) {
  const rows = [];
  if (suggestion && categories.includes(suggestion)) {
    rows.push([{ text: `⭐ ${suggestion}`, callback_data: `CATFIX:${pendingId}:${suggestion}` }]);
  }
  const rest = categories.filter(c => c !== suggestion);
  for (let i = 0; i < rest.length; i += 2) {
    rows.push(rest.slice(i, i + 2).map(c => ({ text: c, callback_data: `CATFIX:${pendingId}:${c}` })));
  }
  rows.push([{ text: '❌ CANCEL', callback_data: 'CANCEL' }]);
  return rows;
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

/**
 * Resolve a user email → Telegram chat id via the TELEGRAM_EMAIL_MAP secret
 * ("email:chatId,email:chatId"). Returns null when the user has no mapping.
 * Shared by the wallet webhook and the scheduled jobs (category audit, error
 * digest) so the parsing lives in one place.
 */
export function resolveTelegramChatId(email) {
  const raw = process.env.TELEGRAM_EMAIL_MAP || '';
  if (!email) return null;
  for (const pair of raw.split(',')) {
    const [mappedEmail, chatId] = pair.split(':').map(s => s.trim());
    if (mappedEmail && chatId && mappedEmail.toLowerCase() === email.toLowerCase()) {
      return chatId;
    }
  }
  return null;
}
