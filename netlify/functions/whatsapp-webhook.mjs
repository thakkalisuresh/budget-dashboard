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
import { extractReceipt, extractTransactionText, CATEGORIES } from './_extraction.mjs';
import { uploadReceiptImage, moveFile, buildFolderPath } from './_drive.mjs';
import { getCurrentMonthSheetId, appendExpense, deleteExpenseByUUID, getTotals, getRecentExpenses, writeSalaryAmount, writeBudgetAmount, addCategory, checkMonthExists, getLatestMonthData, getUserSettings, createMonth } from './_sheets.mjs';
import { convertToUSD } from './_currency.mjs';
import { looksLikeQuery, answerQuery } from './_query.mjs';

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

  // Currency conversion (I2)
  const conversionInfo = await maybeConvertCurrency(data);

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

  // Transfer detected — ask user to pick category before logging
  if (data.is_transfer) {
    await store.setJSON(`transfer_pending:${phone}:${receiptId}`, {
      id: receiptId,
      phone,
      mediaType,
      base64,
      extraction: data,
      conversionInfo,
      driveFileId: driveResult?.fileId || null,
      driveFolderId: driveResult?.folderId || null,
      driveShareLink: driveResult?.shareLink || null,
      year,
      month,
      receivedAt: now.toISOString(),
    });
    return twilioResponse(buildTransferPrompt(data, conversionInfo));
  }

  await store.setJSON(`confirm:${phone}:${receiptId}`, {
    id: receiptId,
    phone,
    mediaType,
    base64,
    extraction: data,
    conversionInfo,
    driveFileId: driveResult?.fileId || null,
    driveFolderId: driveResult?.folderId || null,
    driveShareLink: driveResult?.shareLink || null,
    year,
    month,
    receivedAt: now.toISOString(),
    status: 'awaiting_confirmation',
  });

  console.log(`whatsapp-webhook: receipt ${receiptId} extracted for ${phone} — ${data.store_name} $${data.total_amount}`);

  return twilioResponse(buildConfirmPrompt(data, conversionInfo));
}

// ── Helpers for currency + transfer ─────────────────────────────────────────

async function maybeConvertCurrency(data) {
  if (!data.currency || data.currency === 'USD') return null;
  if (typeof data.total_amount !== 'number' || data.total_amount <= 0) return null;
  try {
    const info = await convertToUSD(data.total_amount, data.currency);
    data.total_amount = info.amount;
    return info;
  } catch (e) {
    console.warn('whatsapp-webhook: currency conversion failed', e.message);
    return null;
  }
}

function buildConfirmPrompt(data, conversionInfo) {
  const lines = [
    'Transaction found:',
    `Store: ${data.store_name || 'Unknown'}`,
    `Date: ${data.purchase_date || 'Unknown'}`,
    `Category: ${data.reward_category || 'Misc'}`,
    `Total: $${data.total_amount ?? '?'}`,
  ];
  if (conversionInfo) {
    lines.push(`(Converted from ${conversionInfo.originalCurrency} ${conversionInfo.original} · rate ${conversionInfo.rate.toFixed(4)})`);
  }
  lines.push('', 'Reply YES to log, or CANCEL', 'Edit: "category: Travel" or "amount: 52.10"');
  return lines.join('\n');
}

