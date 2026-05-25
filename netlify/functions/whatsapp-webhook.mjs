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
import { getCurrentMonthSheetId, appendExpense, deleteExpenseByUUID } from './_sheets.mjs';

const TWILIO_AUTH_TOKEN     = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_ACCOUNT_SID    = process.env.TWILIO_ACCOUNT_SID;
const ALLOWED_PHONES        = (process.env.WHATSAPP_ALLOWED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean);
const DAILY_LIMIT           = 50;
const UNDO_WINDOW_MS        = 10 * 60 * 1000;

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

  // Check for ATTACH mode — user sending a receipt photo to attach to last entry
  const attachState = await store.get(`awaiting_attach:${phone}`, { type: 'json' }).catch(() => null);
  if (attachState) {
    const elapsed = Date.now() - new Date(attachState.requestedAt).getTime();
    if (elapsed <= UNDO_WINDOW_MS) {
      return await handleAttachPhoto(store, phone, params, attachState);
    }
    await store.delete(`awaiting_attach:${phone}`);
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
    'Edit: "category: Travel" or "amount: 52.10"',
  ].join('\n');

  return twilioResponse(confirmMsg);
}

// ── ATTACH photo handler ────────────────────────────────────────────────────

async function handleAttachPhoto(store, phone, params, attachState) {
  const mediaUrl  = params.MediaUrl0 || '';
  const mediaType = params.MediaContentType0 || '';

  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return twilioResponse('Unsupported file type. Send a photo (JPEG, PNG, WebP) or PDF.');
  }

  let mediaBuffer;
  try {
    mediaBuffer = await downloadMedia(mediaUrl);
  } catch (e) {
    return twilioResponse('Could not download the image. Try again.');
  }

  if (!validateMagicBytes(mediaBuffer, mediaType)) {
    return twilioResponse('File content mismatch. Send a valid receipt image or PDF.');
  }

  const base64 = Buffer.from(mediaBuffer).toString('base64');
  const { year, month, category, vendor, amount } = attachState;

  let driveResult;
  try {
    const fileName = `receipt-${Date.now()}.${mediaType === 'application/pdf' ? 'pdf' : 'jpg'}`;
    driveResult = await uploadReceiptImage({
      year, month, category, fileName, mimeType: mediaType, base64,
    });
  } catch (e) {
    console.error('whatsapp-webhook: ATTACH Drive upload failed', e.message);
    return twilioResponse('Failed to upload receipt to Drive. Try again.');
  }

  const lastlog = await store.get(`lastlog:${phone}`, { type: 'json' }).catch(() => null);
  if (lastlog && lastlog.uuid === attachState.uuid) {
    lastlog.driveFileId = driveResult.fileId;
    lastlog.driveShareLink = driveResult.shareLink;
    await store.setJSON(`lastlog:${phone}`, lastlog);
  }

  await store.delete(`awaiting_attach:${phone}`);
  console.log(`whatsapp-webhook: ATTACH — receipt uploaded for ${vendor} $${amount} by ${phone}`);

  return twilioResponse(
    `Receipt attached!\n${vendor} · $${amount} (${category})\nView: ${driveResult.shareLink}`
  );
}

// ── Text reply handler ──────────────────────────────────────────────────────

