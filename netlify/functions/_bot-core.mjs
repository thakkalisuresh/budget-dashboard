/**
 * Transport-agnostic bot business logic.
 * Shared by whatsapp-webhook.mjs and telegram-webhook.mjs.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 *
 * All handlers receive a ctx object:
 *   { store, userId, chatId, send(message, markup?) }
 */

import crypto from 'node:crypto';
import { extractReceipt, extractTransactionText, CATEGORIES } from './_extraction.mjs';
import { uploadReceiptImage, moveFile, buildFolderPath } from './_drive.mjs';
import {
  getCurrentMonthSheetId, appendExpense, deleteExpenseByUUID,
  getTotals, getRecentExpenses, writeSalaryAmount, writeBudgetAmount,
  addCategory, checkMonthExists, getLatestMonthData, getUserSettings,
  createMonth, getAllowedEmails, updateUserSettingsFor,
} from './_sheets.mjs';
import { getStore } from '@netlify/blobs';
import { convertToUSD } from './_currency.mjs';
import { looksLikeQuery, answerQuery } from './_query.mjs';
import { buildRewardsLine, getEffectiveRates } from './_card-rewards.mjs';
import { kbYesCancel, kbYesSkip, kbConfirmDelete } from './_telegram.mjs';

const DAILY_LIMIT    = 50;
const UNDO_WINDOW_MS = 10 * 60 * 1000;
const DASHBOARD_URL  = process.env.SITE_URL || 'https://budget-dashboard-tracker.netlify.app';

/* ── Card resolution (server-side mirror of src/smartRules + resolveCardName) ── */

const normCard = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function resolveCardName(raw, cards = []) {
  if (!raw || !cards.length) return '';
  const r = normCard(raw);
  if (!r) return '';
  for (const c of cards) if (normCard(c) === r) return c;
  for (const c of cards) {
    const nc = normCard(c);
    if (nc.length >= 5 && r.length >= 5 && (nc.includes(r) || r.includes(nc))) return c;
  }
  return '';
}

function applyCardRules(vendor, category, rules = []) {
  if (!vendor || !rules.length) return '';
  const v = vendor.toLowerCase().trim();
  const matches = rules.filter(rule => {
    if (!rule.vendorPattern?.trim()) return false;
    if (!v.includes(rule.vendorPattern.toLowerCase().trim())) return false;
    if (rule.category && rule.category !== category) return false;
    return true;
  });
  if (!matches.length) return '';
  matches.sort((a, b) => {
    const aSpec = a.category ? 1 : 0, bSpec = b.category ? 1 : 0;
    if (bSpec !== aSpec) return bSpec - aSpec;
    return b.vendorPattern.length - a.vendorPattern.length;
  });
  return matches[0].card || '';
}

/** Vision card → fuzzy match → card rules → '' */
function resolveCard(visionCard, vendor, category, settings = {}) {
  return resolveCardName(visionCard, settings.cards || [])
    || applyCardRules(vendor, category, settings.cardRules || [])
    || '';
}

const sheetUrl = (sheetId) => sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}` : DASHBOARD_URL;

/* ── Rate limiting ── */

async function getRateCount(store, userId) {
  const key = `rate:${userId}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const val = await store.get(key, { type: 'json' });
    return val?.count || 0;
  } catch { return 0; }
}

async function incrementRateCount(store, userId) {
  const key = `rate:${userId}:${new Date().toISOString().slice(0, 10)}`;
  let count = 0;
  try {
    const val = await store.get(key, { type: 'json' });
    count = val?.count || 0;
  } catch { /* new entry */ }
  await store.setJSON(key, { count: count + 1 });
}

/* ══════════════════════════════════════════════════════════════════════════════
   PUBLIC: handleTextReply
   ══════════════════════════════════════════════════════════════════════════════ */

