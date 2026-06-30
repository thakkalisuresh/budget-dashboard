/**
 * Cloud Function — wallet webhook for iOS Shortcuts / Android MacroDroid.
 * Receives transaction data from mobile automations triggered by bank
 * push notifications after wallet payments (Apple/Google/Samsung Wallet).
 * Categorizes via Claude AI, writes to Google Sheets, and confirms via push.
 */
import { onRequest } from 'firebase-functions/v2/https';
import webpush from 'web-push';
import crypto from 'node:crypto';
import { extractTransactionText } from './lib/_extraction.mjs';
import { appendExpense, getCurrentMonthSheetId, getUserSettingsByEmail } from './lib/_sheets.mjs';
import { getDb } from './lib/firestore.mjs';
import { createBotStore } from './lib/bot-store.mjs';
import { sendMessage } from './lib/_telegram.mjs';
import { matchesSplitVendor } from './lib/_item-categorizer.mjs';
import { sha256Hex } from './lib/http-common.mjs';
import {
  WALLET_WEBHOOK_SECRET,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
  ANTHROPIC_API_KEY, GEMINI_API_KEY,
  TELEGRAM_BOT_TOKEN,
  SHEETS_DRIVE_SECRETS,
} from './lib/secrets.mjs';

/** Resolve a requester email → Telegram chat id via the TELEGRAM_EMAIL_MAP env var. */
function resolveTelegramChatId(email) {
  const raw = process.env.TELEGRAM_EMAIL_MAP || '';
  for (const pair of raw.split(',')) {
    const [mappedEmail, chatId] = pair.split(':').map(s => s.trim());
    if (mappedEmail && chatId && mappedEmail.toLowerCase() === email.toLowerCase()) {
      return chatId;
    }
  }
  return null;
}