function buildTransferPrompt(data, conversionInfo) {
  const lines = [
    `Transfer detected: $${data.total_amount} to ${data.store_name || 'Unknown'}`,
  ];
  if (conversionInfo) {
    lines.push(`(Converted from ${conversionInfo.originalCurrency} ${conversionInfo.original} · rate ${conversionInfo.rate.toFixed(4)})`);
  }
  lines.push('', 'What category?', CATEGORIES.join(', '), '', '(or CANCEL)');
  return lines.join('\n');
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

  // ── CANCEL ──
  if (normalized === 'CANCEL') {
    let cancelledAny = false;
    for (const key of [`salary_pending:${phone}`, `budget_pending:${phone}`, `new_month_wizard:${phone}`, `delete_pending:${phone}`]) {
      try {
        const val = await store.get(key, { type: 'json' });
        if (val) { await store.delete(key); cancelledAny = true; }
      } catch { /* no pending */ }
    }
    for (const prefix of [`confirm:${phone}:`, `transfer_pending:${phone}:`]) {
      const { blobs } = await store.list({ prefix });
      for (const b of (blobs || [])) {
        await store.delete(b.key);
        cancelledAny = true;
      }
    }
    console.log(`whatsapp-webhook: CANCEL by ${phone} (cleaned ${cancelledAny ? 'pending' : 'nothing'})`);
    return twilioResponse(cancelledAny ? 'Cancelled.' : 'Nothing to cancel.');
  }

  // ── NEW MONTH wizard (active) ──
  const wizardState = await store.get(`new_month_wizard:${phone}`, { type: 'json' }).catch(() => null);
  if (wizardState) {
    if (new Date(wizardState.expires) > new Date()) {
      return await handleNewMonthWizard(store, phone, text, wizardState);
    }
    await store.delete(`new_month_wizard:${phone}`);
  }

  // ── DELETE pending (3-layer security) ──
  const deletePending = await store.get(`delete_pending:${phone}`, { type: 'json' }).catch(() => null);
  if (deletePending) {
    if (new Date(deletePending.expires) > new Date()) {
      return await handleDeletePending(store, phone, text, deletePending);
    }
    await store.delete(`delete_pending:${phone}`);
  }

  // ── YES ──
  if (normalized === 'YES') {
    // Check salary/budget pending first (most recent interaction takes priority)
    const salaryPending = await store.get(`salary_pending:${phone}`, { type: 'json' }).catch(() => null);
    if (salaryPending) {
      try {
        await writeSalaryAmount(salaryPending.sheetId, salaryPending.amount);
      } catch (e) {
        console.error('whatsapp-webhook: salary write failed', e.message);
        await store.delete(`salary_pending:${phone}`);
        return twilioResponse('Failed to update salary. Try again or use the dashboard.');
      }
      await store.delete(`salary_pending:${phone}`);
      console.log(`whatsapp-webhook: salary updated to ${salaryPending.amount} by ${phone}`);
      return twilioResponse(
        `✅ Salary updated to $${salaryPending.amount} for ${salaryPending.monthName} (was $${salaryPending.currentSalary}).`
      );
    }

    const budgetPending = await store.get(`budget_pending:${phone}`, { type: 'json' }).catch(() => null);
    if (budgetPending) {
      try {
        await writeBudgetAmount(budgetPending.sheetId, budgetPending.category, budgetPending.amount);
      } catch (e) {
        console.error('whatsapp-webhook: budget write failed', e.message);
        await store.delete(`budget_pending:${phone}`);
        return twilioResponse('Failed to update budget. Try again or use the dashboard.');
      }
      await store.delete(`budget_pending:${phone}`);
      console.log(`whatsapp-webhook: ${budgetPending.category} budget updated to ${budgetPending.amount} by ${phone}`);
      return twilioResponse(
        `✅ ${budgetPending.category} budget updated to $${budgetPending.amount} for ${budgetPending.monthName} (was $${budgetPending.currentBudget}).`
      );
    }

    // Fall through to receipt confirmation
    const { blobs } = await store.list({ prefix: `confirm:${phone}:` });

    if (!blobs || blobs.length === 0) {
      const { blobs: transferBlobs } = await store.list({ prefix: `transfer_pending:${phone}:` });
      if (transferBlobs && transferBlobs.length > 0) {
        return twilioResponse("Pick a category first (e.g. 'Misc' or 'Investment').");
      }
      return twilioResponse("No pending action to confirm.");
    }

    const key     = blobs[0].key;
    const pending = await store.get(key, { type: 'json' });

    if (!pending) {
      await store.delete(key);
      return twilioResponse("No pending receipt to confirm. Send a receipt image to get started.");
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
      ...(pending.conversionInfo ? [`(Converted from ${pending.conversionInfo.originalCurrency} ${pending.conversionInfo.original} · rate ${pending.conversionInfo.rate.toFixed(4)})`] : []),
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

  // ── SET SALARY ──
  const salaryMatch = text.trim().match(/^set\s+salary\s+\$?([\d,]+(?:\.\d{1,2})?)$/i);
  if (salaryMatch) {
    return await handleSetSalary(store, phone, salaryMatch[1]);
  }

  // ── SET BUDGET ──
  const budgetMatch = text.trim().match(/^set\s+budget\s+(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)$/i);
  if (budgetMatch) {
    return await handleSetBudget(store, phone, budgetMatch[1].trim(), budgetMatch[2]);
  }

  // ── ADD CATEGORY ──
  const catMatch = text.trim().match(/^add\s+category\s+(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)\s*(need|want|saving)?$/i);
  if (catMatch) {
    return await handleAddCategory(store, phone, catMatch[1].trim(), catMatch[2], (catMatch[3] || 'want').toLowerCase());
  }

  // ── NEW MONTH ──
  const monthMatch = text.trim().match(/^new\s+month\s+(.+)$/i);
  if (monthMatch) {
    return await handleNewMonth(store, phone, monthMatch[1].trim());
  }

  // ── DELETE ──
  const deleteMatch = text.trim().match(/^delete(?:\s+(last|#?\d+))?$/i);
  if (deleteMatch) {
    const arg = deleteMatch[1];
    if (!arg) return await handleDelete(store, phone, 'list');
    if (arg.toLowerCase() === 'last') return await handleDelete(store, phone, 'last');
    return await handleDelete(store, phone, arg.replace('#', ''));
  }

  // ── GUIDE / HELP ──
  if (/^(guide|help)$/i.test(text.trim())) {
    return twilioResponse(buildGuideMessage());
  }

  // ── Budget query (J1-J4) ──
  if (looksLikeQuery(text)) {
    try {
      const answer = await answerQuery(text);
      return twilioResponse(answer);
    } catch (e) {
      console.error('whatsapp-webhook: query failed', e.message);
      return twilioResponse("Couldn't answer that query right now. Try '? help' for examples.");
    }
  }

  // ── Category selection (completes a transfer flow) ──
  const matchedCategory = CATEGORIES.find(c => c.toUpperCase() === normalized);
  if (matchedCategory) {
    const { blobs } = await store.list({ prefix: `transfer_pending:${phone}:` });
    if (blobs && blobs.length > 0) {
      const key     = blobs[0].key;
      const pending = await store.get(key, { type: 'json' });
      if (pending) {
        pending.extraction.reward_category = matchedCategory;
        await store.delete(key);
        await store.setJSON(`confirm:${phone}:${pending.id}`, {
          ...pending,
          status: 'awaiting_confirmation',
        });
        const e = pending.extraction;
        const lines = [
          `Got it: $${e.total_amount} to ${e.store_name || 'Unknown'}`,
          `Category: ${matchedCategory}`,
        ];
        if (pending.conversionInfo) {
          lines.push(`(Converted from ${pending.conversionInfo.originalCurrency} ${pending.conversionInfo.original} · rate ${pending.conversionInfo.rate.toFixed(4)})`);
        }
        lines.push('', 'Reply YES to log, or CANCEL');
        return twilioResponse(lines.join('\n'));
      }
    }
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
      const matched = CATEGORIES.find(c => c.toLowerCase() === value.toLowerCase());
      if (!matched) {
        return twilioResponse(`Unknown category. Choose from:\n${CATEGORIES.join(', ')}`);
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

  // ── Transaction text parsing (bank SMS / payment notification) ──
  if (looksLikeTransactionText(text)) {
    const result = await extractTransactionText(text);
    if (result.ok && result.data?.total_amount != null && result.data.total_amount > 0) {
      const data = result.data;
      const conversionInfo = await maybeConvertCurrency(data);
      const now = new Date();
      const year  = data.purchase_date ? new Date(data.purchase_date).getFullYear() : now.getFullYear();
      const month = data.purchase_date
        ? new Date(data.purchase_date).toLocaleString('en-US', { month: 'long' })
        : now.toLocaleString('en-US', { month: 'long' });
      const receiptId = crypto.randomUUID();

      if (data.is_transfer) {
        await store.setJSON(`transfer_pending:${phone}:${receiptId}`, {
          id: receiptId,
          phone,
          extraction: data,
          conversionInfo,
          year,
          month,
          receivedAt: now.toISOString(),
        });
        return twilioResponse(buildTransferPrompt(data, conversionInfo));
      }

      await store.setJSON(`confirm:${phone}:${receiptId}`, {
        id: receiptId,
        phone,
        extraction: data,
        conversionInfo,
        year,
        month,
        status: 'awaiting_confirmation',
      });
      return twilioResponse(buildConfirmPrompt(data, conversionInfo));
    }
    // Fall through to help if extraction didn't yield useful data
  }

  // ── Help ──
  if (text.trim().length > 0) {
    return twilioResponse(
      'Send a receipt photo, bank screenshot, or paste a transaction SMS.\nManual: "Walmart 45.23 Grocery"\n\nType GUIDE for full command list.'
    );
  }

  return emptyTwiml();
}

// ── SET SALARY handler ──────────────────────────────────────────────────────

async function handleSetSalary(store, phone, amountStr) {
  const amount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return twilioResponse("Invalid amount. Use: SET SALARY 5500");
  }

  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return twilioResponse(`No sheet found for ${monthName}. Create the month first.`);
  }

  const totals = await getTotals(sheetId);

  if (totals.salary && totals.salary > 0) {
    await store.setJSON(`salary_pending:${phone}`, {
      amount, sheetId, monthName,
      currentSalary: totals.salary,
      createdAt: new Date().toISOString(),
    });
    return twilioResponse(
      `Salary is currently $${totals.salary} for ${monthName}.\nUpdate to $${amount}? Reply YES to confirm or CANCEL.`
    );
  }

  try {
    await writeSalaryAmount(sheetId, amount);
  } catch (e) {
    console.error('whatsapp-webhook: salary write failed', e.message);
    return twilioResponse('Failed to set salary. Try again or use the dashboard.');
  }
  console.log(`whatsapp-webhook: salary set to ${amount} for ${monthName} by ${phone}`);
  return twilioResponse(`✅ Salary set to $${amount} for ${monthName}.`);
}

// ── SET BUDGET handler ─────────────────────────────────────────────────────

async function handleSetBudget(store, phone, categoryInput, amountStr) {
  const amount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return twilioResponse("Invalid amount. Use: SET BUDGET Grocery 400");
  }

  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return twilioResponse(`No sheet found for ${monthName}. Create the month first.`);
  }

  const totals = await getTotals(sheetId);
  const matchedCat = totals.categories.find(
    c => c.name.toLowerCase() === categoryInput.toLowerCase()
  );

  if (!matchedCat) {
    const names = totals.categories.map(c => c.name).join(', ');
    return twilioResponse(`Unknown category "${categoryInput}".\nAvailable: ${names}`);
  }

  if (matchedCat.budget > 0) {
    await store.setJSON(`budget_pending:${phone}`, {
      category: matchedCat.name, amount, sheetId, monthName,
      currentBudget: matchedCat.budget,
      createdAt: new Date().toISOString(),
    });
    return twilioResponse(
      `${matchedCat.name} budget is currently $${matchedCat.budget} for ${monthName}.\nUpdate to $${amount}? Reply YES to confirm or CANCEL.`
    );
  }

  try {
    await writeBudgetAmount(sheetId, matchedCat.name, amount);
  } catch (e) {
    console.error('whatsapp-webhook: budget write failed', e.message);
    return twilioResponse('Failed to set budget. Try again or use the dashboard.');
  }
  console.log(`whatsapp-webhook: ${matchedCat.name} budget set to ${amount} for ${monthName} by ${phone}`);
  return twilioResponse(`✅ ${matchedCat.name} budget set to $${amount} for ${monthName}.`);
}

// ── ADD CATEGORY handler ───────────────────────────────────────────────────

async function handleAddCategory(store, phone, nameInput, budgetStr, type) {
  const budget = parseFloat(budgetStr.replace(/,/g, ''));
  if (isNaN(budget) || budget < 0) {
    return twilioResponse("Invalid budget. Use: ADD CATEGORY Subscriptions 80 Want");
  }

  const name = nameInput.replace(/[*?:\\/[\]]/g, '').trim();
  if (!name || name.length > 80) {
    return twilioResponse("Category name is invalid or too long (max 80 chars).");
  }

  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return twilioResponse(`No sheet found for ${monthName}. Create the month first.`);
  }

  try {
    await addCategory(sheetId, { name, budget, type });
  } catch (e) {
    if (e.message.includes('already exists')) {
      return twilioResponse(`Category "${name}" already exists.`);
    }
    if (e.message.includes('full')) {
      return twilioResponse('Totals sheet is full (max 20 categories). Remove one first.');
    }
    console.error('whatsapp-webhook: add category failed', e.message);
    return twilioResponse('Failed to add category. Try again or use the dashboard.');
  }

  const typeLabel = { need: 'Need', want: 'Want', saving: 'Saving' }[type] || 'Want';
  console.log(`whatsapp-webhook: category "${name}" added ($${budget} ${typeLabel}) for ${monthName} by ${phone}`);
  return twilioResponse(
    `✅ Category "${name}" added for ${monthName}.\nBudget: $${budget} · Type: ${typeLabel}\n\nYou can now log expenses: "${name} 25.50 ${name}"`
  );
}

// ── GUIDE message ──────────────────────────────────────────────────────────

function buildGuideMessage() {
  return [
    'BUDGET BOT GUIDE',
    '',
    'LOG EXPENSES',
    '• Send receipt photo or screenshot',
    '• Paste bank/wallet SMS text',
    '• Manual: "Walmart 45.23 Grocery"',
    '• Edit pending: "category: Travel" or "amount: 52.10"',
    '• Confirm: YES · Cancel: CANCEL',
    '',
    'BUDGET MANAGEMENT',
    '• SET SALARY 5500',
    '• SET BUDGET Grocery 400',
    '• ADD CATEGORY Subscriptions 80 Want',
    '',
    'NEW MONTH',
    '• NEW MONTH June 2026',
    '  (wizard: salary > budgets > create)',
    '',
    'DELETE (3-step security)',
    '• DELETE — list recent expenses',
    '• DELETE last · DELETE #3',
    '  > CONFIRM DELETE > type amount',
    '',
    'AFTER LOGGING',
    '• UNDO — reverse last entry (10 min)',
    '• ATTACH — add receipt photo to last entry',
    '',
    'QUERIES',
    '• ? budget — all categories',
    '• ? Grocery — single category',
    '• ? top — top spending',
    '• "how much on grocery?"',
    '',
    'Categories: Grocery, Misc, Eating Out, Travel, Entertainment, Thakkali, Investment, Car Payments, Utilities, Rent, Health, Furniture, Holiday, Wi-Fi',
  ].join('\n');
}

// ── DELETE handler (3-layer security) ──────────────────────────────────────

async function handleDelete(store, phone, target) {
  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return twilioResponse(`No sheet found for ${monthName}.`);
  }

  if (target === 'list') {
    const expenses = await getRecentExpenses(sheetId, 5);
    if (expenses.length === 0) {
      return twilioResponse('No recent expenses to delete.');
    }
    const lines = ['Recent expenses:'];
    expenses.forEach((e, i) => {
      lines.push(`#${i + 1} ${e.vendor} · $${Number(e.amount).toFixed(2)} (${e.category})`);
    });
    lines.push('', 'Reply DELETE #N or DELETE last.');
    return twilioResponse(lines.join('\n'));
  }

  let expense;
  let targetSheetId = sheetId;

  if (target === 'last') {
    const lastlog = await store.get(`lastlog:${phone}`, { type: 'json' }).catch(() => null);
    if (lastlog && lastlog.uuid) {
      expense = { category: lastlog.category, vendor: lastlog.vendor, amount: lastlog.amount, uuid: lastlog.uuid };
      targetSheetId = lastlog.sheetId || sheetId;
    } else {
      const expenses = await getRecentExpenses(sheetId, 1);
      if (expenses.length === 0) {
        return twilioResponse('No recent expenses to delete.');
      }
      expense = expenses[0];
    }
  } else {
    const idx = parseInt(target) - 1;
    const expenses = await getRecentExpenses(sheetId, 10);
    if (idx < 0 || idx >= expenses.length) {
      return twilioResponse(`No expense at #${parseInt(target)}. Send DELETE to see the list.`);
    }
    expense = expenses[idx];
  }

  if (!expense.uuid) {
    return twilioResponse('Cannot delete this entry (no tracking ID). Use the dashboard instead.');
  }

  await store.setJSON(`delete_pending:${phone}`, {
    stage: 1,
    target: { category: expense.category, vendor: expense.vendor, amount: expense.amount, uuid: expense.uuid },
    sheetId: targetSheetId,
    monthName,
    expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  const displayAmt = Number(expense.amount).toFixed(2);
  return twilioResponse(
    `⚠️ Delete this expense?\n\n${expense.vendor} · $${displayAmt}\nCategory: ${expense.category}\n\nType CONFIRM DELETE to proceed, or CANCEL.`
  );
}

async function handleDeletePending(store, phone, text, pending) {
  const normalized = text.trim().toUpperCase();
  const key = `delete_pending:${phone}`;

  if (pending.stage === 1) {
    if (normalized !== 'CONFIRM DELETE') {
      return twilioResponse('Type CONFIRM DELETE to proceed, or CANCEL.');
    }
    pending.stage = 2;
    await store.setJSON(key, pending);
    const fmtAmt = Number(pending.target.amount).toFixed(2);
    return twilioResponse(
      `Final verification: type the exact amount ($${fmtAmt}) to delete.`
    );
  }

  if (pending.stage === 2) {
    const input = parseFloat(text.trim().replace(/[\$,]/g, ''));
    const expected = Math.round(pending.target.amount * 100) / 100;
    const actual = Math.round(input * 100) / 100;
    if (isNaN(actual) || actual !== expected) {
      const expectAmt = Number(pending.target.amount).toFixed(2);
      return twilioResponse(
        `Amount doesn't match. Type exactly $${expectAmt} to confirm, or CANCEL.`
      );
    }

    try {
      await deleteExpenseByUUID({
        category: pending.target.category,
        uuid: pending.target.uuid,
        sheetId: pending.sheetId,
      });
    } catch (e) {
      console.error('whatsapp-webhook: DELETE failed', e.message);
      await store.delete(key);
      return twilioResponse('Failed to delete. The entry may have been modified. Check the dashboard.');
    }

    const lastlog = await store.get(`lastlog:${phone}`, { type: 'json' }).catch(() => null);
    if (lastlog && lastlog.uuid === pending.target.uuid) {
      await store.delete(`lastlog:${phone}`);
    }

    await store.delete(key);
    const delAmt = Number(pending.target.amount).toFixed(2);
    console.log(`whatsapp-webhook: DELETE — ${pending.target.vendor} $${delAmt} (${pending.target.category}) by ${phone}`);
    return twilioResponse(
      `✅ Deleted: ${pending.target.vendor} · $${delAmt} (${pending.target.category})`
    );
  }

  await store.delete(key);
  return twilioResponse('Delete expired. Try DELETE again.');
}

// ── NEW MONTH handler ──────────────────────────────────────────────────────

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseMonthName(input) {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const month = MONTH_NAMES.find(m => m.toLowerCase() === parts[0].toLowerCase());
  const year = parseInt(parts[1]);
  if (!month || isNaN(year) || year < 2020 || year > 2099) return null;
  return `${month} ${year}`;
}

async function handleNewMonth(store, phone, monthInput) {
  const monthName = parseMonthName(monthInput);
  if (!monthName) {
    return twilioResponse('Invalid month format. Use: NEW MONTH June 2026');
  }

  const exists = await checkMonthExists(monthName);
  if (exists) {
    return twilioResponse(`${monthName} already exists. Use SET SALARY or SET BUDGET to edit it.`);
  }

  let prevData = null;
  try { prevData = await getLatestMonthData(); } catch { /* first month */ }

  let settings = {};
  try { settings = await getUserSettings(); } catch { /* no settings */ }

  const wizard = {
    monthName,
    stage: 1,
    salary: null,
    budgetChanges: {},
    prevSalary: prevData?.salary || 0,
    prevBudgets: prevData?.budgets || [],
    recurringExpenses: settings.recurringExpenses || [],
    customCategories: settings.customCategories || [],
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  await store.setJSON(`new_month_wizard:${phone}`, wizard);

  const salaryLine = prevData?.salary
    ? `Previous salary: $${prevData.salary}`
    : 'No previous salary found';

  return twilioResponse(
    `Creating ${monthName}.\n\n${salaryLine}\nEnter salary amount, or SAME to keep it.\n(CANCEL to abort)`
  );
}

async function handleNewMonthWizard(store, phone, text, wizard) {
  const normalized = text.trim().toUpperCase();
  const key = `new_month_wizard:${phone}`;

  if (wizard.stage === 1) {
    if (normalized === 'SAME') {
      wizard.salary = wizard.prevSalary;
    } else {
      const amount = parseFloat(text.trim().replace(/[\$,]/g, ''));
      if (isNaN(amount) || amount <= 0) {
        return twilioResponse('Enter a salary amount (e.g. 5500) or SAME.');
      }
      wizard.salary = amount;
    }

    wizard.stage = 2;
    await store.setJSON(key, wizard);

    if (wizard.prevBudgets.length === 0) {
      wizard.stage = 3;
      await store.setJSON(key, wizard);
      return twilioResponse(buildNewMonthSummary(wizard));
    }

    const lines = [`Salary: $${wizard.salary}\n`, 'Budgets:'];
    for (const cat of wizard.prevBudgets) {
      lines.push(`  ${cat.name}: $${cat.budget}`);
    }
    lines.push('', 'Send "CategoryName Amount" to change, SAME to keep all, or DONE when finished.');
    return twilioResponse(lines.join('\n'));
  }

  if (wizard.stage === 2) {
    if (normalized === 'SAME' || normalized === 'DONE') {
      for (const cat of wizard.prevBudgets) {
        if (wizard.budgetChanges[cat.name] == null) {
          wizard.budgetChanges[cat.name] = cat.budget;
        }
      }
      wizard.stage = 3;
      await store.setJSON(key, wizard);
      return twilioResponse(buildNewMonthSummary(wizard));
    }

    const budgetEdit = text.trim().match(/^(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)$/);
    if (budgetEdit) {
      const catName = budgetEdit[1].trim();
      const amount = parseFloat(budgetEdit[2].replace(/,/g, ''));
      const matched = wizard.prevBudgets.find(c => c.name.toLowerCase() === catName.toLowerCase());

      if (!matched) {
        const names = wizard.prevBudgets.map(c => c.name).join(', ');
        return twilioResponse(`Unknown category "${catName}".\nAvailable: ${names}`);
      }

      if (isNaN(amount) || amount < 0) {
        return twilioResponse('Invalid amount. Use: CategoryName Amount (e.g. Grocery 500)');
      }

      wizard.budgetChanges[matched.name] = amount;
      await store.setJSON(key, wizard);

      return twilioResponse(`${matched.name} → $${amount}\nMore changes, SAME for remaining, or DONE to finish.`);
    }

    return twilioResponse('Send "CategoryName Amount" to change, SAME to keep all, or DONE when finished.');
  }

  if (wizard.stage === 3) {
    if (normalized !== 'YES') {
      return twilioResponse('Reply YES to create, or CANCEL to abort.');
    }

    let result;
    try {
      result = await createMonth({
        monthName: wizard.monthName,
        salary: wizard.salary,
        budgetChanges: wizard.budgetChanges,
      });
    } catch (e) {
      console.error('whatsapp-webhook: createMonth failed', e.message);
      await store.delete(key);
      return twilioResponse(`Failed to create ${wizard.monthName}. Try again or use the dashboard.`);
    }

    wizard.createdSheetId = result.sheetId;

    if (wizard.recurringExpenses.length > 0) {
      wizard.stage = 4;
      await store.setJSON(key, wizard);

      const lines = [`✅ ${wizard.monthName} created!\n`, 'Recurring expenses:'];
      for (const exp of wizard.recurringExpenses) {
        lines.push(`  ${exp.vendor} · $${exp.amount} (${exp.category})`);
      }
      lines.push('', 'Log them all? Reply YES or SKIP.');
      return twilioResponse(lines.join('\n'));
    }

    await store.delete(key);
    console.log(`whatsapp-webhook: NEW MONTH ${wizard.monthName} created by ${phone}`);
    return twilioResponse(`✅ ${wizard.monthName} created!\nSalary: $${wizard.salary}\nSheet is ready to use.`);
  }

  if (wizard.stage === 4) {
    if (normalized === 'YES') {
      let logged = 0;
      for (const exp of wizard.recurringExpenses) {
        try {
          await appendExpense({
            category: exp.category,
            vendor: exp.vendor,
            amount: exp.amount,
            sheetId: wizard.createdSheetId,
            monthName: wizard.monthName,
          });
          logged++;
        } catch (e) {
          console.warn(`createMonth: recurring "${exp.vendor}" failed:`, e.message);
        }
      }
      await store.delete(key);
      console.log(`whatsapp-webhook: NEW MONTH ${wizard.monthName} created with ${logged} recurring by ${phone}`);
      return twilioResponse(`✅ ${wizard.monthName} ready!\n${logged} recurring expense${logged !== 1 ? 's' : ''} logged.`);
    }

    if (normalized === 'SKIP') {
      await store.delete(key);
      console.log(`whatsapp-webhook: NEW MONTH ${wizard.monthName} created (recurring skipped) by ${phone}`);
      return twilioResponse(`✅ ${wizard.monthName} created!\nRecurring expenses skipped.`);
    }

    return twilioResponse('Reply YES to log recurring expenses, or SKIP.');
  }

  await store.delete(key);
  return twilioResponse('Wizard expired. Try NEW MONTH again.');
}

function buildNewMonthSummary(wizard) {
  const lines = [`New month: ${wizard.monthName}\n`, `Salary: $${wizard.salary}`, '', 'Budgets:'];
  for (const cat of wizard.prevBudgets) {
    const amt = wizard.budgetChanges[cat.name] ?? cat.budget;
    const changed = wizard.budgetChanges[cat.name] != null && wizard.budgetChanges[cat.name] !== cat.budget;
    lines.push(`  ${cat.name}: $${amt}${changed ? ' ←' : ''}`);
  }
  if (wizard.recurringExpenses.length > 0) {
    lines.push('', `${wizard.recurringExpenses.length} recurring expense(s) will be asked after creation.`);
  }
  lines.push('', 'Reply YES to create, or CANCEL.');
  return lines.join('\n');
}

function looksLikeTransactionText(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 15) return false;
  // Currency symbols, "USD"/"INR" etc., or amounts with cents
  return /[\$₹€£¥]|\b(usd|inr|eur|gbp|aed|jpy|cad|aud)\b|\d+\.\d{2}/i.test(trimmed);
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