export async function handleTextReply(ctx, text) {
  const { store, userId } = ctx;

  // Any text message clears an awaiting ATTACH state
  await store.delete(`awaiting_attach:${userId}`).catch(() => {});

  const normalized = text.trim().toUpperCase();

  // ── CANCEL ──
  if (normalized === 'CANCEL') {
    let cancelledAny = false;
    for (const key of [
      `salary_pending:${userId}`, `budget_pending:${userId}`,
      `new_month_wizard:${userId}`, `delete_pending:${userId}`,
    ]) {
      try {
        const val = await store.get(key, { type: 'json' });
        if (val) { await store.delete(key); cancelledAny = true; }
      } catch { /* no pending */ }
    }
    for (const prefix of [`confirm:${userId}:`, `transfer_pending:${userId}:`]) {
      const { blobs } = await store.list({ prefix });
      for (const b of (blobs || [])) {
        await store.delete(b.key);
        cancelledAny = true;
      }
    }
    console.log(`bot-core: CANCEL by ${userId} (cleaned ${cancelledAny ? 'pending' : 'nothing'})`);
    return ctx.send(cancelledAny ? 'Cancelled.' : 'Nothing to cancel.');
  }

  // ── NEW MONTH wizard (active) ──
  const wizardState = await store.get(`new_month_wizard:${userId}`, { type: 'json' }).catch(() => null);
  if (wizardState) {
    if (new Date(wizardState.expires) > new Date()) {
      return await handleNewMonthWizard(ctx, text, wizardState);
    }
    await store.delete(`new_month_wizard:${userId}`);
  }

  // ── DELETE pending (3-layer security) ──
  const deletePending = await store.get(`delete_pending:${userId}`, { type: 'json' }).catch(() => null);
  if (deletePending) {
    if (new Date(deletePending.expires) > new Date()) {
      return await handleDeletePending(ctx, text, deletePending);
    }
    await store.delete(`delete_pending:${userId}`);
  }

  // ── YES ──
  if (normalized === 'YES') {
    // Check salary/budget pending first
    const salaryPending = await store.get(`salary_pending:${userId}`, { type: 'json' }).catch(() => null);
    if (salaryPending) {
      try {
        await writeSalaryAmount(salaryPending.sheetId, salaryPending.amount);
      } catch (e) {
        console.error('bot-core: salary write failed', e.message);
        await store.delete(`salary_pending:${userId}`);
        return ctx.send('Failed to update salary. Try again or use the dashboard.');
      }
      await store.delete(`salary_pending:${userId}`);
      console.log(`bot-core: salary updated to ${salaryPending.amount} by ${userId}`);
      return ctx.send(
        `✅ Salary updated to $${salaryPending.amount} for ${salaryPending.monthName} (was $${salaryPending.currentSalary}).`
      );
    }

    const budgetPending = await store.get(`budget_pending:${userId}`, { type: 'json' }).catch(() => null);
    if (budgetPending) {
      try {
        await writeBudgetAmount(budgetPending.sheetId, budgetPending.category, budgetPending.amount);
      } catch (e) {
        console.error('bot-core: budget write failed', e.message);
        await store.delete(`budget_pending:${userId}`);
        return ctx.send('Failed to update budget. Try again or use the dashboard.');
      }
      await store.delete(`budget_pending:${userId}`);
      console.log(`bot-core: ${budgetPending.category} budget updated to ${budgetPending.amount} by ${userId}`);
      return ctx.send(
        `✅ ${budgetPending.category} budget updated to $${budgetPending.amount} for ${budgetPending.monthName} (was $${budgetPending.currentBudget}).`
      );
    }

    // Fall through to receipt confirmation
    const { blobs } = await store.list({ prefix: `confirm:${userId}:` });

    if (!blobs || blobs.length === 0) {
      const { blobs: transferBlobs } = await store.list({ prefix: `transfer_pending:${userId}:` });
      if (transferBlobs && transferBlobs.length > 0) {
        return ctx.send("Pick a category first (e.g. 'Misc' or 'Investment').");
      }
      return ctx.send("No pending action to confirm.");
    }

    const key     = blobs[0].key;
    const pending = await store.get(key, { type: 'json' });

    if (!pending) {
      await store.delete(key);
      return ctx.send("No pending receipt to confirm. Send a receipt photo to get started.");
    }

    const { extraction, driveFileId, year, month } = pending;
    const category      = extraction.reward_category || 'Misc';
    const vendor        = extraction.store_name || 'Unknown';
    const amount        = extraction.total_amount;
    const txDate        = extraction.purchase_date;
    const paymentMethod = extraction.payment_method || '';
    const bookingMethod = extraction.booking_method || '';
    const monthName     = `${month} ${year}`;

    let sheetId;
    try {
      sheetId = await getCurrentMonthSheetId(monthName);
    } catch (e) {
      console.error('bot-core: could not find month sheet', e.message);
      return ctx.send(`Could not find sheet for ${monthName}. Please log this receipt via the dashboard.`);
    }

    let result;
    try {
      result = await appendExpense({ category, vendor, amount, txDate, sheetId, monthName, paymentMethod, channel: ctx.channel, bookingMethod });
    } catch (e) {
      console.error('bot-core: Sheets append failed', e.message);
      return ctx.send('Failed to log receipt to spreadsheet. Please try via the dashboard.');
    }

    if (driveFileId) {
      try {
        const { folderId } = await buildFolderPath(year, month, category);
        await moveFile(driveFileId, folderId);
      } catch (e) {
        console.warn('bot-core: Drive move failed (non-fatal)', e.message);
      }
    }

    await store.setJSON(`lastlog:${userId}`, {
      uuid: result.uuid, category, vendor, amount, txDate, paymentMethod, bookingMethod,
      sheetId, monthName, year, month,
      driveFileId: driveFileId || null,
      driveShareLink: pending.driveShareLink || null,
      loggedAt: new Date().toISOString(),
    });

    await store.delete(key);
    console.log(`bot-core: receipt ${pending.id} confirmed — ${vendor} $${amount} → ${category}`);

    const hints = ['UNDO to reverse'];
    if (!driveFileId) hints.push('ATTACH to add receipt photo');

    let _rateSettings = {};
    try { _rateSettings = await getUserSettings(); } catch { /* use defaults */ }
    const rewardsLine = paymentMethod ? buildRewardsLine(paymentMethod, category, amount, vendor, getEffectiveRates(_rateSettings)) : '';

    const summary = [
      'Receipt logged!',
      '',
      `Store/Vendor: ${vendor}`,
      `Date: ${txDate || 'Today'}`,
      `Category: ${category}`,
      `Total: $${amount}`,
      ...(paymentMethod ? [`Card: ${paymentMethod}`] : []),
      ...(rewardsLine ? [rewardsLine] : []),
      ...(pending.conversionInfo ? [`(Converted from ${pending.conversionInfo.originalCurrency} ${pending.conversionInfo.original} · rate ${pending.conversionInfo.rate.toFixed(4)})`] : []),
      ...(pending.driveShareLink ? [`View Receipt: ${pending.driveShareLink}`] : []),
      `View Sheet: ${sheetUrl(sheetId)}`,
      '',
      hints.join(' · '),
    ].join('\n');

    return ctx.send(summary);
  }

  // ── UNDO ──
  if (normalized === 'UNDO') {
    const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
    if (!lastlog) {
      return ctx.send("Nothing to undo.");
    }

    const elapsed = Date.now() - new Date(lastlog.loggedAt).getTime();
    if (elapsed > UNDO_WINDOW_MS) {
      return ctx.send("Undo window expired (10 min). Edit the entry in the dashboard instead.");
    }

    try {
      await deleteExpenseByUUID({ category: lastlog.category, uuid: lastlog.uuid, sheetId: lastlog.sheetId });
    } catch (e) {
      console.error('bot-core: UNDO delete failed', e.message);
      return ctx.send('Could not undo. The entry may have been modified. Check the dashboard.');
    }

    await store.delete(`lastlog:${userId}`);
    console.log(`bot-core: UNDO — ${lastlog.vendor} $${lastlog.amount} removed by ${userId}`);

    return ctx.send(`Undone: ${lastlog.vendor} $${lastlog.amount} (${lastlog.category}) removed.`);
  }

  // ── ATTACH ──
  if (normalized === 'ATTACH') {
    const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
    if (!lastlog) {
      return ctx.send("No recent entry to attach a receipt to.");
    }
    if (lastlog.driveFileId) {
      return ctx.send("Your last entry already has a receipt attached.");
    }

    await store.setJSON(`awaiting_attach:${userId}`, {
      ...lastlog,
      requestedAt: new Date().toISOString(),
    });

    return ctx.send(
      `Send the receipt photo for:\n${lastlog.vendor} · $${lastlog.amount} (${lastlog.category})`
    );
  }

  // ── APPLY RATES / IGNORE (monthly rate auto-check response) ──
  if (normalized === 'APPLY RATES' || normalized === 'APPLY') {
    const proposals = getStore('rate-proposals');
    const proposal = await proposals.get('latest', { type: 'json' }).catch(() => null);
    if (!proposal || !proposal.rates) {
      return ctx.send('No pending rate change to apply.');
    }
    const emails = getAllowedEmails();
    let updated = 0;
    for (const email of emails) {
      try {
        await updateUserSettingsFor(email, (s) => { s.cardRewardRates = proposal.rates; return s; });
        updated++;
      } catch (e) {
        console.error('bot-core: APPLY RATES write failed for', email, e.message);
      }
    }
    if (updated === 0) {
      return ctx.send('Failed to update rates. Please try again or use the dashboard.');
    }
    await proposals.delete('latest').catch(() => {});
    const cards = (proposal.summary || []).map(c => c.card).join(', ');
    console.log(`bot-core: rates applied to ${updated} account(s) by ${userId}`);
    return ctx.send(
      `✅ Rates updated for the household${cards ? ` (${cards})` : ''}. Future rewards calculations will use the new rates.`
    );
  }
  if (normalized === 'IGNORE') {
    const proposals = getStore('rate-proposals');
    const proposal = await proposals.get('latest', { type: 'json' }).catch(() => null);
    if (!proposal) {
      return ctx.send('No pending rate change to ignore.');
    }
    await proposals.delete('latest').catch(() => {});
    return ctx.send('👍 Keeping current rates. The proposed change has been discarded.');
  }

  // ── SET SALARY ──
  const salaryMatch = text.trim().match(/^set\s+salary\s+\$?([\d,]+(?:\.\d{1,2})?)$/i);
  if (salaryMatch) {
    return await handleSetSalary(ctx, salaryMatch[1]);
  }

  // ── SET BUDGET ──
  const budgetMatch = text.trim().match(/^set\s+budget\s+(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)$/i);
  if (budgetMatch) {
    return await handleSetBudget(ctx, budgetMatch[1].trim(), budgetMatch[2]);
  }

  // ── ADD CATEGORY ──
  const catMatch = text.trim().match(/^add\s+category\s+(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)\s*(need|want|saving)?$/i);
  if (catMatch) {
    return await handleAddCategory(ctx, catMatch[1].trim(), catMatch[2], (catMatch[3] || 'want').toLowerCase());
  }

  // ── NEW MONTH ──
  const monthMatch = text.trim().match(/^new\s+month\s+(.+)$/i);
  if (monthMatch) {
    return await handleNewMonth(ctx, monthMatch[1].trim());
  }

  // ── DELETE ──
  const deleteMatch = text.trim().match(/^delete(?:\s+(last|#?\d+))?$/i);
  if (deleteMatch) {
    const arg = deleteMatch[1];
    if (!arg) return await handleDelete(ctx, 'list');
    if (arg.toLowerCase() === 'last') return await handleDelete(ctx, 'last');
    return await handleDelete(ctx, arg.replace('#', ''));
  }

  // ── GUIDE / HELP ──
  if (/^(guide|help)$/i.test(text.trim())) {
    return ctx.send(buildGuideMessage());
  }

  // ── Budget query (J1-J4) ──
  if (looksLikeQuery(text)) {
    try {
      const answer = await answerQuery(text);
      return ctx.send(answer);
    } catch (e) {
      console.error('bot-core: query failed', e.message);
      return ctx.send("Couldn't answer that query right now. Try '? help' for examples.");
    }
  }

  // ── Category selection (completes a transfer flow) ──
  const matchedCategory = CATEGORIES.find(c => c.toUpperCase() === normalized);
  if (matchedCategory) {
    const { blobs } = await store.list({ prefix: `transfer_pending:${userId}:` });
    if (blobs && blobs.length > 0) {
      const key     = blobs[0].key;
      const pending = await store.get(key, { type: 'json' });
      if (pending) {
        pending.extraction.reward_category = matchedCategory;
        await store.delete(key);
        await store.setJSON(`confirm:${userId}:${pending.id}`, {
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
        return ctx.send(lines.join('\n'), kbYesCancel());
      }
    }
  }

  // ── Field edit: "category: X", "amount: X", "store: X", "date: X", "card: X" ──
  const editMatch = text.trim().match(/^(category|amount|store|date|card|booking)\s*:\s*(.+)$/i);
  if (editMatch) {
    const { blobs } = await store.list({ prefix: `confirm:${userId}:` });
    if (!blobs || blobs.length === 0) {
      return ctx.send("No pending receipt to edit. Send a receipt image first.");
    }

    const key     = blobs[0].key;
    const pending = await store.get(key, { type: 'json' });
    if (!pending) {
      return ctx.send("No pending receipt to edit.");
    }

    const field = editMatch[1].toLowerCase();
    const value = editMatch[2].trim();

    if (field === 'category') {
      const matched = CATEGORIES.find(c => c.toLowerCase() === value.toLowerCase());
      if (!matched) {
        return ctx.send(`Unknown category. Choose from:\n${CATEGORIES.join(', ')}`);
      }
      pending.extraction.reward_category = matched;
    } else if (field === 'amount') {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) {
        return ctx.send("Invalid amount. Use a positive number (e.g., 'amount: 52.10')");
      }
      pending.extraction.total_amount = num;
    } else if (field === 'store') {
      pending.extraction.store_name = value;
    } else if (field === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return ctx.send("Date must be YYYY-MM-DD (e.g., 'date: 2026-05-20')");
      }
      pending.extraction.purchase_date = value;
      pending.year = new Date(value).getFullYear();
      pending.month = new Date(value).toLocaleString('en-US', { month: 'long' });
    } else if (field === 'card') {
      let settings = {};
      try { settings = await getUserSettings(); } catch { /* no settings */ }
      const cards = settings.cards || [];
      const matched = resolveCardName(value, cards) || cards.find(c => c.toLowerCase() === value.toLowerCase());
      if (!matched) {
        return ctx.send(cards.length
          ? `Unknown card. Choose from:\n${cards.join(', ')}`
          : 'No cards configured. Add cards in the dashboard settings first.');
      }
      pending.extraction.payment_method = matched;
    } else if (field === 'booking') {
      const method = value.toLowerCase();
      if (method !== 'portal' && method !== 'direct') {
        return ctx.send("Booking must be 'portal' (8x UR) or 'direct' (4x UR).");
      }
      pending.extraction.booking_method = method === 'direct' ? 'direct' : '';
    }

    await store.setJSON(key, pending);

    const e = pending.extraction;
    const lines = [
      'Updated!',
      `Store: ${e.store_name || 'Unknown'}`,
      `Date: ${e.purchase_date || 'Unknown'}`,
      `Category: ${e.reward_category || 'Misc'}`,
      `Total: $${e.total_amount ?? '?'}`,
    ];
    if (e.payment_method) lines.push(`Card: ${e.payment_method}`);
    if (e.booking_method) lines.push(`Booking: Direct (4x UR)`);
    lines.push('', 'Reply YES to log, or CANCEL');
    return ctx.send(lines.join('\n'), kbYesCancel());
  }

  // ── Manual entry: "Walmart 45.23 Grocery" ──
  const manualMatch = text.trim().match(/^(.+?)\s+([\d.]+)\s+(\w[\w\s-]*)$/);
  if (manualMatch) {
    const [, vendor, amountStr, category] = manualMatch;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      return ctx.send("Invalid amount. Use: StoreName Amount Category (e.g., 'Walmart 45.23 Grocery')");
    }

    const matchedCat = CATEGORIES.find(c => c.toLowerCase() === category.trim().toLowerCase()) || 'Misc';
    const now = new Date();

    // Resolve card from rules (no vision data on manual entries)
    let cardName = '';
    try {
      const settings = await getUserSettings();
      cardName = applyCardRules(vendor.trim(), matchedCat, settings.cardRules || []);
    } catch { /* non-fatal */ }

    // Check for failed pending extraction (preserves image data if available)
    const { blobs } = await store.list({ prefix: 'pending:' });
    const failedBlob = await findFailedPending(store, blobs, userId);

    let pendingData = {};
    if (failedBlob) {
      const pending = await store.get(failedBlob.key, { type: 'json' });
      pendingData = { mediaType: pending.mediaType, base64: pending.base64 };
      await store.delete(failedBlob.key);
    }

    const receiptId = crypto.randomUUID();
    await store.setJSON(`confirm:${userId}:${receiptId}`, {
      id: receiptId,
      phone: userId,
      ...pendingData,
      extraction: {
        store_name: vendor.trim(),
        purchase_date: now.toISOString().slice(0, 10),
        total_amount: amount,
        tax_amount: null,
        currency: 'USD',
        items: [],
        reward_category: matchedCat,
        payment_method: cardName,
      },
      year: now.getFullYear(),
      month: now.toLocaleString('en-US', { month: 'long' }),
      status: 'awaiting_confirmation',
    });

    const lines = [`Got it:`, `Store: ${vendor.trim()}`, `Category: ${matchedCat}`, `Total: $${amount}`];
    if (cardName) lines.push(`Card: ${cardName}`);
    lines.push('', 'Reply YES to log, or CANCEL');
    return ctx.send(lines.join('\n'), kbYesCancel());
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
        await store.setJSON(`transfer_pending:${userId}:${receiptId}`, {
          id: receiptId,
          phone: userId,
          extraction: data,
          conversionInfo,
          year,
          month,
          receivedAt: now.toISOString(),
        });
        return ctx.send(buildTransferPrompt(data, conversionInfo));
      }

      // Resolve card: Vision-less, so rules only (plus any card the parser surfaced)
      try {
        const settings = await getUserSettings();
        data.payment_method = resolveCard(data.payment_method, data.store_name, data.reward_category, settings);
      } catch { /* non-fatal */ }

      await store.setJSON(`confirm:${userId}:${receiptId}`, {
        id: receiptId,
        phone: userId,
        extraction: data,
        conversionInfo,
        year,
        month,
        status: 'awaiting_confirmation',
      });
      return ctx.send(buildConfirmPrompt(data, conversionInfo), kbYesCancel());
    }
    // Fall through to help if extraction didn't yield useful data
  }

  // ── Help ──
  if (text.trim().length > 0) {
    return ctx.send(
      'Send a receipt photo, bank screenshot, or paste a transaction SMS.\nManual: "Walmart 45.23 Grocery"\n\nType GUIDE for full command list.'
    );
  }

  // Empty text — no response
}

