import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import {
  ALLOWED_MEDIA_TYPES,
  validateMagicBytes,
  validateTwilioSignature,
  twilioResponse,
  emptyTwiml,
  isAllowedPhone,
} from './_whatsapp.mjs';
import { extractReceipt } from './_extraction.mjs';
import { uploadReceiptImage, moveFile, buildFolderPath } from './_drive.mjs';
import { getCurrentMonthSheetId, appendExpense } from './_sheets.mjs';

const TWILIO_AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const ALLOWED_PHONES        = (process.env.WHATSAPP_ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
const DAILY_LIMIT           = 50;

async function getRateCount(store, phone) {
  const key = `rate:${phone}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const val = await store.get(key, { type: 'json' });
    return val?.count || 0;
  } catch { return 0; }
}

async function incrementRateCount(store, phone) {
  const key = `rate:${phone}:${new Date().toISOString().slice(0, 10)}`;
  let count = 0;
  try {
    const val = await store.get(key, { type: 'json' });
    count = val?.count || 0;
  } catch { /* new entry */ }
  await store.setJSON(key, { count: count + 1 });
}

async function downloadMedia(mediaUrl) {
  const res = await fetch(mediaUrl, {
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
    },
  });
  if (!res.ok) throw new Error(`Media download failed: ${res.status}`);
  return res.arrayBuffer();
}

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

  const from      = params.From || '';
  const msgBody   = params.Body || '';
  const numMedia  = parseInt(params.NumMedia || '0', 10);
  const phone     = from.replace('whatsapp:', '');

  if (!isAllowedPhone(phone, ALLOWED_PHONES)) {
    return twilioResponse("Your WhatsApp number isn't registered. Go to Budget Dashboard > Settings > WhatsApp Phone to register.");
  }

  const store = getStore('whatsapp-receipts');

  if (numMedia === 0) {
    return await handleTextReply(store, phone, msgBody);
  }

  const rateCount = await getRateCount(store, phone);
  if (rateCount >= DAILY_LIMIT) {
    return twilioResponse("You've reached 50 receipts today. Try again tomorrow.");
  }

  const mediaUrl  = params.MediaUrl0 || '';
  const mediaType = params.MediaContentType0 || '';

  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return twilioResponse('Unsupported file type. Please send a photo (JPEG, PNG, WebP) or PDF of your receipt.');
  }

  let mediaBuffer;
  try {
    mediaBuffer = await downloadMedia(mediaUrl);
  } catch (e) {
    console.error('whatsapp-webhook: media download failed', e.message);
    return twilioResponse('Could not download your image. Please try sending it again.');
  }

  if (!validateMagicBytes(mediaBuffer, mediaType)) {
    return twilioResponse('File content does not match its type. Please send a valid receipt image or PDF.');
  }

  await incrementRateCount(store, phone);

  const receiptId = crypto.randomUUID();
  const base64    = Buffer.from(mediaBuffer).toString('base64');

  const extraction = await extractReceipt(base64, mediaType);

  if (!extraction.ok || extraction.data?.total_amount == null) {
    await store.setJSON(`pending:${receiptId}`, {
      id: receiptId, phone, mediaType, base64,
      receivedAt: new Date().toISOString(),
      status: 'extraction_failed',
    });
    const msg = !extraction.ok
      ? "Couldn't parse receipt clearly. Reply with: Store name, amount, category\n(e.g., 'Walmart 45.23 Grocery')"
      : "Receipt unclear. Please confirm total amount.\nReply with: Store name, amount, category (e.g., 'Walmart 45.23 Grocery')";
    return twilioResponse(msg);
  }

  const { data } = extraction;
  const now = new Date();
  const year  = data.purchase_date ? new Date(data.purchase_date).getFullYear() : now.getFullYear();
  const month = data.purchase_date
    ? new Date(data.purchase_date).toLocaleString('en-US', { month: 'long' })
    : now.toLocaleString('en-US', { month: 'long' });

  let driveResult = null;
  try {
    driveResult = await uploadReceiptImage({
      year,
      month,
      category: null,
      fileName: `receipt-${receiptId.slice(0, 8)}.${mediaType === 'application/pdf' ? 'pdf' : 'jpg'}`,
      mimeType: mediaType,
      base64,
    });
  } catch (e) {
    console.error('whatsapp-webhook: Drive upload failed', e.message);
  }

  await store.setJSON(`confirm:${phone}:${receiptId}`, {
    id: receiptId,
    phone,
    mediaType,
    base64,
    extraction: data,
    driveFileId: driveResult?.fileId || null,
    driveFolderId: driveResult?.folderId || null,
    driveShareLink: driveResult?.shareLink || null,
    year,
    month,
    receivedAt: now.toISOString(),
    status: 'awaiting_confirmation',
  });

  console.log(`whatsapp-webhook: receipt ${receiptId} extracted for ${phone} — ${data.store_name} $${data.total_amount}`);

  const confirmMsg = [
    'Receipt found:',
    `Store: ${data.store_name || 'Unknown'}`,
    `Date: ${data.purchase_date || 'Unknown'}`,
    `Category: ${data.reward_category || 'Misc'}`,
    `Total: $${data.total_amount ?? '?'}`,
    '',
    'Reply YES to log, or CANCEL',
  ].join('\n');

  return twilioResponse(confirmMsg);
}

async function handleTextReply(store, phone, text) {
  const normalized = text.trim().toUpperCase();

  if (normalized === 'YES' || normalized === 'CANCEL') {
    const { blobs } = await store.list({ prefix: `confirm:${phone}:` });

    if (!blobs || blobs.length === 0) {
      return twilioResponse("No pending receipt to confirm. Send a receipt image to get started.");
    }

    const key     = blobs[0].key;
    const pending = await store.get(key, { type: 'json' });

    if (!pending) {
      await store.delete(key);
      return twilioResponse("No pending receipt to confirm. Send a receipt image to get started.");
    }

    if (normalized === 'CANCEL') {
      await store.delete(key);
      console.log(`whatsapp-webhook: receipt ${pending.id} cancelled by ${phone}`);
      return twilioResponse('Receipt cancelled.');
    }

    const { extraction, driveFileId, year, month } = pending;
    const category  = extraction.reward_category || 'Misc';
    const vendor    = extraction.store_name || 'Unknown';
    const amount    = extraction.total_amount;
    const txDate    = extraction.purchase_date;
    const monthName = `${month} ${year}`;

    let sheetId;
    try {
      sheetId = await getCurrentMonthSheetId(monthName);
    } catch (e) {
      console.error('whatsapp-webhook: could not find month sheet', e.message);
      return twilioResponse(`Could not find sheet for ${monthName}. Please log this receipt via the dashboard.`);
    }

    try {
      await appendExpense({ category, vendor, amount, txDate, sheetId, monthName });
    } catch (e) {
      console.error('whatsapp-webhook: Sheets append failed', e.message);
      return twilioResponse('Failed to log receipt to spreadsheet. Please try via the dashboard.');
    }

    if (driveFileId) {
      try {
        const { folderId } = await buildFolderPath(year, month, category);
        await moveFile(driveFileId, folderId);
      } catch (e) {
        console.warn('whatsapp-webhook: Drive move failed (non-fatal)', e.message);
      }
    }

    await store.delete(key);
    console.log(`whatsapp-webhook: receipt ${pending.id} confirmed — ${vendor} $${amount} → ${category}`);

    const DASHBOARD_URL = process.env.SITE_URL || 'https://budget-dashboard-tracker.netlify.app';
    const summary = [
      'Receipt logged!',
      '',
      `Store/Vendor: ${vendor}`,
      `Date: ${txDate || 'Today'}`,
      `Category: ${category}`,
      `Total: $${amount}`,
      ...(pending.driveShareLink ? [`View Receipt: ${pending.driveShareLink}`] : []),
      `Dashboard: ${DASHBOARD_URL}`,
    ].join('\n');

    return twilioResponse(summary);
  }

  // Manual clarification: "Walmart 45.23 Grocery" after extraction failed
  const manualMatch = text.trim().match(/^(.+?)\s+([\d.]+)\s+(\w[\w\s-]*)$/);
  if (manualMatch) {
    const { blobs } = await store.list({ prefix: 'pending:' });
    const failedBlob = await findFailedPending(store, blobs, phone);

    if (failedBlob) {
      const [, vendor, amountStr, category] = manualMatch;
      const amount = parseFloat(amountStr);
      if (isNaN(amount) || amount <= 0) {
        return twilioResponse("Couldn't parse amount. Reply with: Store name, amount, category (e.g., 'Walmart 45.23 Grocery')");
      }

      const { CATEGORIES } = await import('./_extraction.mjs');
      const matchedCat = CATEGORIES.find(c => c.toLowerCase() === category.trim().toLowerCase()) || 'Misc';

      const pending = await store.get(failedBlob.key, { type: 'json' });
      const now = new Date();

      await store.delete(failedBlob.key);
      await store.setJSON(`confirm:${phone}:${pending.id}`, {
        ...pending,
        extraction: {
          store_name: vendor.trim(),
          purchase_date: now.toISOString().slice(0, 10),
          total_amount: amount,
          tax_amount: null,
          currency: 'USD',
          items: [],
          reward_category: matchedCat,
        },
        year: now.getFullYear(),
        month: now.toLocaleString('en-US', { month: 'long' }),
        status: 'awaiting_confirmation',
      });

      return twilioResponse(
        `Got it:\nStore: ${vendor.trim()}\nCategory: ${matchedCat}\nTotal: $${amount}\n\nReply YES to log, or CANCEL`
      );
    }
  }

  if (text.trim().length > 0) {
    return twilioResponse("Send a receipt image to log an expense, or reply YES/CANCEL to confirm a pending receipt.");
  }

  return emptyTwiml();
}

async function findFailedPending(store, blobs, phone) {
  if (!blobs || blobs.length === 0) return null;
  for (const blob of blobs) {
    try {
      const entry = await store.get(blob.key, { type: 'json' });
      if (entry && entry.phone === phone && entry.status === 'extraction_failed') {
        return blob;
      }
    } catch { /* skip */ }
  }
  return null;
}

export const config = { path: '/.netlify/functions/whatsapp-webhook' };