async function handleTextReply(store, phone, text) {
  // Any text message clears an awaiting ATTACH state
  await store.delete(`awaiting_attach:${phone}`).catch(() => {});

  const normalized = text.trim().toUpperCase();

  // ── YES / CANCEL ──
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

    let result;
    try {
      result = await appendExpense({ category, vendor, amount, txDate, sheetId, monthName });
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

    await store.setJSON(`lastlog:${phone}`, {
      uuid: result.uuid, category, vendor, amount, txDate,
      sheetId, monthName, year, month,
      driveFileId: driveFileId || null,
      driveShareLink: pending.driveShareLink || null,
      loggedAt: new Date().toISOString(),
    });

    await store.delete(key);
    console.log(`whatsapp-webhook: receipt ${pending.id} confirmed — ${vendor} $${amount} → ${category}`);

    const DASHBOARD_URL = process.env.SITE_URL || 'https://budget-dashboard-tracker.netlify.app';
    const hints = ['UNDO to reverse'];
    if (!driveFileId) hints.push('ATTACH to add receipt photo');

    const summary = [
      'Receipt logged!',
      '',
      `Store/Vendor: ${vendor}`,
      `Date: ${txDate || 'Today'}`,
      `Category: ${category}`,
      `Total: $${amount}`,
      ...(pending.driveShareLink ? [`View Receipt: ${pending.driveShareLink}`] : []),
      `Dashboard: ${DASHBOARD_URL}`,
      '',
      hints.join(' · '),
    ].join('\n');

    return twilioResponse(summary);
  }

  // ── UNDO ──
  if (normalized === 'UNDO') {
    const lastlog = await store.get(`lastlog:${phone}`, { type: 'json' }).catch(() => null);
    if (!lastlog) {
      return twilioResponse("Nothing to undo.");
    }

    const elapsed = Date.now() - new Date(lastlog.loggedAt).getTime();
    if (elapsed > UNDO_WINDOW_MS) {
      return twilioResponse("Undo window expired (10 min). Edit the entry in the dashboard instead.");
    }

    try {
      await deleteExpenseByUUID({ category: lastlog.category, uuid: lastlog.uuid, sheetId: lastlog.sheetId });
    } catch (e) {
      console.error('whatsapp-webhook: UNDO delete failed', e.message);
      return twilioResponse('Could not undo. The entry may have been modified. Check the dashboard.');
    }

    await store.delete(`lastlog:${phone}`);
    console.log(`whatsapp-webhook: UNDO — ${lastlog.vendor} $${lastlog.amount} removed by ${phone}`);

    return twilioResponse(`Undone: ${lastlog.vendor} $${lastlog.amount} (${lastlog.category}) removed.`);
  }

  // ── ATTACH ──
  if (normalized === 'ATTACH') {
    const lastlog = await store.get(`lastlog:${phone}`, { type: 'json' }).catch(() => null);
    if (!lastlog) {
      return twilioResponse("No recent entry to attach a receipt to.");
    }
    if (lastlog.driveFileId) {
      return twilioResponse("Your last entry already has a receipt attached.");
    }

    await store.setJSON(`awaiting_attach:${phone}`, {
      ...lastlog,
      requestedAt: new Date().toISOString(),
    });

    return twilioResponse(
      `Send the receipt photo for:\n${lastlog.vendor} · $${lastlog.amount} (${lastlog.category})`
    );
  }

  // ── Field edit: "category: X", "amount: X", "store: X", "date: X" ──
  const editMatch = text.trim().match(/^(category|amount|store|date)\s*:\s*(.+)$/i);
  if (editMatch) {
    const { blobs } = await store.list({ prefix: `confirm:${phone}:` });
    if (!blobs || blobs.length === 0) {
      return twilioResponse("No pending receipt to edit. Send a receipt image first.");
    }

    const key     = blobs[0].key;
    const pending = await store.get(key, { type: 'json' });
    if (!pending) {
      return twilioResponse("No pending receipt to edit.");
    }

    const field = editMatch[1].toLowerCase();
    const value = editMatch[2].trim();

    if (field === 'category') {
      const { CATEGORIES } = await import('./_extraction.mjs');
      const matched = CATEGORIES.find(c => c.toLowerCase() === value.toLowerCase());
      if (!matched) {
        const { CATEGORIES: cats } = await import('./_extraction.mjs');
        return twilioResponse(`Unknown category. Choose from:\n${cats.join(', ')}`);
      }
      pending.extraction.reward_category = matched;
    } else if (field === 'amount') {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) {
        return twilioResponse("Invalid amount. Use a positive number (e.g., 'amount: 52.10')");
      }
      pending.extraction.total_amount = num;
    } else if (field === 'store') {
      pending.extraction.store_name = value;
    } else if (field === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return twilioResponse("Date must be YYYY-MM-DD (e.g., 'date: 2026-05-20')");
      }
      pending.extraction.purchase_date = value;
      pending.year = new Date(value).getFullYear();
      pending.month = new Date(value).toLocaleString('en-US', { month: 'long' });
    }

    await store.setJSON(key, pending);

    const e = pending.extraction;
    return twilioResponse(
      `Updated!\nStore: ${e.store_name || 'Unknown'}\nDate: ${e.purchase_date || 'Unknown'}\nCategory: ${e.reward_category || 'Misc'}\nTotal: $${e.total_amount ?? '?'}\n\nReply YES to log, or CANCEL`
    );
  }

  // ── Manual entry: "Walmart 45.23 Grocery" ──
  const manualMatch = text.trim().match(/^(.+?)\s+([\d.]+)\s+(\w[\w\s-]*)$/);
  if (manualMatch) {
    const [, vendor, amountStr, category] = manualMatch;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      return twilioResponse("Invalid amount. Use: StoreName Amount Category (e.g., 'Walmart 45.23 Grocery')");
    }

    const { CATEGORIES } = await import('./_extraction.mjs');
    const matchedCat = CATEGORIES.find(c => c.toLowerCase() === category.trim().toLowerCase()) || 'Misc';
    const now = new Date();

    // Check for failed pending extraction (preserves image data if available)
    const { blobs } = await store.list({ prefix: 'pending:' });
    const failedBlob = await findFailedPending(store, blobs, phone);

    let pendingData = {};
    if (failedBlob) {
      const pending = await store.get(failedBlob.key, { type: 'json' });
      pendingData = { mediaType: pending.mediaType, base64: pending.base64 };
      await store.delete(failedBlob.key);
    }

    const receiptId = crypto.randomUUID();
    await store.setJSON(`confirm:${phone}:${receiptId}`, {
      id: receiptId,
      phone,
      ...pendingData,
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

  // ── Help ──
  if (text.trim().length > 0) {
    return twilioResponse(
      'Send a receipt image or type "Store Amount Category" to log.\n\nCommands: YES, CANCEL, UNDO, ATTACH\nEdit pending: "category: Travel" or "amount: 52.10"'
    );
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