/* ══════════════════════════════════════════════════════════════════════════════
   PUBLIC: handleMediaMessage  (receipt extraction + confirmation flow)
   ══════════════════════════════════════════════════════════════════════════════ */

export async function handleMediaMessage(ctx, base64, mediaType) {
  const { store, userId } = ctx;

  const rateCount = await getRateCount(store, userId);
  if (rateCount >= DAILY_LIMIT) {
    return ctx.send("You've reached 50 receipts today. Try again tomorrow.");
  }

  await incrementRateCount(store, userId);

  const receiptId = crypto.randomUUID();

  const extraction = await extractReceipt(base64, mediaType);

  if (!extraction.ok || extraction.data?.total_amount == null) {
    await store.setJSON(`pending:${receiptId}`, {
      id: receiptId, userId, mediaType, base64,
      receivedAt: new Date().toISOString(),
      status: 'extraction_failed',
    });
    const msg = !extraction.ok
      ? "Couldn't parse receipt clearly. Reply with: Store name, amount, category\n(e.g., 'Walmart 45.23 Grocery')"
      : "Receipt unclear. Please confirm total amount.\nReply with: Store name, amount, category (e.g., 'Walmart 45.23 Grocery')";
    return ctx.send(msg);
  }

  const { data } = extraction;
  const now = new Date();
  const year  = data.purchase_date ? new Date(data.purchase_date).getFullYear() : now.getFullYear();
  const month = data.purchase_date
    ? new Date(data.purchase_date).toLocaleString('en-US', { month: 'long' })
    : now.toLocaleString('en-US', { month: 'long' });

  const conversionInfo = await maybeConvertCurrency(data);

  // Resolve payment method: Vision card → fuzzy match → card rules
  let cardName = '';
  try {
    const settings = await getUserSettings();
    cardName = resolveCard(data.payment_method, data.store_name, data.reward_category, settings);
  } catch (e) {
    console.warn('bot-core: card resolution failed (non-fatal)', e.message);
  }
  data.payment_method = cardName;

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
    console.error('bot-core: Drive upload failed', e.message);
  }

  // Transfer detected — ask user to pick category
  if (data.is_transfer) {
    await store.setJSON(`transfer_pending:${userId}:${receiptId}`, {
      id: receiptId,
      phone: userId,
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
    return ctx.send(buildTransferPrompt(data, conversionInfo));
  }

  await store.setJSON(`confirm:${userId}:${receiptId}`, {
    id: receiptId,
    phone: userId,
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

  console.log(`bot-core: receipt ${receiptId} extracted for ${userId} — ${data.store_name} $${data.total_amount}`);

  return ctx.send(buildConfirmPrompt(data, conversionInfo), kbYesCancel());
}

/* ══════════════════════════════════════════════════════════════════════════════
   PUBLIC: handleAttachMedia  (ATTACH photo to last entry)
   ══════════════════════════════════════════════════════════════════════════════ */

export async function handleAttachMedia(ctx, base64, mediaType, attachState) {
  const { store, userId } = ctx;
  const { year, month, category, vendor, amount } = attachState;

  let driveResult;
  try {
    const fileName = `receipt-${Date.now()}.${mediaType === 'application/pdf' ? 'pdf' : 'jpg'}`;
    driveResult = await uploadReceiptImage({
      year, month, category, fileName, mimeType: mediaType, base64,
    });
  } catch (e) {
    console.error('bot-core: ATTACH Drive upload failed', e.message);
    return ctx.send('Failed to upload receipt to Drive. Try again.');
  }

  const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
  if (lastlog && lastlog.uuid === attachState.uuid) {
    lastlog.driveFileId = driveResult.fileId;
    lastlog.driveShareLink = driveResult.shareLink;
    await store.setJSON(`lastlog:${userId}`, lastlog);
  }

  await store.delete(`awaiting_attach:${userId}`);
  console.log(`bot-core: ATTACH — receipt uploaded for ${vendor} $${amount} by ${userId}`);

  return ctx.send(
    `Receipt attached!\n${vendor} · $${amount} (${category})\nView: ${driveResult.shareLink}`
  );
}

/* ── Helpers: currency + prompts ─────────────────────────────────────────── */

async function maybeConvertCurrency(data) {
  if (!data.currency || data.currency === 'USD') return null;
  if (typeof data.total_amount !== 'number' || data.total_amount <= 0) return null;
  try {
    const info = await convertToUSD(data.total_amount, data.currency);
    data.total_amount = info.amount;
    return info;
  } catch (e) {
    console.warn('bot-core: currency conversion failed', e.message);
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
  if (data.payment_method) lines.push(`Card: ${data.payment_method}`);
  if (data.payment_method === 'Chase Sapphire Reserve' &&
      (data.reward_category === 'Travel' || data.reward_category === 'Holiday')) {
    const bm = data.booking_method || '';
    lines.push(`Booking: ${bm === 'direct' ? 'Direct (4x UR)' : 'Chase Travel portal (8x UR)'}`);
  }
  if (conversionInfo) {
    lines.push(`(Converted from ${conversionInfo.originalCurrency} ${conversionInfo.original} · rate ${conversionInfo.rate.toFixed(4)})`);
  }
  lines.push('', 'Reply YES to log, or CANCEL', 'Edit: "category: Travel", "amount: 52.10", "card: Chase", or "booking: direct"');
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

/* ── SET SALARY handler ──────────────────────────────────────────────────── */

async function handleSetSalary(ctx, amountStr) {
  const { store, userId } = ctx;
  const amount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return ctx.send("Invalid amount. Use: SET SALARY 5500");
  }

  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return ctx.send(`No sheet found for ${monthName}. Create the month first.`);
  }

  const totals = await getTotals(sheetId);

  if (totals.salary && totals.salary > 0) {
    await store.setJSON(`salary_pending:${userId}`, {
      amount, sheetId, monthName,
      currentSalary: totals.salary,
      createdAt: new Date().toISOString(),
    });
    return ctx.send(
      `Salary is currently $${totals.salary} for ${monthName}.\nUpdate to $${amount}? Reply YES to confirm or CANCEL.`,
      kbYesCancel()
    );
  }

  try {
    await writeSalaryAmount(sheetId, amount);
  } catch (e) {
    console.error('bot-core: salary write failed', e.message);
    return ctx.send('Failed to set salary. Try again or use the dashboard.');
  }
  console.log(`bot-core: salary set to ${amount} for ${monthName} by ${userId}`);
  return ctx.send(`✅ Salary set to $${amount} for ${monthName}.`);
}

/* ── SET BUDGET handler ──────────────────────────────────────────────────── */

async function handleSetBudget(ctx, categoryInput, amountStr) {
  const { store, userId } = ctx;
  const amount = parseFloat(amountStr.replace(/,/g, ''));
  if (isNaN(amount) || amount <= 0) {
    return ctx.send("Invalid amount. Use: SET BUDGET Grocery 400");
  }

  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return ctx.send(`No sheet found for ${monthName}. Create the month first.`);
  }

  const totals = await getTotals(sheetId);
  const matchedCat = totals.categories.find(
    c => c.name.toLowerCase() === categoryInput.toLowerCase()
  );

  if (!matchedCat) {
    const names = totals.categories.map(c => c.name).join(', ');
    return ctx.send(`Unknown category "${categoryInput}".\nAvailable: ${names}`);
  }

  if (matchedCat.budget > 0) {
    await store.setJSON(`budget_pending:${userId}`, {
      category: matchedCat.name, amount, sheetId, monthName,
      currentBudget: matchedCat.budget,
      createdAt: new Date().toISOString(),
    });
    return ctx.send(
      `${matchedCat.name} budget is currently $${matchedCat.budget} for ${monthName}.\nUpdate to $${amount}? Reply YES to confirm or CANCEL.`,
      kbYesCancel()
    );
  }

  try {
    await writeBudgetAmount(sheetId, matchedCat.name, amount);
  } catch (e) {
    console.error('bot-core: budget write failed', e.message);
    return ctx.send('Failed to set budget. Try again or use the dashboard.');
  }
  console.log(`bot-core: ${matchedCat.name} budget set to ${amount} for ${monthName} by ${userId}`);
  return ctx.send(`✅ ${matchedCat.name} budget set to $${amount} for ${monthName}.`);
}

/* ── ADD CATEGORY handler ────────────────────────────────────────────────── */

async function handleAddCategory(ctx, nameInput, budgetStr, type) {
  const { userId } = ctx;
  const budget = parseFloat(budgetStr.replace(/,/g, ''));
  if (isNaN(budget) || budget < 0) {
    return ctx.send("Invalid budget. Use: ADD CATEGORY Subscriptions 80 Want");
  }

  const name = nameInput.replace(/[*?:\\/[\]]/g, '').trim();
  if (!name || name.length > 80) {
    return ctx.send("Category name is invalid or too long (max 80 chars).");
  }

  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return ctx.send(`No sheet found for ${monthName}. Create the month first.`);
  }

  try {
    await addCategory(sheetId, { name, budget, type });
  } catch (e) {
    if (e.message.includes('already exists')) {
      return ctx.send(`Category "${name}" already exists.`);
    }
    if (e.message.includes('full')) {
      return ctx.send('Totals sheet is full (max 20 categories). Remove one first.');
    }
    console.error('bot-core: add category failed', e.message);
    return ctx.send('Failed to add category. Try again or use the dashboard.');
  }

  const typeLabel = { need: 'Need', want: 'Want', saving: 'Saving' }[type] || 'Want';
  console.log(`bot-core: category "${name}" added ($${budget} ${typeLabel}) for ${monthName} by ${userId}`);
  return ctx.send(
    `✅ Category "${name}" added for ${monthName}.\nBudget: $${budget} · Type: ${typeLabel}\n\nYou can now log expenses: "${name} 25.50 ${name}"`
  );
}

/* ── GUIDE message ───────────────────────────────────────────────────────── */

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

/* ── DELETE handler (3-layer security) ───────────────────────────────────── */

async function handleDelete(ctx, target) {
  const { store, userId } = ctx;
  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return ctx.send(`No sheet found for ${monthName}.`);
  }

  if (target === 'list') {
    const expenses = await getRecentExpenses(sheetId, 5);
    if (expenses.length === 0) {
      return ctx.send('No recent expenses to delete.');
    }
    const lines = ['Recent expenses:'];
    expenses.forEach((e, i) => {
      lines.push(`#${i + 1} ${e.vendor} · $${Number(e.amount).toFixed(2)} (${e.category})`);
    });
    lines.push('', 'Reply DELETE #N or DELETE last.');
    return ctx.send(lines.join('\n'));
  }

  let expense;
  let targetSheetId = sheetId;

  if (target === 'last') {
    const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
    if (lastlog && lastlog.uuid) {
      expense = { category: lastlog.category, vendor: lastlog.vendor, amount: lastlog.amount, uuid: lastlog.uuid };
      targetSheetId = lastlog.sheetId || sheetId;
    } else {
      const expenses = await getRecentExpenses(sheetId, 1);
      if (expenses.length === 0) {
        return ctx.send('No recent expenses to delete.');
      }
      expense = expenses[0];
    }
  } else {
    const idx = parseInt(target) - 1;
    const expenses = await getRecentExpenses(sheetId, 10);
    if (idx < 0 || idx >= expenses.length) {
      return ctx.send(`No expense at #${parseInt(target)}. Send DELETE to see the list.`);
    }
    expense = expenses[idx];
  }

  if (!expense.uuid) {
    return ctx.send('Cannot delete this entry (no tracking ID). Use the dashboard instead.');
  }

  await store.setJSON(`delete_pending:${userId}`, {
    stage: 1,
    target: { category: expense.category, vendor: expense.vendor, amount: expense.amount, uuid: expense.uuid },
    sheetId: targetSheetId,
    monthName,
    expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  const displayAmt = Number(expense.amount).toFixed(2);
  return ctx.send(
    `⚠️ Delete this expense?\n\n${expense.vendor} · $${displayAmt}\nCategory: ${expense.category}\n\nType CONFIRM DELETE to proceed, or CANCEL.`,
    kbConfirmDelete()
  );
}

async function handleDeletePending(ctx, text, pending) {
  const { store, userId } = ctx;
  const normalized = text.trim().toUpperCase();
  const key = `delete_pending:${userId}`;

  if (pending.stage === 1) {
    if (normalized !== 'CONFIRM DELETE') {
      return ctx.send('Type CONFIRM DELETE to proceed, or CANCEL.');
    }
    pending.stage = 2;
    await store.setJSON(key, pending);
    const fmtAmt = Number(pending.target.amount).toFixed(2);
    return ctx.send(
      `Final verification: type the exact amount ($${fmtAmt}) to delete.`
    );
  }

  if (pending.stage === 2) {
    const input = parseFloat(text.trim().replace(/[\$,]/g, ''));
    const expected = Math.round(pending.target.amount * 100) / 100;
    const actual = Math.round(input * 100) / 100;
    if (isNaN(actual) || actual !== expected) {
      const expectAmt = Number(pending.target.amount).toFixed(2);
      return ctx.send(
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
      console.error('bot-core: DELETE failed', e.message);
      await store.delete(key);
      return ctx.send('Failed to delete. The entry may have been modified. Check the dashboard.');
    }

    const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
    if (lastlog && lastlog.uuid === pending.target.uuid) {
      await store.delete(`lastlog:${userId}`);
    }

    await store.delete(key);
    const delAmt = Number(pending.target.amount).toFixed(2);
    console.log(`bot-core: DELETE — ${pending.target.vendor} $${delAmt} (${pending.target.category}) by ${userId}`);
    return ctx.send(
      `✅ Deleted: ${pending.target.vendor} · $${delAmt} (${pending.target.category})`
    );
  }

  await store.delete(key);
  return ctx.send('Delete expired. Try DELETE again.');
}

/* ── NEW MONTH handler ───────────────────────────────────────────────────── */

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function parseMonthName(input) {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const month = MONTH_NAMES.find(m => m.toLowerCase() === parts[0].toLowerCase());
  const year = parseInt(parts[1]);
  if (!month || isNaN(year) || year < 2020 || year > 2099) return null;
  return `${month} ${year}`;
}

async function handleNewMonth(ctx, monthInput) {
  const { store, userId } = ctx;
  const monthName = parseMonthName(monthInput);
  if (!monthName) {
    return ctx.send('Invalid month format. Use: NEW MONTH June 2026');
  }

  const exists = await checkMonthExists(monthName);
  if (exists) {
    return ctx.send(`${monthName} already exists. Use SET SALARY or SET BUDGET to edit it.`);
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

  await store.setJSON(`new_month_wizard:${userId}`, wizard);

  const salaryLine = prevData?.salary
    ? `Previous salary: $${prevData.salary}`
    : 'No previous salary found';

  return ctx.send(
    `Creating ${monthName}.\n\n${salaryLine}\nEnter salary amount, or SAME to keep it.\n(CANCEL to abort)`
  );
}

async function handleNewMonthWizard(ctx, text, wizard) {
  const { store, userId } = ctx;
  const normalized = text.trim().toUpperCase();
  const key = `new_month_wizard:${userId}`;

  if (wizard.stage === 1) {
    if (normalized === 'SAME') {
      wizard.salary = wizard.prevSalary;
    } else {
      const amount = parseFloat(text.trim().replace(/[\$,]/g, ''));
      if (isNaN(amount) || amount <= 0) {
        return ctx.send('Enter a salary amount (e.g. 5500) or SAME.');
      }
      wizard.salary = amount;
    }

    wizard.stage = 2;
    await store.setJSON(key, wizard);

    if (wizard.prevBudgets.length === 0) {
      wizard.stage = 3;
      await store.setJSON(key, wizard);
      return ctx.send(buildNewMonthSummary(wizard), kbYesCancel());
    }

    const lines = [`Salary: $${wizard.salary}\n`, 'Budgets:'];
    for (const cat of wizard.prevBudgets) {
      lines.push(`  ${cat.name}: $${cat.budget}`);
    }
    lines.push('', 'Send "CategoryName Amount" to change, SAME to keep all, or DONE when finished.');
    return ctx.send(lines.join('\n'));
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
      return ctx.send(buildNewMonthSummary(wizard), kbYesCancel());
    }

    const budgetEdit = text.trim().match(/^(.+?)\s+\$?([\d,]+(?:\.\d{1,2})?)$/);
    if (budgetEdit) {
      const catName = budgetEdit[1].trim();
      const amount = parseFloat(budgetEdit[2].replace(/,/g, ''));
      const matched = wizard.prevBudgets.find(c => c.name.toLowerCase() === catName.toLowerCase());

      if (!matched) {
        const names = wizard.prevBudgets.map(c => c.name).join(', ');
        return ctx.send(`Unknown category "${catName}".\nAvailable: ${names}`);
      }

      if (isNaN(amount) || amount < 0) {
        return ctx.send('Invalid amount. Use: CategoryName Amount (e.g. Grocery 500)');
      }

      wizard.budgetChanges[matched.name] = amount;
      await store.setJSON(key, wizard);

      return ctx.send(`${matched.name} → $${amount}\nMore changes, SAME for remaining, or DONE to finish.`);
    }

    return ctx.send('Send "CategoryName Amount" to change, SAME to keep all, or DONE when finished.');
  }

  if (wizard.stage === 3) {
    if (normalized !== 'YES') {
      return ctx.send('Reply YES to create, or CANCEL to abort.');
    }

    let result;
    try {
      result = await createMonth({
        monthName: wizard.monthName,
        salary: wizard.salary,
        budgetChanges: wizard.budgetChanges,
      });
    } catch (e) {
      console.error('bot-core: createMonth failed', e.message);
      await store.delete(key);
      return ctx.send(`Failed to create ${wizard.monthName}. Try again or use the dashboard.`);
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
      return ctx.send(lines.join('\n'), kbYesSkip());
    }

    await store.delete(key);
    console.log(`bot-core: NEW MONTH ${wizard.monthName} created by ${userId}`);
    return ctx.send(`✅ ${wizard.monthName} created!\nSalary: $${wizard.salary}\nSheet is ready to use.`);
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
            channel: ctx.channel,
          });
          logged++;
        } catch (e) {
          console.warn(`bot-core: recurring "${exp.vendor}" failed:`, e.message);
        }
      }
      await store.delete(key);
      console.log(`bot-core: NEW MONTH ${wizard.monthName} created with ${logged} recurring by ${userId}`);
      return ctx.send(`✅ ${wizard.monthName} ready!\n${logged} recurring expense${logged !== 1 ? 's' : ''} logged.`);
    }

    if (normalized === 'SKIP') {
      await store.delete(key);
      console.log(`bot-core: NEW MONTH ${wizard.monthName} created (recurring skipped) by ${userId}`);
      return ctx.send(`✅ ${wizard.monthName} created!\nRecurring expenses skipped.`);
    }

    return ctx.send('Reply YES to log recurring expenses, or SKIP.');
  }

  await store.delete(key);
  return ctx.send('Wizard expired. Try NEW MONTH again.');
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

/* ── Utilities ───────────────────────────────────────────────────────────── */

function looksLikeTransactionText(text) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 15) return false;
  return /[\$₹€£¥]|\b(usd|inr|eur|gbp|aed|jpy|cad|aud)\b|\d+\.\d{2}/i.test(trimmed);
}

async function findFailedPending(store, blobs, userId) {
  if (!blobs || blobs.length === 0) return null;
  for (const blob of blobs) {
    try {
      const entry = await store.get(blob.key, { type: 'json' });
      if (entry && (entry.userId === userId || entry.phone === userId) && entry.status === 'extraction_failed') {
        return blob;
      }
    } catch { /* skip */ }
  }
  return null;
}

export { CATEGORIES, DAILY_LIMIT, getRateCount };
