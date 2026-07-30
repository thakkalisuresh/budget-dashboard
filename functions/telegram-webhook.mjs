/**
 * Cloud Function — Telegram bot webhook.
 * Bot state lives in Firestore; business logic lives in lib/_bot-core.mjs.
 *
 * Secrets are bound so the lib modules' process.env reads resolve at cold start.
 * Synchronous processing is preserved from the original (receipt extraction +
 * Sheets writes happen before the 200), so timeout/memory are raised.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getDb } from './lib/firestore.mjs';
import { createBotStore } from './lib/bot-store.mjs';
import { reportError } from './lib/_error-log.mjs';
import { withErrorContext, setActor, trail, describeActor } from './lib/_error-context.mjs';
import {
  validateTelegramWebhook,
  sendMessage,
  answerCallback,
  downloadTelegramFile,
  isAllowedUser,
} from './lib/_telegram.mjs';
import { validateMagicBytes, ALLOWED_MEDIA_TYPES } from './lib/_media.mjs';
import {
  handleTextReply,
  handleMediaMessage,
  handleAttachMedia,
} from './lib/_bot-core.mjs';
import {
  TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_USERS, TELEGRAM_EMAIL_MAP,
  GEMINI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, SHEETS_DRIVE_SECRETS,
} from './lib/secrets.mjs';

const UNDO_WINDOW_MS = 10 * 60 * 1000;

/* ── Telegram ctx factory ── */

function makeTelegramCtx(store, userId, chatId) {
  return {
    store,
    userId: String(userId),
    chatId,
    channel: 'telegram',
    async send(message, markup = null) {
      await sendMessage(chatId, message, markup);
    },
  };
}

/* ── Detect MIME type from Telegram file name or magic bytes ── */

function guessMimeType(fileName, buffer) {
  if (fileName) {
    const ext = fileName.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return 'application/pdf';
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  }

  // Fall back to magic bytes
  const bytes = new Uint8Array(buffer.slice(0, 4));
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  if (bytes[0] === 0x25 && bytes[1] === 0x50) return 'application/pdf';

  return null;
}

/* ── Handle media from Telegram (photo or document) ── */

async function handleTelegramMedia(ctx, message) {
  let fileId;
  let fileName = null;

  if (message.photo && message.photo.length > 0) {
    // Pick highest resolution (last in array)
    fileId = message.photo[message.photo.length - 1].file_id;
  } else if (message.document) {
    fileId = message.document.file_id;
    fileName = message.document.file_name || null;
  } else {
    return ctx.send('Unsupported file type. Send a photo or PDF.');
  }

  let buffer;
  try {
    buffer = await downloadTelegramFile(fileId);
  } catch (e) {
    await reportError('TG-002', e, { userId: ctx.userId });
    return ctx.send('Could not download your file. Please try sending it again.');
  }

  const mediaType = guessMimeType(fileName, buffer);
  if (!mediaType || !ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return ctx.send('Unsupported file type. Send a photo (JPEG, PNG, WebP) or PDF.');
  }

  if (!validateMagicBytes(buffer, mediaType)) {
    return ctx.send('File content does not match its type. Please send a valid receipt image or PDF.');
  }

  const base64 = Buffer.from(buffer).toString('base64');

  // Check for ATTACH mode
  const attachState = await ctx.store.get(`awaiting_attach:${ctx.userId}`, { type: 'json' }).catch(() => null);
  if (attachState) {
    const elapsed = Date.now() - new Date(attachState.requestedAt).getTime();
    if (elapsed <= UNDO_WINDOW_MS) {
      return await handleAttachMedia(ctx, base64, mediaType, attachState);
    }
    await ctx.store.delete(`awaiting_attach:${ctx.userId}`);
  }

  // R4: rate limiting is now an atomic check-and-increment inside
  // handleMediaMessage (removes the redundant pre-read here).
  return await handleMediaMessage(ctx, base64, mediaType);
}

/* ── Main handler ── */

export const telegramWebhook = onRequest(
  {
    region: 'us-central1',
    secrets: [
      // TELEGRAM_EMAIL_MAP is needed by reportError's instant fatal alert,
      // which resolves the chat from ALLOWED_EMAILS. Without it a fatal error
      // on the bot path records but cannot notify.
      TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_ALLOWED_USERS, TELEGRAM_EMAIL_MAP,
      GEMINI_API_KEY, ANTHROPIC_API_KEY, GROQ_API_KEY, ...SHEETS_DRIVE_SECRETS,
    ],
    timeoutSeconds: 120,
    memory: '512MiB',
    maxInstances: 5,
    cors: false,
  },
  // Every failure inside inherits channel/actor/steps without threading a
  // parameter through bot-core. AsyncLocalStorage scopes it per invocation,
  // which matters because Cloud Functions reuse instances across requests.
  async (req, res) => withErrorContext({ channel: 'bot' }, async () => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    if (!validateTelegramWebhook(req)) { res.status(403).send('Forbidden'); return; }

    const update = req.body || {};
    const allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '')
      .split(',').map(u => u.trim()).filter(Boolean);

    // Identify who this update is from before any work happens, so a failure
    // anywhere below already knows which of the two of us hit it.
    const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
    if (fromId) setActor(describeActor(fromId));
    if (update.message?.photo || update.message?.document) trail('sent a photo');
    else if (update.callback_query) trail(`tapped ${String(update.callback_query.data || '').slice(0, 24)}`);
    else if (update.message?.text) trail(`sent "${String(update.message.text).slice(0, 24)}"`);
    const store = createBotStore(getDb());

    // ── R1: idempotency — Telegram re-delivers an update if it doesn't get a
    //    timely 200. Claim each update_id once so a retry (e.g. after a slow
    //    cold-start extraction) can't double-process the same update. On a
    //    processing failure we release the claim below so the retry still runs.
    const updateId = update.update_id;
    if (updateId != null && !(await store.claimOnce(`seen:${updateId}`))) {
      res.status(200).send('ok');
      return;
    }

    try {
      // ── Callback query (inline keyboard button press) ──
      if (update.callback_query) {
        const { id, from, data, message } = update.callback_query;
        const userId = String(from.id);
        const chatId = message.chat.id;

        if (!isAllowedUser(userId, allowedUsers)) {
          await answerCallback(id);
          res.status(200).send('ok');
          return;
        }

        const ctx = makeTelegramCtx(store, userId, chatId);
        // R7: clear the button spinner concurrently with handling the callback.
        await Promise.all([answerCallback(id), handleTextReply(ctx, data)]);
        res.status(200).send('ok');
        return;
      }

      // ── Message ──
      if (update.message) {
        const { from, chat, text, photo, document } = update.message;
        const userId = String(from.id);
        const chatId = chat.id;

        if (!isAllowedUser(userId, allowedUsers)) { res.status(200).send('ok'); return; }

        const ctx = makeTelegramCtx(store, userId, chatId);

        if (photo || document) {
          await handleTelegramMedia(ctx, update.message);
        } else if (text) {
          await handleTextReply(ctx, text);
        }

        res.status(200).send('ok');
        return;
      }
    } catch (e) {
      await reportError('BOT-001', e, { flow: 'webhook' });
      // Release the idempotency claim so Telegram's retry is processed rather
      // than silently deduped as already-seen.
      if (updateId != null) await store.delete(`seen:${updateId}`).catch(() => {});
      res.status(500).send('error');
      return;
    }

    res.status(200).send('ok');
  })
);
