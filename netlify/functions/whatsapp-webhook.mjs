/**
 * WhatsApp (Twilio) transport layer.
 * Handles signature validation, media download, and Twilio-specific I/O.
 * All business logic lives in _bot-core.mjs.
 */

import { getStore } from '@netlify/blobs';
import {
  ALLOWED_MEDIA_TYPES,
  validateMagicBytes,
  validateTwilioSignature,
  twilioResponse,
  emptyTwiml,
  isAllowedPhone,
} from './_whatsapp.mjs';
import { handleTextReply, handleMediaMessage, handleAttachMedia, DAILY_LIMIT, getRateCount } from './_bot-core.mjs';

const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const ALLOWED_PHONES     = (process.env.WHATSAPP_ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
const UNDO_WINDOW_MS     = 10 * 60 * 1000;

/* ── Twilio media download ── */

async function downloadMedia(mediaUrl) {
  const res = await fetch(mediaUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
    },
  });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return res.arrayBuffer();
}

/* ── Twilio ctx factory ── */

function makeTwilioCtx(store, phone) {
  let _resp = null;
  return {
    ctx: {
      store,
      userId: phone,
      chatId: phone,
      send(message, markup) { _resp = twilioResponse(message); },
    },
    getResp: () => _resp ?? emptyTwiml(),
  };
}

/* ── Download + validate helper ── */

async function downloadAndValidateMedia(params) {
  const mediaUrl  = params.MediaUrl0 || '';
  const mediaType = params.MediaContentType0 || '';

  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return { error: 'Unsupported file type. Please send a photo (JPEG, PNG, WebP) or PDF of your receipt.' };
  }

  let mediaBuffer;
  try {
    mediaBuffer = await downloadMedia(mediaUrl);
  } catch (e) {
    console.error('whatsapp-webhook: media download failed', e.message);
    return { error: 'Could not download your image. Please try sending it again.' };
  }

  if (!validateMagicBytes(mediaBuffer, mediaType)) {
    return { error: 'File content does not match its type. Please send a valid receipt image or PDF.' };
  }

  return { base64: Buffer.from(mediaBuffer).toString('base64'), mediaType };
}

/* ── Main handler ── */

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url = new URL(req.url);
  const fullUrl = `${url.origin}${url.pathname}`;

  const body = await req.text();
  const params = Object.fromEntries(new URLSearchParams(body));

  const signature = req.headers.get('x-twilio-signature');
  if (!validateTwilioSignature(fullUrl, params, signature, TWILIO_AUTH_TOKEN)) {
    console.error('whatsapp-webhook: invalid Twilio signature');
    return new Response('Forbidden', { status: 403 });
  }

  const from     = params.From || '';
  const msgBody  = params.Body || '';
  const numMedia = parseInt(params.NumMedia || '0', 10);
  const phone    = from.replace('whatsapp:', '');

  if (!isAllowedPhone(phone, ALLOWED_PHONES)) {
    return twilioResponse("Your WhatsApp number isn't registered. Go to Budget Dashboard > Settings > WhatsApp Phone to register.");
  }

  const store = getStore('whatsapp-receipts');
  const { ctx, getResp } = makeTwilioCtx(store, phone);

  // ── Text message ──
  if (numMedia === 0) {
    await handleTextReply(ctx, msgBody);
    return getResp();
  }

  // ── Media: check for ATTACH mode ──
  const attachState = await store.get(`awaiting_attach:${phone}`, { type: 'json' }).catch(() => null);
  if (attachState) {
    const elapsed = Date.now() - new Date(attachState.requestedAt).getTime();
    if (elapsed <= UNDO_WINDOW_MS) {
      const { base64, mediaType, error } = await downloadAndValidateMedia(params);
      if (error) return twilioResponse(error);
      await handleAttachMedia(ctx, base64, mediaType, attachState);
      return getResp();
    }
    await store.delete(`awaiting_attach:${phone}`);
  }

  // ── Media: rate limit check (before downloading) ──
  const rateCount = await getRateCount(store, phone);
  if (rateCount >= DAILY_LIMIT) {
    return twilioResponse("You've reached 50 receipts today. Try again tomorrow.");
  }

  // ── Media: receipt extraction ──
  const { base64, mediaType, error } = await downloadAndValidateMedia(params);
  if (error) return twilioResponse(error);

  await handleMediaMessage(ctx, base64, mediaType);
  return getResp();
}

export const config = { path: '/.netlify/functions/whatsapp-webhook' };