async function keyMatches(provided, expected) {
  const [a, b] = await Promise.all([sha256Hex(provided), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function extractKey(req) {
  const auth = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m) return m[1].trim();
  return req.get('x-api-key')?.trim() || null;
}

export const walletWebhook = onRequest(
  {
    region: 'us-central1',
    secrets: [
      WALLET_WEBHOOK_SECRET,
      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
      ANTHROPIC_API_KEY, GEMINI_API_KEY,
      TELEGRAM_BOT_TOKEN,
      ...SHEETS_DRIVE_SECRETS,
    ],
    timeoutSeconds: 30,
    cors: false,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const key = extractKey(req);
    const secret = process.env.WALLET_WEBHOOK_SECRET;
    if (!key || !secret || !(await keyMatches(key, secret))) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    let { merchant, card, email } = req.body || {};
    let amountRaw = req.body?.amount;
    let txDate = req.body?.date || null;

    // Raw-text path (iOS 27 "notification received" trigger, Android notification
    // reader, or a bank email alert): the automation can forward the raw notification
    // text and let the backend's LLM parser pull out the fields, instead of doing
    // fragile per-bank regex on-device. We parse ONCE and reuse the result below for
    // categorization too, so this costs no extra LLM call.
    let parsed = null;
    const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (rawText) {
      try {
        const r = await extractTransactionText(rawText);
        if (r.ok && r.data) {
          parsed = r.data;
          if (!merchant && parsed.store_name) merchant = parsed.store_name;
          if ((amountRaw === undefined || amountRaw === null || amountRaw === '') &&
              typeof parsed.total_amount === 'number') {
            amountRaw = parsed.total_amount;
          }
          if (!card && parsed.payment_method) card = parsed.payment_method;
          if (!txDate && parsed.purchase_date) txDate = parsed.purchase_date;
        }
      } catch (e) {
        console.error('Text parse failed:', e.message);
      }
    }

    if (!txDate) txDate = new Date().toISOString().slice(0, 10);
    // Amount may arrive with a currency symbol/grouping (e.g. "$1,234.56" from the iOS
    // Transaction trigger). Strip everything except digits, dot and minus before parsing.
    const amount = parseFloat(String(amountRaw ?? '').replace(/[^\d.-]/g, ''));

    if (!merchant || typeof merchant !== 'string') {
      res.status(400).json({ ok: false, error: 'Missing or invalid merchant' });
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      res.status(400).json({ ok: false, error: 'Missing or invalid amount' });
      return;
    }
    if (!email || !email.includes('@')) {
      res.status(400).json({ ok: false, error: 'Missing or invalid email' });
      return;
    }
    const monthName = new Date(txDate + 'T00:00:00').toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    // sheetId is optional: if the automation doesn't send one, resolve the
    // current month's sheet from the transaction date. This makes the Shortcut
    // future-proof across month rollovers (e.g. July gets a new sheet) without
    // any change on the phone.
    let sheetId = req.body?.sheetId;
    if (!sheetId || typeof sheetId !== 'string') {
      try {
        sheetId = await getCurrentMonthSheetId(monthName);
      } catch (e) {
        res.status(422).json({ ok: false, error: 'month_not_found', monthName });
        return;
      }
    }

    let category = 'Misc';
    let vendor = merchant.trim();
    if (parsed) {
      // Already parsed from raw text above — reuse it (no second LLM call).
      category = parsed.reward_category ?? 'Misc';
      vendor = parsed.store_name || vendor;
    } else {
      try {
        const result = await extractTransactionText(merchant.trim());
        if (result.ok && result.data) {
          category = result.data.reward_category ?? 'Misc';
          vendor = result.data.store_name || vendor;
        }
      } catch (e) {
        console.error('Categorization error (falling back to Misc):', e.message);
      }
    }

    let userSettings = {};
    try {
      userSettings = await getUserSettingsByEmail(email);
      const disabledVendors = userSettings.disabledWalletVendors || [];
      const vendorLower = vendor.toLowerCase();
      const isDisabled = disabledVendors.some(v =>
        (v.patterns || []).some(p => p && vendorLower.includes(p.toLowerCase()))
      );
      if (isDisabled) {
        res.status(200).json({ ok: true, skipped: true, reason: 'vendor_disabled', vendor });
        return;
      }
    } catch (e) {
      console.error('Disabled-vendor check failed (continuing to log):', e.message);
    }

    // ── Split-receipt vendor (Costco, Amazon…): don't log a lump sum. Stash the
    // charge and ask the user (via Telegram) to upload the receipt so it can be
    // split by category. Falls back to normal logging if we can't reach them.
    if (matchesSplitVendor(vendor, userSettings.splitReceiptVendors || [])) {
      const chatId = resolveTelegramChatId(email);
      if (chatId) {
        try {
          const store = createBotStore(getDb());
          const dt = new Date(txDate + 'T00:00:00');
          const id = crypto.randomUUID();
          await store.setJSON(`split_pending:${chatId}:${id}`, {
            id,
            vendor, amount, category,
            txDate,
            year: dt.getFullYear(),
            month: dt.toLocaleString('en-US', { month: 'long' }),
            paymentMethod: card ?? '',
            createdAt: new Date().toISOString(),
          });
          await sendMessage(
            chatId,
            `🧾 ${vendor} charge of $${amount.toFixed(2)} detected.\n\n` +
            `Upload the receipt photo to split it by category, or tap SKIP to log it as a single ${category} expense.`,
            [[{ text: '⏭ SKIP (log as one expense)', callback_data: 'SKIP' }]]
          );
          res.status(200).json({ ok: true, split: true, vendor, amount });
          return;
        } catch (e) {
          console.error('Split prompt failed (falling back to normal logging):', e.message);
        }
      } else {
        console.warn(`No Telegram mapping for ${email}; logging split vendor normally.`);
      }
    }

    try {
      await appendExpense({
        category,
        vendor,
        amount,
        txDate,
        sheetId,
        monthName,
        paymentMethod: card ?? '',
        channel: 'wallet',
      });
    } catch (e) {
      if (e.message?.includes('No sheet found for month')) {
        res.status(422).json({ ok: false, error: 'month_not_found', monthName });
        return;
      }
      console.error('appendExpense failed:', e.message);
      res.status(500).json({ ok: false, error: 'Failed to write transaction' });
      return;
    }

    const vapidPublic  = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidEmail   = process.env.VAPID_EMAIL;
    if (vapidPublic && vapidPrivate && vapidEmail) {
      try {
        const docRef = getDb().collection('push_subscriptions').doc(email);
        const snap = await docRef.get();
        const entry = snap.exists ? snap.data() : null;
        if (entry?.subscription?.endpoint) {
          webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPublic, vapidPrivate);
          await webpush.sendNotification(
            entry.subscription,
            JSON.stringify({
              title: 'Transaction Logged',
              body: `Logged $${amount} at ${vendor} as ${category}`,
              url: '/',
            })
          );
        }
      } catch (e) {
        if (e.statusCode === 410) {
          await getDb().collection('push_subscriptions').doc(email).delete().catch(() => {});
        }
        console.error('Push notification failed (non-fatal):', e.message);
      }
    }

    res.status(200).json({ ok: true, category, vendor, amount });
  }
);
