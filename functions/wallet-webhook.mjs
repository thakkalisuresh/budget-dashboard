/**
 * Cloud Function — wallet webhook for iOS Shortcuts / Android MacroDroid.
 * Receives transaction data from mobile automations triggered by bank
 * push notifications after wallet payments (Apple/Google/Samsung Wallet).
 * Categorizes via Claude AI, writes to Google Sheets, and confirms via push.
 */
import { onRequest } from 'firebase-functions/v2/https';
import webpush from 'web-push';
import { extractTransactionText } from './lib/_extraction.mjs';
import { appendExpense } from './lib/_sheets.mjs';
import { getDb } from './lib/firestore.mjs';
import { sha256Hex } from './lib/http-common.mjs';
import {
  WALLET_WEBHOOK_SECRET,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
  ANTHROPIC_API_KEY, GEMINI_API_KEY,
  SHEETS_DRIVE_SECRETS,
} from './lib/secrets.mjs';

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

    const { merchant, card, sheetId, email } = req.body || {};
    const amount = parseFloat(req.body?.amount);
    const txDate = req.body?.date || new Date().toISOString().slice(0, 10);

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
    if (!sheetId || typeof sheetId !== 'string') {
      res.status(400).json({ ok: false, error: 'Missing sheetId' });
      return;
    }

    const monthName = new Date(txDate + 'T00:00:00').toLocaleString('en-US', {
      month: 'long',
      year: 'numeric',
    });

    let category = 'Misc';
    let vendor = merchant.trim();
    try {
      const result = await extractTransactionText(merchant.trim());
      if (result.ok && result.data) {
        category = result.data.reward_category ?? 'Misc';
        vendor = result.data.store_name || vendor;
      }
    } catch (e) {
      console.error('Categorization error (falling back to Misc):', e.message);
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
              body: `Logged ₹${amount} at ${vendor} as ${category}`,
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
