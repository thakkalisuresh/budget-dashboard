/**
 * Transport-agnostic bot business logic.
 * Shared by whatsapp-webhook.mjs and telegram-webhook.mjs.
 * Files in lib/ are shared modules, not standalone deployed functions.
 *
 * All handlers receive a ctx object:
 *   { store, userId, chatId, send(message, markup?) }
 */

import crypto from 'node:crypto';
import { extractReceipt, extractReceiptBatch, extractTransactionText, CATEGORIES } from './_extraction.mjs';
import { uploadReceiptImage, moveFile, buildFolderPath } from './_drive.mjs';
import {
  getCurrentMonthSheetId, appendExpense, deleteExpenseByUUID,
  getTotals, getRecentExpenses, writeSalaryAmount, writeBudgetAmount,
  addCategory, checkMonthExists, getLatestMonthData, getUserSettings,
  createMonth,
} from './_sheets.mjs';
import { convertToUSD } from './_currency.mjs';
import { reportError } from './_error-log.mjs';
import { trail, describeActor } from './_error-context.mjs';
import { ownerForCard, DEFAULT_CARD_OWNERS } from './_card-owners.mjs';
import { snapshotConfig } from './_warehouse.mjs';
import { findErrorCodeInText, explainErrorCode } from './_error-codes.mjs';
import { looksLikeQuery, answerQuery } from './_query.mjs';
import { buildRewardsLine, getEffectiveRates } from './_card-rewards.mjs';
import { resolveCardName } from './_card-resolver.mjs';
import { resolveCategory } from './_categorize.mjs';
import { findDuplicates } from './_duplicate-match.mjs';
import {
  kbYesCancel, kbYesSkip, kbConfirmDelete, kbSplitCategory, kbCategoryConfirm, kbLogAnywayCancel,
  kbConfirmReceipt, kbLogAnywayReceipt, kbBatchReceipt, kbEditMenu, kbCategoryPicker, kbCardPicker,
  kbLoggedActions, kbEditLoggedMenu,
} from './_telegram.mjs';
import { categorizeItems, matchesSplitVendor } from './_item-categorizer.mjs';
import { runToolLoop } from './_agent.mjs';

const DAILY_LIMIT    = 50;
const UNDO_WINDOW_MS = 10 * 60 * 1000;
const DASHBOARD_URL  = process.env.SITE_URL || 'https://fundient-dashboard.web.app';

/* ── Card resolution (server-side mirror of src/smartRules + resolveCardName) ──
   resolveCardName now lives in _card-resolver.mjs so wallet-webhook.mjs can
   share it without importing this module. */

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

/* ── Batch queue ───────────────────────────────────────────────────────────────
   A multi-transaction screenshot queues one `confirm:` blob per item. Both YES
   and SKIP consume the current item and move to the next, so the advance lives
   here rather than being written twice — two copies would drift, and the caller
   only differs in the line it prefixes.

   `batch_skipped:` counts drops so the closing message can report what actually
   happened. Without it the queue can only report batchTotal, which would claim
   "All 5 logged" after one was skipped. */

const batchSkipKey = (userId) => `batch_skipped:${userId}`;

/**
 * Right keyboard for whichever kind of pending receipt this is. A batch item has
 * to keep offering SKIP — after an edit or a category pick the prompt is redrawn,
 * and falling back to the single-receipt keyboard would strand the user with only
 * YES and a CANCEL that no longer means what it used to.
 */
const kbForPending = (pending) => (pending?.batchTotal ? kbBatchReceipt() : kbConfirmReceipt());

async function bumpBatchSkipped(store, userId) {
  let count = 0;
  try { count = (await store.get(batchSkipKey(userId), { type: 'json' }))?.count || 0; }
  catch { /* first skip of the batch */ }
  await store.setJSON(batchSkipKey(userId), { count: count + 1 });
  return count + 1;
}

/**
 * Consume the current batch item and prompt for the next, or close out the batch.
 * `prefixLine` describes what just happened to the item being left behind.
 */
async function advanceBatch(ctx, pending, prefixLine) {
  const { store, userId } = ctx;
  const { blobs: remaining } = await store.list({ prefix: `confirm:${userId}:` });

  if (remaining?.length > 0) {
    // store.list ordering isn't guaranteed, and item ids are zero-padded on
    // purpose — sort so "next" is the same item every caller would pick.
    const nextKey = remaining.sort((a, b) => a.key.localeCompare(b.key))[0].key;
    const next    = await store.get(nextKey, { type: 'json' });
    if (next) {
      const lead = `${prefixLine}\n\n`;
      if (next.extraction?.is_transfer) {
        return ctx.send(lead + buildTransferPrompt(next.extraction, next.conversionInfo));
      }
      return ctx.send(
        lead + buildConfirmPrompt(next.extraction, next.conversionInfo, { index: next.batchIndex, total: next.batchTotal }),
        kbBatchReceipt()
      );
    }
  }

  // Queue drained — report what actually happened rather than assuming all were
  // logged, since any number of them may have been skipped.
  const total = pending.batchTotal;
  let skipped = 0;
  try { skipped = (await store.get(batchSkipKey(userId), { type: 'json' }))?.count || 0; }
  catch { /* none skipped */ }
  await store.delete(batchSkipKey(userId)).catch(() => {});

  const logged = Math.max(total - skipped, 0);
  return ctx.send(skipped > 0
    ? `${prefixLine}\n\n✅ ${logged} logged, ⏭ ${skipped} skipped of ${total}.`
    : `${prefixLine}\n\n✅ All ${total} transactions logged!`);
}

/**
 * Drop just the current batch item and move on.
 *
 * Returns the send result when it handled a batch item, or null when there is no
 * batch in progress — so callers can fall through to whatever SKIP/CANCEL means
 * in their own flow. A single pending receipt (no batchTotal) is deliberately
 * left alone: cancelling one of one is the wholesale path, not this one.
 */
async function skipCurrentBatchItem(ctx) {
  const { store, userId } = ctx;

  const { blobs } = await store.list({ prefix: `confirm:${userId}:` });
  if (!blobs || blobs.length === 0) return null;

  const key     = blobs.sort((a, b) => a.key.localeCompare(b.key))[0].key;
  const pending = await store.get(key, { type: 'json' });
  if (!pending?.batchTotal) return null;   // not a batch — leave it to the caller

  await store.delete(key);
  await bumpBatchSkipped(store, userId);

  const e      = pending.extraction || {};
  const vendor = e.store_name || 'that charge';
  const amount = e.total_amount != null ? ` $${e.total_amount}` : '';
  console.log(`bot-core: batch item ${pending.id} skipped by ${userId}`);

  return await advanceBatch(ctx, pending,
    `⏭ ${pending.batchIndex}/${pending.batchTotal} skipped: ${vendor}${amount}`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   PUBLIC: handleTextReply
   ══════════════════════════════════════════════════════════════════════════════ */

export async function handleTextReply(ctx, text) {
  const { store, userId } = ctx;

  // ── R10: inline-keyboard edit callbacks (callback_data arrives here as text) ──
  if (text.startsWith('edit:')) {
    return await handleEditCallback(ctx, text.slice('edit:'.length));
  }

  const normalized = text.trim().toUpperCase();

  // ── R10: capturing a typed value for a button-driven field edit ──
  // CANCEL ALL is excluded alongside CANCEL — both are control words, and
  // swallowing either as a field value would leave the edit state stuck.
  if (normalized !== 'CANCEL' && normalized !== 'CANCEL ALL') {
    const awaitingEdit = await store.get(`awaiting_edit:${userId}`, { type: 'json' }).catch(() => null);
    if (awaitingEdit) {
      return await applyAwaitingEdit(ctx, text, awaitingEdit);
    }
  }

  // Any other text message clears an awaiting ATTACH state
  await store.delete(`awaiting_attach:${userId}`).catch(() => {});

  // ── CANCEL ──
  // A bare CANCEL on a queued batch item used to delete every remaining
  // `confirm:` blob, so cancelling one transaction of five threw away the other
  // four. On a batch it now means "skip this one"; wiping the queue has to be
  // asked for by name.
  if (normalized === 'CANCEL') {
    const skipped = await skipCurrentBatchItem(ctx);
    if (skipped) return skipped;
  }

  if (normalized === 'CANCEL' || normalized === 'CANCEL ALL') {
    let cancelledAny = false;
    for (const key of [
      `salary_pending:${userId}`, `budget_pending:${userId}`,
      `new_month_wizard:${userId}`, `delete_pending:${userId}`,
      `awaiting_edit:${userId}`, `awaiting_attach:${userId}`,
    ]) {
      try {
        const val = await store.get(key, { type: 'json' });
        if (val) { await store.delete(key); cancelledAny = true; }
      } catch { /* no pending */ }
    }
    for (const prefix of [
      `confirm:${userId}:`, `transfer_pending:${userId}:`,
      `split_pending:${userId}:`, `split_confirm:${userId}:`,
      `category_pending:${userId}:`,
    ]) {
      const { blobs } = await store.list({ prefix });
      for (const b of (blobs || [])) {
        await store.delete(b.key);
        cancelledAny = true;
      }
    }
    // Bookkeeping, not a pending action — cleared silently so an abandoned
    // batch's counter can't turn "Nothing to cancel" into "Cancelled."
    await store.delete(batchSkipKey(userId)).catch(() => {});

    console.log(`bot-core: ${normalized} by ${userId} (cleaned ${cancelledAny ? 'pending' : 'nothing'})`);
    return ctx.send(cancelledAny ? 'Cancelled.' : 'Nothing to cancel.');
  }

  // ── Error code lookup ──
  // Placed before the query/agent router so a bare code is answered from the
  // catalogue instead of being sent to an LLM that would guess at it. Codes
  // are distinctive enough (DOMAIN-NNN) to detect anywhere in a message, so
  // pasting one straight from the app — or asking "what does SHT-009 mean" —
  // both work without a command to remember.
  const codeLookup = findErrorCodeInText(text);
  if (codeLookup) {
    return ctx.send(explainErrorCode(codeLookup));
  }

  // ── SPLITCAT callback (user picked a category for one split line item) ──
  if (text.startsWith('SPLITCAT:')) {
    return await handleSplitCategoryPick(ctx, text);
  }

  // ── CATFIX callback (user picked a category for an unconfident wallet charge) ──
  if (text.startsWith('CATFIX:')) {
    return await handleCategoryPick(ctx, text);
  }

  // ── AUDITFIX callback (user accepted a weekly-audit recategorization) ──
  if (text.startsWith('AUDITFIX:')) {
    return await handleAuditFix(ctx, text);
  }

  // ── NEW MONTH wizard / DELETE pending (R5: probe the two independent
  //    state keys in parallel to shave a Firestore round-trip) ──
  const [wizardState, deletePending] = await Promise.all([
    store.get(`new_month_wizard:${userId}`, { type: 'json' }).catch(() => null),
    store.get(`delete_pending:${userId}`, { type: 'json' }).catch(() => null),
  ]);

  if (wizardState) {
    if (new Date(wizardState.expires) > new Date()) {
      return await handleNewMonthWizard(ctx, text, wizardState);
    }
    await store.delete(`new_month_wizard:${userId}`);
  }

  if (deletePending) {
    if (new Date(deletePending.expires) > new Date()) {
      return await handleDeletePending(ctx, text, deletePending);
    }
    await store.delete(`delete_pending:${userId}`);
  }

  // ── SKIP a wallet-triggered split: log the original charge as one expense ──
  if (normalized === 'SKIP') {
    const { blobs } = await store.list({ prefix: `split_pending:${userId}:` });
    if (blobs && blobs.length > 0) {
      return await handleSplitSkip(ctx, blobs[0].key);
    }
    // No split awaiting — try the batch queue before falling through.
    const skipped = await skipCurrentBatchItem(ctx);
    if (skipped) return skipped;
    // Neither — fall through (SKIP may belong to another flow / be noise)
  }

  // ── YES ──
  if (normalized === 'YES') {
    // A completed split takes priority over any pending receipt confirm.
    const { blobs: splitBlobs } = await store.list({ prefix: `split_confirm:${userId}:` });
    if (splitBlobs && splitBlobs.length > 0) {
      const splitState = await store.get(splitBlobs[0].key, { type: 'json' });
      if (splitState) {
        if (splitState.pendingItems && splitState.pendingItems.length > 0) {
          return ctx.send('Pick a category for each remaining item first.');
        }
        return await finalizeSplit(ctx, splitBlobs[0].key, splitState);
      }
    }

    // R5: the salary/budget pending keys are independent — probe both at once.
    const [salaryPending, budgetPending] = await Promise.all([
      store.get(`salary_pending:${userId}`, { type: 'json' }).catch(() => null),
      store.get(`budget_pending:${userId}`, { type: 'json' }).catch(() => null),
    ]);
    if (salaryPending) {
      try {
        await writeSalaryAmount(salaryPending.sheetId, salaryPending.amount);
      } catch (e) {
        await reportError('SHT-006', e, { flow: 'salary' });
        await store.delete(`salary_pending:${userId}`);
        return ctx.send('Failed to update salary. Try again or use the dashboard. [SHT-006]');
      }
      await store.delete(`salary_pending:${userId}`);
      console.log(`bot-core: salary updated to ${salaryPending.amount} by ${userId}`);
      return ctx.send(
        `✅ Salary updated to $${salaryPending.amount} for ${salaryPending.monthName} (was $${salaryPending.currentSalary}).`
      );
    }

    if (budgetPending) {
      try {
        await writeBudgetAmount(budgetPending.sheetId, budgetPending.category, budgetPending.amount);
      } catch (e) {
        await reportError('SHT-001', e, { flow: 'budget' });
        await store.delete(`budget_pending:${userId}`);
        return ctx.send('Failed to update budget. Try again or use the dashboard. [SHT-001]');
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

    // Transfer item stored in the batch confirm queue — re-route to transfer flow.
    if (extraction.is_transfer && pending.batchTotal) {
      await store.delete(key);
      await store.setJSON(`transfer_pending:${userId}:${pending.id}`, {
        ...pending,
        status: undefined,
        batchIndex: undefined,
        batchTotal: undefined,
      });
      return ctx.send(buildTransferPrompt(extraction, pending.conversionInfo));
    }

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
      await reportError('SHT-002', e, { flow: 'receipt-confirm' });
      return ctx.send(`Could not find sheet for ${monthName}. Please log this receipt via the dashboard. [SHT-002]`);
    }

    let result;
    try {
      result = await appendExpense({
        category, vendor, amount, txDate, sheetId, monthName, paymentMethod,
        channel: ctx.channel, bookingMethod,
        // Warehouse-only, frozen at write time. The FX rate in particular has
        // to be stored: rates move daily, so re-deriving one later would give
        // a different — and confidently wrong — original amount.
        provenance: await receiptProvenance(ctx, pending, paymentMethod),
      });
    } catch (e) {
      await reportError('SHT-009', e, { flow: 'receipt-confirm' });
      return ctx.send('Failed to log receipt to spreadsheet. Please try via the dashboard. [SHT-009]');
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

    // Batch: if more transactions are queued, show the next one instead of the full summary.
    if (pending.batchTotal) {
      return await advanceBatch(ctx, pending,
        `✅ ${pending.batchIndex}/${pending.batchTotal} logged: ${vendor} $${amount} → ${category}`);
    }

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
      `Total: $${amount}${extraction.tip ? ` (incl. $${extraction.tip.toFixed(2)} tip)` : ''}`,
      ...(paymentMethod ? [`Card: ${paymentMethod}`] : []),
      ...(rewardsLine ? [rewardsLine] : []),
      ...(pending.conversionInfo ? [`(Converted from ${pending.conversionInfo.originalCurrency} ${pending.conversionInfo.original} · rate ${pending.conversionInfo.rate.toFixed(4)})`] : []),
      ...(pending.driveShareLink ? [`View Receipt: ${pending.driveShareLink}`] : []),
      `View Sheet: ${sheetUrl(sheetId)}`,
      '',
      hints.join(' · '),
    ].join('\n');

    // R10: expose Edit / Undo as buttons alongside the text hints.
    return ctx.send(summary, kbLoggedActions());
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

    // Split entries: delete every per-category row that was logged together.
    if (lastlog.split && Array.isArray(lastlog.entries)) {
      let failed = 0;
      for (const e of lastlog.entries) {
        try {
          await deleteExpenseByUUID({ category: e.category, uuid: e.uuid, sheetId: e.sheetId || lastlog.sheetId });
        } catch (err) {
          failed++;
          await reportError('BOT-002', err, { flow: 'undo-split' });
        }
      }
      await store.delete(`lastlog:${userId}`);
      console.log(`bot-core: UNDO split — ${lastlog.vendor} (${lastlog.entries.length} rows, ${failed} failed) by ${userId}`);
      if (failed > 0) {
        return ctx.send(`Removed ${lastlog.entries.length - failed} of ${lastlog.entries.length} split rows. Check the dashboard for the rest.`);
      }
      return ctx.send(`Undone: ${lastlog.vendor} split ($${lastlog.amount} across ${lastlog.entries.length} categories) removed.`);
    }

    try {
      await deleteExpenseByUUID({ category: lastlog.category, uuid: lastlog.uuid, sheetId: lastlog.sheetId });
    } catch (e) {
      await reportError('BOT-002', e, { flow: 'undo' });
      return ctx.send('Could not undo. The entry may have been modified. Check the dashboard. [BOT-002]');
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

  // ── GUIDE / HELP (R9: broadened phrasings, still deterministic) ──
  if (/^(guide|help|commands?|menu|what can (you|u) do\??|how do (i|you) work\??)$/i.test(text.trim())) {
    return ctx.send(buildGuideMessage());
  }

  // ── Budget query (J1-J4) ──
  if (looksLikeQuery(text)) {
    try {
      const answer = await answerQuery(text);
      return ctx.send(answer);
    } catch (e) {
      await reportError('LLM-002', e, { flow: 'query' });
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
        return ctx.send(lines.join('\n'), kbForPending(pending));
      }
    }
  }

  // ── Field edit (typed): "category: X", "amount: X", "store: X", "date: X", "card: X" ──
  const editMatch = text.trim().match(/^(category|amount|store|date|card|booking|tip)\s*:\s*(.+)$/i);
  if (editMatch) {
    const { blobs } = await store.list({ prefix: `confirm:${userId}:`, limit: 1 });
    if (!blobs || blobs.length === 0) {
      return ctx.send("No pending receipt to edit. Send a receipt image first.");
    }
    const key     = blobs[0].key;
    const pending = await store.get(key, { type: 'json' });
    if (!pending) return ctx.send("No pending receipt to edit.");

    // Shared with the button-driven edit flow (R10).
    const res = await applyExtractionField(pending, editMatch[1].toLowerCase(), editMatch[2].trim());
    if (!res.ok) return ctx.send(res.error);

    await store.setJSON(key, pending);
    return ctx.send(buildUpdatedPrompt(pending), kbForPending(pending));
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
    return ctx.send(lines.join('\n'), kbConfirmReceipt());
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
      return ctx.send(buildConfirmPrompt(data, conversionInfo), kbConfirmReceipt());
    }
    // Fall through to help if extraction didn't yield useful data
  }

  // ── R9: greetings / thanks — canned reply, zero AI ──
  if (looksLikeGreeting(text)) {
    return ctx.send(greetingReply());
  }

  // ── R8: conversational agent fallback ──
  // Everything deterministic has been tried above; only genuinely freeform text
  // reaches the agent. If the agent is unavailable or declines, fall back to the
  // canned help so the bot never hard-depends on AI (R9).
  if (text.trim().length > 0) {
    try {
      if (await runBotAgent(ctx, text)) return;
    } catch (e) {
      console.warn('bot-core: agent fallback failed', e.message);
    }
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

  // R4: single atomic check-and-increment (replaces the old read → read →
  // read+write sequence and its race).
  const rateKey = `rate:${userId}:${new Date().toISOString().slice(0, 10)}`;
  const rate = await store.incrementIfBelow(rateKey, DAILY_LIMIT);
  if (!rate.allowed) {
    return ctx.send("You've reached 50 receipts today. Try again tomorrow. [BOT-006]");
  }

  const baseReceiptId = crypto.randomUUID();
  const now = new Date();

  // Timing breakdown for the receipt path, so the remaining optimizations
  // (retry counts, image downscaling) can be decided from real numbers instead
  // of guesses. Grep the function logs for `bot-core: timing`.
  const t0 = Date.now();
  trail('receipt received');
  const extraction = await extractReceiptBatch(base64, mediaType);
  const tExtract = Date.now() - t0;
  trail(`extracted ${extraction?.transactions?.length ?? 0} tx`);

  if (!extraction.ok || extraction.transactions.length === 0) {
    await store.setJSON(`pending:${baseReceiptId}`, {
      id: baseReceiptId, userId, mediaType, base64,
      receivedAt: now.toISOString(),
      status: 'extraction_failed',
    });
    return ctx.send("Couldn't parse receipt clearly. Reply with: Store name, amount, category\n(e.g., 'Walmart 45.23 Grocery')");
  }

  const { transactions } = extraction;

  // Single transaction — identical to original flow, no batch metadata stored.
  if (transactions.length === 1) {
    const data = transactions[0];
    const year  = data.purchase_date ? new Date(data.purchase_date).getFullYear() : now.getFullYear();
    const month = data.purchase_date
      ? new Date(data.purchase_date).toLocaleString('en-US', { month: 'long' })
      : now.toLocaleString('en-US', { month: 'long' });

    // Drive is the one consistently expensive call left on this path —
    // maybeConvertCurrency short-circuits for USD and getUserSettings is cached
    // (R3). Start the upload now and let it run underneath the card resolution
    // and prompt building instead of blocking the user on it. Awaited later,
    // never abandoned. Rejection is folded into the promise so an upload
    // failure can't surface as an unhandled rejection while it's unowned.
    const drivePromise = uploadReceiptImage({
      year, month, category: null,
      fileName: `receipt-${baseReceiptId.slice(0, 8)}.${mediaType === 'application/pdf' ? 'pdf' : 'jpg'}`,
      mimeType: mediaType, base64,
    }).catch(async e => {
      await reportError('DRV-002', e, { userId, step: 'receipt' });
      return null;
    });

    // Started here so the two sheet reads it needs overlap the Drive upload,
    // the settings fetch and the Groq categorization rather than stacking on
    // top of them — this path's perceived latency was deliberately tuned.
    const dupPromise = findExistingDuplicates(`${month} ${year}`, data);

    const conversionInfo = await maybeConvertCurrency(data);

    let settings = {};
    try {
      settings = await getUserSettings();
      data.payment_method = resolveCard(data.payment_method, data.store_name, data.reward_category, settings);
    } catch (e) {
      console.warn('bot-core: card resolution failed (non-fatal)', e.message);
    }

    // Correct the extractor's category before the user sees it. This path
    // already ends in a YES/CANCEL confirm, so an unconfident answer needs no
    // extra round-trip — it just changes what the prompt proposes.
    data.reward_category = (await resolveCategory({
      vendor: data.store_name,
      amount: data.total_amount,
      extractedCategory: data.reward_category,
      categories: [...CATEGORIES, ...(settings.customCategories || [])],
      settings,
      enabled: settings.llmCategorize !== false,
    })).category;

    // ── Split flow: itemized receipt from a configured split vendor (Costco,
    // Amazon…) OR a wallet-triggered split awaiting its receipt. Splits the
    // receipt across categories instead of logging one lump sum.
    const { blobs: splitPendingBlobs } = await store.list({ prefix: `split_pending:${userId}:` });
    const hasSplitPending = (splitPendingBlobs || []).length > 0;
    const isSplitVendor = matchesSplitVendor(data.store_name, settings.splitReceiptVendors || []);
    if (!data.is_transfer && Array.isArray(data.items) && data.items.length > 0 && (isSplitVendor || hasSplitPending)) {
      const pendingKey = hasSplitPending ? splitPendingBlobs[0].key : null;
      // The split flow threads driveResult through its own per-category blobs,
      // so it needs the real value rather than a deferred patch.
      const driveResult = await drivePromise;
      return await handleSplitFlow(ctx, {
        data, year, month, conversionInfo, baseReceiptId, driveResult, pendingKey,
      });
    }

    // Both remaining paths store the blob with null Drive ids, send the prompt,
    // then patch the ids in. The user sees the prompt a full Drive round-trip
    // sooner; the ids land before the handler returns.
    if (data.is_transfer) {
      const transferKey = `transfer_pending:${userId}:${baseReceiptId}`;
      await store.setJSON(transferKey, {
        id: baseReceiptId, phone: userId, mediaType, base64,
        extraction: data, conversionInfo,
        driveFileId: null, driveFolderId: null, driveShareLink: null,
        year, month, receivedAt: now.toISOString(),
      });
      const sent = await ctx.send(buildTransferPrompt(data, conversionInfo));
      await attachDriveResult(store, transferKey, drivePromise);
      return sent;
    }

    const confirmKey = `confirm:${userId}:${baseReceiptId}`;
    await store.setJSON(confirmKey, {
      id: baseReceiptId, phone: userId, mediaType, base64,
      extraction: data, conversionInfo,
      driveFileId: null, driveFolderId: null, driveShareLink: null,
      year, month, receivedAt: now.toISOString(),
      status: 'awaiting_confirmation',
    });

    console.log(`bot-core: receipt ${baseReceiptId} extracted for ${userId} — ${data.store_name} $${data.total_amount}`);

    // On a hit the prompt leads with the warning and the affirmative button
    // changes from "YES" to "Log anyway", so confirming a duplicate is a
    // deliberate act rather than the same reflex tap. Same callback_data, so
    // the confirm handler is untouched.
    const dups = await dupPromise;
    if (dups.length > 0) {
      console.log(`bot-core: ${dups.length} possible duplicate(s) for ${data.store_name} $${data.total_amount}`);
    }
    const promptText = dups.length > 0
      ? `${buildDuplicateWarning(dups)}\n\n${buildConfirmPrompt(data, conversionInfo)}`
      : buildConfirmPrompt(data, conversionInfo);
    // Receipt-specific keyboards: same YES/CANCEL callback_data as the generic
    // kbYesCancel pair, plus the Edit button. Edit was previously only offered on
    // batch items, so a single receipt could only be logged or thrown away —
    // even though the edit handlers already supported it.
    const sent = await ctx.send(promptText, dups.length > 0 ? kbLogAnywayReceipt() : kbConfirmReceipt());
    // Perceived latency ends at the send; Drive now lands after it.
    console.log(`bot-core: timing ${baseReceiptId} extract=${tExtract}ms toPrompt=${Date.now() - t0}ms`);
    await attachDriveResult(store, confirmKey, drivePromise);
    console.log(`bot-core: timing ${baseReceiptId} total=${Date.now() - t0}ms (drive after prompt)`);
    return sent;
  }

  // Multiple transactions — upload image once, queue all items as confirm blobs.
  const batchTotal = transactions.length;

  // Clear any skip count left behind by a batch that was never finished, so its
  // tally can't be attributed to this one.
  await store.delete(batchSkipKey(userId)).catch(() => {});

  // The batch loop threads driveResult into every per-item blob, so deferring
  // the upload here would mean patching N blobs afterwards — more Firestore
  // writes than the one round-trip it would save. Overlap it with the settings
  // fetch instead and await both together.
  const first = transactions[0];
  const firstYear  = first.purchase_date ? new Date(first.purchase_date).getFullYear() : now.getFullYear();
  const firstMonth = first.purchase_date
    ? new Date(first.purchase_date).toLocaleString('en-US', { month: 'long' })
    : now.toLocaleString('en-US', { month: 'long' });

  const [driveResult, settings] = await Promise.all([
    uploadReceiptImage({
      year: firstYear, month: firstMonth, category: null,
      fileName: `receipt-${baseReceiptId.slice(0, 8)}.${mediaType === 'application/pdf' ? 'pdf' : 'jpg'}`,
      mimeType: mediaType, base64,
    }).catch(async e => {
      await reportError('DRV-002', e, { userId, step: 'batch' });
      return null;
    }),
    getUserSettings().catch(() => ({})),
  ]);

  for (let i = 0; i < transactions.length; i++) {
    const data = transactions[i];
    const itemId = `${baseReceiptId}_${String(i).padStart(3, '0')}`;
    const year  = data.purchase_date ? new Date(data.purchase_date).getFullYear() : now.getFullYear();
    const month = data.purchase_date
      ? new Date(data.purchase_date).toLocaleString('en-US', { month: 'long' })
      : now.toLocaleString('en-US', { month: 'long' });

    data.payment_method = resolveCard(data.payment_method, data.store_name, data.reward_category, settings);

    const conversionInfo = await maybeConvertCurrency(data);

    // All items (including transfers) stored in the confirm queue so the batch
    // can be chained. handleConfirm re-routes transfers to transfer_pending when
    // it encounters one.
    await store.setJSON(`confirm:${userId}:${itemId}`, {
      id: itemId, phone: userId, mediaType, base64,
      extraction: data, conversionInfo,
      driveFileId: i === 0 ? (driveResult?.fileId || null) : null,
      driveFolderId: i === 0 ? (driveResult?.folderId || null) : null,
      driveShareLink: i === 0 ? (driveResult?.shareLink || null) : null,
      year, month, receivedAt: now.toISOString(),
      status: 'awaiting_confirmation',
      batchIndex: i + 1,
      batchTotal,
    });
  }

  console.log(`bot-core: batch ${baseReceiptId} extracted for ${userId} — ${batchTotal} transactions`);

  // R2: reuse the conversionInfo already computed + stored for item 0 instead of
  // re-running maybeConvertCurrency (which double-converted foreign currencies
  // and fired a redundant FX call).
  // `first` is already in scope — hoisted above for the Drive folder path.
  const firstItemId = `${baseReceiptId}_000`;
  const firstBlob = await store.get(`confirm:${userId}:${firstItemId}`, { type: 'json' });
  const firstConvInfo = firstBlob?.conversionInfo || null;
  if (first.is_transfer) {
    return ctx.send(buildTransferPrompt(first, firstConvInfo));
  }
  return ctx.send(
    buildConfirmPrompt(first, firstConvInfo, { index: 1, total: batchTotal }),
    kbBatchReceipt()
  );
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
    await reportError('DRV-002', e, { userId, step: 'attach' });
    return ctx.send('Failed to upload receipt to Drive. Try again. [DRV-002]');
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

/* ══════════════════════════════════════════════════════════════════════════════
   Receipt category split (Costco / Amazon …)
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Start (or resume into) a split: classify line items, auto-group the confident
 * ones, and ask the user category-by-category for the rest. State lives in
 * `split_confirm:<userId>:<id>`.
 */
async function handleSplitFlow(ctx, { data, year, month, conversionInfo, baseReceiptId, driveResult, pendingKey }) {
  const { store, userId } = ctx;

  const { autoGrouped, uncategorized } = categorizeItems(data.items || []);

  const groups = {};
  for (const g of autoGrouped) groups[g.category] = g.subtotal;

  const state = {
    id: baseReceiptId,
    phone: userId,
    vendor: data.store_name || 'Unknown',
    totalAmount: data.total_amount,
    txDate: data.purchase_date || null,
    year, month,
    paymentMethod: data.payment_method || '',
    conversionInfo: conversionInfo || null,
    driveFileId: driveResult?.fileId || null,
    driveFolderId: driveResult?.folderId || null,
    driveShareLink: driveResult?.shareLink || null,
    groups,
    items: uncategorized.map(u => ({ name: u.name, amount: u.amount, suggestion: u.suggestion, category: null })),
    currentIndex: 0,
    receivedAt: new Date().toISOString(),
  };

  // Wallet-triggered splits leave a split_pending marker — consume it now.
  if (pendingKey) await store.delete(pendingKey).catch(() => {});

  const key = `split_confirm:${userId}:${baseReceiptId}`;
  await store.setJSON(key, state);
  console.log(`bot-core: split started for ${userId} — ${state.vendor} $${state.totalAmount} (${autoGrouped.length} auto, ${uncategorized.length} to ask)`);

  return await askNextSplitItem(ctx, key, state);
}

/** Ask about the next uncategorized item, or show the summary if all are done. */
async function askNextSplitItem(ctx, key, state) {
  const { store } = ctx;

  if (state.currentIndex >= state.items.length) {
    await store.setJSON(key, state);
    return ctx.send(buildSplitSummary(state), kbYesCancel());
  }

  const item = state.items[state.currentIndex];
  const autoLines = Object.entries(state.groups).map(([c, amt]) => `  ${c}: $${amt.toFixed(2)}`);
  const lines = [
    `🧾 Splitting ${state.vendor} — $${Number(state.totalAmount).toFixed(2)}`,
    ...(autoLines.length ? ['', 'Auto-sorted so far:', ...autoLines] : []),
    '',
    `Item ${state.currentIndex + 1} of ${state.items.length}: ${item.name} — $${Number(item.amount).toFixed(2)}`,
    'Which category?',
  ];
  await store.setJSON(key, state);
  return ctx.send(lines.join('\n'), kbSplitCategory(state.currentIndex, CATEGORIES, item.suggestion));
}

/**
 * Handle a `CATFIX:<pendingId>:<category>` pick.
 *
 * The wallet webhook parked this charge instead of writing it, because the
 * categorizer wasn't confident. The tap supplies the category and the expense
 * is written now — this is the only place that charge ever gets logged, so a
 * failure here has to say so plainly rather than fail silently.
 */
async function handleCategoryPick(ctx, text) {
  const { store, userId } = ctx;
  const m = text.match(/^CATFIX:([^:]+):(.+)$/);
  if (!m) return; // malformed — ignore

  const [, pendingId, category] = m;
  const key = `category_pending:${userId}:${pendingId}`;
  const pending = await store.get(key, { type: 'json' }).catch(() => null);
  if (!pending) {
    return ctx.send('That charge is no longer waiting — it may have been logged or cancelled already.');
  }

  try {
    const { uuid } = await appendExpense({
      category,
      vendor: pending.vendor,
      amount: pending.amount,
      txDate: pending.txDate,
      sheetId: pending.sheetId,
      monthName: pending.monthName,
      paymentMethod: pending.paymentMethod || '',
      channel: 'wallet',
    });
    await store.delete(key);
    await store.setJSON(`lastlog:${userId}`, {
      uuid, category, vendor: pending.vendor, amount: pending.amount,
      sheetId: pending.sheetId, monthName: pending.monthName,
      loggedAt: new Date().toISOString(),
    });
    console.log(`bot-core: CATFIX logged ${pending.vendor} $${pending.amount} as ${category} for ${userId}`);
    return ctx.send(`Logged ${pending.vendor} · $${Number(pending.amount).toFixed(2)} as ${category}.`);
  } catch (e) {
    await reportError('BOT-007', e, { userId, vendor: pending?.vendor });
    // Leave the pending blob in place so the charge isn't lost — the user can
    // tap again once whatever broke is back.
    return ctx.send(`Couldn't log that: ${e.message}. Tap a category again to retry. [BOT-007]`);
  }
}

/**
 * Handle an `AUDITFIX:<uuid>:<category>` tap from the weekly digest — move an
 * already-logged expense to a different category.
 *
 * Categories are separate sheet tabs, so a move is an append plus a delete.
 * Append FIRST, on purpose: if the delete then fails the user has a visible
 * duplicate they can remove, whereas deleting first and failing to append
 * would silently destroy the expense. Neither half is atomic and a duplicate
 * is the cheaper failure.
 */
async function handleAuditFix(ctx, text) {
  const { store, userId } = ctx;
  const m = text.match(/^AUDITFIX:([^:]+):(.+)$/);
  if (!m) return;

  const [, uuid, newCategory] = m;
  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch {
    return ctx.send(`No sheet found for ${monthName}.`);
  }

  const recent = await getRecentExpenses(sheetId, 100).catch(() => []);
  const expense = recent.find(e => e.uuid === uuid);
  if (!expense) {
    return ctx.send('Could not find that expense — it may have been edited or deleted already. [SHT-004]');
  }
  if (expense.category === newCategory) {
    return ctx.send(`${expense.vendor} is already in ${newCategory}.`);
  }

  try {
    await appendExpense({
      category: newCategory,
      vendor: expense.vendor,
      amount: expense.amount,
      txDate: expense.txDate || undefined,
      sheetId,
      monthName,
      channel: 'audit',
    });
  } catch (e) {
    await reportError('SHT-009', e, { flow: 'auditfix', uuid });
    return ctx.send(`Couldn't move that: ${e.message}. Nothing was changed. [SHT-009]`);
  }

  try {
    await deleteExpenseByUUID({ category: expense.category, uuid, sheetId });
  } catch (e) {
    // The new row exists; the old one didn't go. Say so rather than claim success.
    await reportError('BOT-008', e, { flow: 'auditfix', uuid });
    return ctx.send(
      `Added ${expense.vendor} to ${newCategory}, but couldn't remove the old ${expense.category} entry — ` +
      `please delete it in the dashboard so it isn't counted twice.`
    );
  }

  console.log(`bot-core: AUDITFIX moved ${expense.vendor} ${expense.category} → ${newCategory} for ${userId}`);
  return ctx.send(`Moved ${expense.vendor} · $${Number(expense.amount).toFixed(2)} from ${expense.category} to ${newCategory}.`);
}

/** Handle a `SPLITCAT:<idx>:<category>` pick from the inline keyboard. */
async function handleSplitCategoryPick(ctx, text) {
  const { store, userId } = ctx;
  const m = text.match(/^SPLITCAT:(\d+):(.+)$/);
  if (!m) return; // malformed — ignore

  const idx = parseInt(m[1], 10);
  const category = m[2];

  const { blobs } = await store.list({ prefix: `split_confirm:${userId}:` });
  if (!blobs || blobs.length === 0) {
    return ctx.send('No active split. Send a receipt to start one.');
  }
  const key = blobs[0].key;
  const state = await store.get(key, { type: 'json' });
  if (!state) return ctx.send('No active split.');

  if (!CATEGORIES.includes(category)) {
    return ctx.send(`Unknown category. Choose from:\n${CATEGORIES.join(', ')}`);
  }

  // Ignore stale taps (an old item's buttons) — only the current item is live.
  if (idx !== state.currentIndex) {
    return ctx.send('That item was already sorted. Use the latest buttons above.');
  }

  const item = state.items[idx];
  item.category = category;
  state.groups[category] = Math.round(((state.groups[category] || 0) + item.amount) * 100) / 100;
  state.currentIndex += 1;

  return await askNextSplitItem(ctx, key, state);
}

/** Log every category group as its own expense row, linked for UNDO. */
async function finalizeSplit(ctx, key, state) {
  const { store, userId } = ctx;
  const monthName = `${state.month} ${state.year}`;

  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch (e) {
    await reportError('SHT-002', e, { flow: 'split' });
    return ctx.send(`Could not find sheet for ${monthName}. Log this via the dashboard. [SHT-002]`);
  }

  // Reconcile the item sum against the actual charged total (tax / fees /
  // discounts): drop any remainder into the largest group so the split adds up.
  const groups = { ...state.groups };
  const cats = Object.keys(groups);
  if (cats.length === 0) {
    return ctx.send('Nothing to log — no categories were assigned. CANCEL to discard.');
  }
  const groupSum = Math.round(cats.reduce((s, c) => s + groups[c], 0) * 100) / 100;
  const remainder = Math.round((Number(state.totalAmount) - groupSum) * 100) / 100;
  if (Math.abs(remainder) >= 0.01) {
    const largest = cats.reduce((a, b) => (groups[b] > groups[a] ? b : a), cats[0]);
    groups[largest] = Math.round((groups[largest] + remainder) * 100) / 100;
  }

  const entries = [];
  for (const category of Object.keys(groups)) {
    const amount = groups[category];
    if (amount <= 0) continue;
    try {
      const result = await appendExpense({
        category, vendor: state.vendor, amount,
        txDate: state.txDate, sheetId, monthName,
        paymentMethod: state.paymentMethod || '', channel: ctx.channel,
      });
      entries.push({ category, uuid: result.uuid, sheetId, amount });
    } catch (e) {
      await reportError('BOT-005', e, { category });
    }
  }

  if (entries.length === 0) {
    return ctx.send('Failed to log the split to the spreadsheet. Try again or use the dashboard. [BOT-005]');
  }

  // Move the receipt into the largest group's Drive folder (best-effort).
  if (state.driveFileId) {
    try {
      const top = entries.reduce((a, b) => (b.amount > a.amount ? b : a), entries[0]);
      const { folderId } = await buildFolderPath(state.year, state.month, top.category);
      await moveFile(state.driveFileId, folderId);
    } catch (e) {
      console.warn('bot-core: split Drive move failed (non-fatal)', e.message);
    }
  }

  await store.setJSON(`lastlog:${userId}`, {
    split: true,
    entries,
    vendor: state.vendor,
    amount: Math.round(Object.values(groups).reduce((s, a) => s + a, 0) * 100) / 100,
    sheetId, monthName, year: state.year, month: state.month,
    driveFileId: state.driveFileId || null,
    driveShareLink: state.driveShareLink || null,
    loggedAt: new Date().toISOString(),
  });

  await store.delete(key);
  console.log(`bot-core: split logged for ${userId} — ${state.vendor}, ${entries.length} categories`);

  const lines = [
    `✅ Logged ${state.vendor} split across ${entries.length} categor${entries.length === 1 ? 'y' : 'ies'}:`,
    ...entries.map(e => `  ${e.category}: $${e.amount.toFixed(2)}`),
    '',
    `View Sheet: ${sheetUrl(sheetId)}`,
    '',
    'UNDO to reverse the whole split',
  ];
  return ctx.send(lines.join('\n'));
}

/** SKIP a wallet-triggered split — log the original charge as one expense. */
async function handleSplitSkip(ctx, key) {
  const { store, userId } = ctx;
  const pending = await store.get(key, { type: 'json' });
  if (!pending) return ctx.send('Nothing to skip.');

  const monthName = `${pending.month} ${pending.year}`;
  let sheetId;
  try {
    sheetId = await getCurrentMonthSheetId(monthName);
  } catch (e) {
    await store.delete(key);
    await reportError('SHT-002', e, { flow: 'split-skip' });
    return ctx.send(`Could not find sheet for ${monthName}. Log this via the dashboard. [SHT-002]`);
  }

  const category = pending.category || 'Misc';
  let result;
  try {
    result = await appendExpense({
      category, vendor: pending.vendor, amount: pending.amount,
      txDate: pending.txDate, sheetId, monthName,
      paymentMethod: pending.paymentMethod || '', channel: ctx.channel,
    });
  } catch (e) {
    await reportError('SHT-009', e, { flow: 'split-skip' });
    return ctx.send('Failed to log. Try again or use the dashboard. [SHT-009]');
  }

  await store.setJSON(`lastlog:${userId}`, {
    uuid: result.uuid, category, vendor: pending.vendor, amount: pending.amount,
    txDate: pending.txDate, paymentMethod: pending.paymentMethod || '',
    sheetId, monthName, year: pending.year, month: pending.month,
    driveFileId: null, loggedAt: new Date().toISOString(),
  });
  await store.delete(key);
  console.log(`bot-core: split skipped — logged single ${pending.vendor} $${pending.amount} → ${category}`);

  return ctx.send(`✅ Logged ${pending.vendor} $${Number(pending.amount).toFixed(2)} as ${category} (not split).\n\nUNDO to reverse.`);
}

function buildSplitSummary(state) {
  const groups = state.groups || {};
  const lines = [`🧾 ${state.vendor} — split summary:`, ''];
  for (const [c, amt] of Object.entries(groups)) {
    lines.push(`  ${c}: $${Number(amt).toFixed(2)}`);
  }
  const sum = Math.round(Object.values(groups).reduce((s, a) => s + a, 0) * 100) / 100;
  lines.push('', `Items total: $${sum.toFixed(2)} · Charged: $${Number(state.totalAmount).toFixed(2)}`);
  if (Math.abs(Number(state.totalAmount) - sum) >= 0.01) {
    lines.push('(tax/fees will be added to the largest category)');
  }
  lines.push('', 'Reply YES to log all, or CANCEL.');
  return lines.join('\n');
}

/* ── Helpers: currency + prompts ─────────────────────────────────────────── */

/**
 * Await an in-flight Drive upload and patch its ids onto an already-stored
 * blob.
 *
 * Called AFTER the confirm prompt has been sent, so the user never waits on
 * Drive I/O they don't need yet — but still awaited before the handler
 * returns, because Cloud Functions does not guarantee execution once the
 * response is flushed.
 *
 * If the blob is gone the user confirmed or cancelled inside the upload
 * window; there is nothing left to attach, and the expense simply carries no
 * Drive link. That race is narrow (the upload starts well before the prompt is
 * sent, and a reply needs a human plus a round-trip) and costs a receipt image,
 * not an expense.
 */
/**
 * Look for an already-logged transaction matching this receipt.
 *
 * Reads History once rather than scanning category tabs: History carries
 * vendor/amount/date/category for every tab in a single request, so a wallet
 * charge filed under Misc is found even though this receipt is headed for
 * Grocery. Cross-tab is the entire point — the duplicate this exists to catch
 * is "the wallet logged it instantly, then I photographed the receipt".
 *
 * Never throws. A failing duplicate check must not stop someone logging an
 * expense; the worst case is the duplicate the review half then picks up.
 */
async function findExistingDuplicates(monthName, data) {
  try {
    const sheetId = await getCurrentMonthSheetId(monthName);
    const recent  = await getRecentExpenses(sheetId, 100);
    return findDuplicates(
      recent.map(e => ({
        vendor: e.vendor,
        amount: e.amount,
        // txDate is the real purchase date; timestamp is when it was logged,
        // which is the best available stand-in for older rows without one.
        date: e.txDate || e.timestamp,
        category: e.category,
      })),
      { vendor: data.store_name, amount: data.total_amount, date: data.purchase_date }
    );
  } catch (e) {
    console.warn('bot-core: duplicate check failed (non-fatal)', e.message);
    return [];
  }
}

/** One line per already-logged match, shown above the confirm prompt. */
function buildDuplicateWarning(dups) {
  const lines = [`⚠️ Possible duplicate — already logged:`];
  for (const d of dups.slice(0, 3)) {
    const when = d.date ? ` on ${String(d.date).slice(0, 10)}` : '';
    lines.push(`• ${d.vendor} · $${Number(d.amount).toFixed(2)}${when} (${d.category || 'Misc'})`);
  }
  if (dups.length > 3) lines.push(`• …and ${dups.length - 3} more`);
  return lines.join('\n');
}

async function attachDriveResult(store, key, drivePromise) {
  const driveResult = await drivePromise;
  if (!driveResult) return;
  const blob = await store.get(key, { type: 'json' }).catch(() => null);
  if (!blob) return;
  blob.driveFileId    = driveResult.fileId    || null;
  blob.driveFolderId  = driveResult.folderId  || null;
  blob.driveShareLink = driveResult.shareLink || null;
  await store.setJSON(key, blob);
}

/**
 * Derived, frozen-at-write-time fields for a confirmed receipt.
 *
 * Everything here comes from something mutable — the FX rate of the day, the
 * card→owner map in Settings — so it is recorded rather than recomputed. A
 * settings change must never silently rewrite history.
 *
 * Never throws: this decorates a write that has already been approved by the
 * user, and losing a receipt over a settings read would be absurd.
 */
async function receiptProvenance(ctx, pending, paymentMethod) {
  try {
    let settings = {};
    try { settings = await getUserSettings(); } catch { /* NULLs are honest */ }
    const map = settings.cardOwners || DEFAULT_CARD_OWNERS;
    const info = pending?.conversionInfo || null;
    return {
      actorEmail: describeActor(ctx.userId),
      categorySource: 'extractor',
      cardOwner: ownerForCard(paymentMethod, map),
      cardOwnerMapHash: await snapshotConfig('card_owners', map, { ingestSource: 'hook' }),
      fxRate: info?.rate ?? null,
      fxOriginalAmount: info?.original != null ? Math.round(Number(info.original) * 100) : null,
      fxOriginalCurrency: info?.originalCurrency || null,
    };
  } catch {
    return null;
  }
}

async function maybeConvertCurrency(data) {
  if (!data.currency || data.currency === 'USD') return null;
  if (typeof data.total_amount !== 'number' || data.total_amount <= 0) return null;
  try {
    const info = await convertToUSD(data.total_amount, data.currency);
    data.total_amount = info.amount;
    // R2: mark as converted so a second call on the same object is a no-op
    // (the original currency is preserved in the returned conversionInfo).
    data.currency = 'USD';
    return info;
  } catch (e) {
    console.warn('bot-core: currency conversion failed', e.message);
    return null;
  }
}

function buildConfirmPrompt(data, conversionInfo, batchInfo) {
  const header = batchInfo ? `Transaction ${batchInfo.index}/${batchInfo.total}:\n` : '';
  const lines = [
    `${header}Transaction found:`,
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
  const DINING_CATS = new Set(['Eating Out', 'Thakkali']);
  const tipHint = DINING_CATS.has(data.reward_category) ? ', or "tip: 5.00" to add tip' : '';
  lines.push('', 'Reply YES to log, or CANCEL', `Edit: "category: Travel", "amount: 52.10", "card: Chase", "booking: direct"${tipHint}`);
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
    await reportError('SHT-006', e, { flow: 'salary' });
    return ctx.send('Failed to set salary. Try again or use the dashboard. [SHT-006]');
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
    await reportError('SHT-001', e, { flow: 'budget' });
    return ctx.send('Failed to set budget. Try again or use the dashboard. [SHT-001]');
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
    await reportError('SHT-007', e, { flow: 'add-category' });
    return ctx.send('Failed to add category. Try again or use the dashboard. [SHT-007]');
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
    'MULTIPLE TRANSACTIONS (one screenshot)',
    '• Each is confirmed in turn: 1/5, 2/5…',
    '• SKIP drops just that one, the rest carry on',
    '• CANCEL on a queued item also means skip',
    '• CANCEL ALL abandons the whole queue',
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

/**
 * Short date for the DELETE list. Two rows with the same vendor AND amount are
 * otherwise indistinguishable in the numbered list, so the date is what makes
 * `DELETE #2` a deliberate choice instead of a guess. Prefers the real
 * transaction date; falls back to the History log timestamp for legacy 8-col
 * bot rows that predate the TxDate column. Returns '' when neither parses, so
 * callers can omit the segment rather than print "Invalid Date".
 */
export function shortDate(expense) {
  const raw = expense?.txDate || expense?.timestamp || '';
  if (!raw) return '';
  const ms = Date.parse(typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())
    ? `${raw.trim()}T00:00:00Z`
    : raw);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

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
      const when = shortDate(e);
      lines.push(`#${i + 1} ${e.vendor} · $${Number(e.amount).toFixed(2)}${when ? ` · ${when}` : ''} (${e.category})`);
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
    return ctx.send('Cannot delete this entry (no tracking ID). Use the dashboard instead. [BOT-004]');
  }

  await store.setJSON(`delete_pending:${userId}`, {
    stage: 1,
    target: { category: expense.category, vendor: expense.vendor, amount: expense.amount, uuid: expense.uuid },
    sheetId: targetSheetId,
    monthName,
    expires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  const displayAmt = Number(expense.amount).toFixed(2);
  // Repeat the date here too: this is the last screen before a destructive,
  // irreversible write, and it's where picking the wrong duplicate gets caught.
  const when = shortDate(expense);
  return ctx.send(
    `⚠️ Delete this expense?\n\n${expense.vendor} · $${displayAmt}${when ? `\nDate: ${when}` : ''}\nCategory: ${expense.category}\n\nType CONFIRM DELETE to proceed, or CANCEL.`,
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
      await reportError('BOT-003', e, { userId });
      await store.delete(key);
      return ctx.send('Failed to delete. The entry may have been modified. Check the dashboard. [BOT-003]');
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
      await reportError('SHT-002', e, { flow: 'create-month' });
      await store.delete(key);
      return ctx.send(`Failed to create ${wizard.monthName}. Try again or use the dashboard. [SHT-002]`);
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

/* ── R9: greetings / small talk (deterministic, no AI) ────────────────────── */

function looksLikeGreeting(text) {
  const t = (text || '').trim().toLowerCase().replace(/[!.,?]+$/, '');
  return /^(hi+|hey+|hello+|holla|yo|sup|howdy|hiya|good\s+(morning|afternoon|evening|night)|thanks?|thank\s*you|thankyou|thx|ty|cheers|gm|gn)$/i.test(t);
}

function greetingReply() {
  return [
    "Hey! 👋 I'm your budget bot.",
    '',
    'Send a receipt photo, or type an expense like "Walmart 45.23 Grocery".',
    'Ask me things like "how much on groceries?" or "am I over budget?"',
    'Type GUIDE for the full command list.',
  ].join('\n');
}

/* ── R10: shared field-edit logic + button-driven edit flows ──────────────── */

/** Apply a single field edit to a pending receipt's extraction. Returns
 *  { ok } or { ok: false, error }. Shared by typed edits ("amount: X") and the
 *  button flow. Async because `card` needs user settings. */
async function applyExtractionField(pending, field, value) {
  const ex = pending.extraction;
  if (field === 'category') {
    const matched = CATEGORIES.find(c => c.toLowerCase() === value.toLowerCase());
    if (!matched) return { ok: false, error: `Unknown category. Choose from:\n${CATEGORIES.join(', ')}` };
    ex.reward_category = matched;
  } else if (field === 'amount') {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return { ok: false, error: "Invalid amount. Use a positive number (e.g., 'amount: 52.10')" };
    ex.total_amount = num;
  } else if (field === 'store') {
    ex.store_name = value;
  } else if (field === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { ok: false, error: "Date must be YYYY-MM-DD (e.g., 'date: 2026-05-20')" };
    ex.purchase_date = value;
    pending.year = new Date(value).getFullYear();
    pending.month = new Date(value).toLocaleString('en-US', { month: 'long' });
  } else if (field === 'card') {
    let settings = {};
    try { settings = await getUserSettings(); } catch { /* none */ }
    const cards = settings.cards || [];
    const matched = resolveCardName(value, cards) || cards.find(c => c.toLowerCase() === value.toLowerCase());
    if (!matched) return { ok: false, error: cards.length ? `Unknown card. Choose from:\n${cards.join(', ')}` : 'No cards configured. Add cards in the dashboard settings first.' };
    ex.payment_method = matched;
  } else if (field === 'booking') {
    const method = value.toLowerCase();
    if (method !== 'portal' && method !== 'direct') return { ok: false, error: "Booking must be 'portal' (8x UR) or 'direct' (4x UR)." };
    ex.booking_method = method === 'direct' ? 'direct' : '';
  } else if (field === 'tip') {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) return { ok: false, error: "Invalid tip. Use a positive number (e.g., 'tip: 5.00')" };
    const prevTip = ex.tip || 0;
    ex.tip = num;
    ex.total_amount = Math.round(((ex.total_amount || 0) - prevTip + num) * 100) / 100;
  } else {
    return { ok: false, error: 'Unknown field.' };
  }
  return { ok: true };
}

function buildUpdatedPrompt(pending) {
  const e = pending.extraction;
  const tipLine = e.tip ? ` (incl. $${e.tip.toFixed(2)} tip)` : '';
  const lines = [
    'Updated!',
    `Store: ${e.store_name || 'Unknown'}`,
    `Date: ${e.purchase_date || 'Unknown'}`,
    `Category: ${e.reward_category || 'Misc'}`,
    `Total: $${e.total_amount ?? '?'}${tipLine}`,
  ];
  if (e.payment_method) lines.push(`Card: ${e.payment_method}`);
  if (e.booking_method) lines.push(`Booking: Direct (4x UR)`);
  lines.push('', 'Reply YES to log, or CANCEL');
  return lines.join('\n');
}

async function getCurrentPending(store, userId) {
  const { blobs } = await store.list({ prefix: `confirm:${userId}:`, limit: 1 });
  if (!blobs || blobs.length === 0) return null;
  const key = blobs[0].key;
  const pending = await store.get(key, { type: 'json' });
  if (!pending) return null;
  return { key, pending };
}

function renderPendingConfirm(ctx, pending) {
  const batchInfo = pending.batchTotal ? { index: pending.batchIndex, total: pending.batchTotal } : undefined;
  return ctx.send(buildConfirmPrompt(pending.extraction, pending.conversionInfo, batchInfo), kbForPending(pending));
}

/** Routes an `edit:*` inline-keyboard callback (the `edit:` prefix is stripped). */
async function handleEditCallback(ctx, rest) {
  const { store, userId } = ctx;

  // ── Logged-expense edits (operate on lastlog) ──
  if (rest === 'last') {
    const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
    if (!lastlog || !lastlog.uuid) return ctx.send('No recent entry to edit.');
    return ctx.send(
      `Edit last entry:\n${lastlog.vendor} · $${lastlog.amount} (${lastlog.category})\n\nWhat do you want to change?`,
      kbEditLoggedMenu()
    );
  }
  if (rest === 'lf:cat') return ctx.send('Pick a category:', kbCategoryPicker(CATEGORIES, 'edit:lastcat'));
  if (rest === 'lf:amt') {
    await store.setJSON(`awaiting_edit:${userId}`, { scope: 'logged', field: 'amount' });
    return ctx.send('Send the new amount (e.g. 52.10):');
  }
  if (rest.startsWith('lastcat:')) {
    const category = CATEGORIES[parseInt(rest.slice('lastcat:'.length), 10)];
    if (!category) return ctx.send('Unknown category.');
    return await editLoggedExpense(ctx, { category });
  }

  // ── Pending-receipt edits (operate on the current confirm blob) ──
  const current = await getCurrentPending(store, userId);
  if (!current) return ctx.send('No pending receipt to edit. Send a receipt image first.');
  const { key, pending } = current;

  if (rest === 'menu') return ctx.send('What do you want to edit?', kbEditMenu());
  if (rest === 'back') return renderPendingConfirm(ctx, pending);
  if (rest === 'f:cat') return ctx.send('Pick a category:', kbCategoryPicker(CATEGORIES, 'edit:setcat'));
  if (rest === 'f:card') {
    let settings = {};
    try { settings = await getUserSettings(); } catch { /* none */ }
    const cards = settings.cards || [];
    if (!cards.length) return ctx.send('No cards configured. Add cards in the dashboard settings first.');
    return ctx.send('Pick a card:', kbCardPicker(cards, 'edit:setcard'));
  }
  if (['f:amt', 'f:store', 'f:date', 'f:tip'].includes(rest)) {
    const field = { 'f:amt': 'amount', 'f:store': 'store', 'f:date': 'date', 'f:tip': 'tip' }[rest];
    await store.setJSON(`awaiting_edit:${userId}`, { scope: 'pending', field });
    const prompts = {
      amount: 'Send the new amount (e.g. 52.10):',
      store:  'Send the new store/vendor name:',
      date:   'Send the new date (YYYY-MM-DD):',
      tip:    'Send the tip amount (e.g. 5.00):',
    };
    return ctx.send(prompts[field]);
  }
  if (rest.startsWith('setcat:')) {
    const category = CATEGORIES[parseInt(rest.slice('setcat:'.length), 10)];
    if (!category) return ctx.send('Unknown category.');
    pending.extraction.reward_category = category;
    await store.setJSON(key, pending);
    return ctx.send(buildUpdatedPrompt(pending), kbForPending(pending));
  }
  if (rest.startsWith('setcard:')) {
    const idx = parseInt(rest.slice('setcard:'.length), 10);
    if (idx === -1) {
      pending.extraction.payment_method = '';
    } else {
      let settings = {};
      try { settings = await getUserSettings(); } catch { /* none */ }
      const card = (settings.cards || [])[idx];
      if (!card) return ctx.send('Unknown card.');
      pending.extraction.payment_method = card;
    }
    await store.setJSON(key, pending);
    return ctx.send(buildUpdatedPrompt(pending), kbForPending(pending));
  }

  return ctx.send('Unknown edit action.');
}

/** Applies a typed value captured for a button-driven field edit. */
async function applyAwaitingEdit(ctx, text, state) {
  const { store, userId } = ctx;
  await store.delete(`awaiting_edit:${userId}`);
  const value = text.trim();

  if (state.scope === 'logged') {
    const num = parseFloat(value.replace(/[$,]/g, ''));
    if (isNaN(num) || num <= 0) {
      await store.setJSON(`awaiting_edit:${userId}`, state);   // keep waiting
      return ctx.send('Invalid amount. Send a positive number (e.g. 52.10), or CANCEL.');
    }
    return await editLoggedExpense(ctx, { amount: num });
  }

  const current = await getCurrentPending(store, userId);
  if (!current) return ctx.send('No pending receipt to edit. Send a receipt image first.');
  const { key, pending } = current;
  const res = await applyExtractionField(pending, state.field, value);
  if (!res.ok) {
    await store.setJSON(`awaiting_edit:${userId}`, state);     // re-prompt
    return ctx.send(`${res.error}\n(or CANCEL)`);
  }
  await store.setJSON(key, pending);
  return ctx.send(buildUpdatedPrompt(pending), kbForPending(pending));
}

/** Edits an already-logged expense by delete + re-append (no in-place update
 *  primitive exists, and a category change moves the row to another sheet tab). */
async function editLoggedExpense(ctx, changes) {
  const { store, userId } = ctx;
  const lastlog = await store.get(`lastlog:${userId}`, { type: 'json' }).catch(() => null);
  if (!lastlog || !lastlog.uuid) return ctx.send('No recent entry to edit.');

  const newCategory = changes.category ?? lastlog.category;
  const newAmount   = changes.amount ?? lastlog.amount;

  try {
    await deleteExpenseByUUID({ category: lastlog.category, uuid: lastlog.uuid, sheetId: lastlog.sheetId });
  } catch (e) {
    await reportError('SHT-004', e, { flow: 'edit' });
    return ctx.send('Could not edit — the entry may have changed. Check the dashboard. [SHT-004]');
  }

  let result;
  try {
    result = await appendExpense({
      category: newCategory, vendor: lastlog.vendor, amount: newAmount,
      txDate: lastlog.txDate, sheetId: lastlog.sheetId, monthName: lastlog.monthName,
      paymentMethod: lastlog.paymentMethod || '', bookingMethod: lastlog.bookingMethod || '',
      channel: ctx.channel,
    });
  } catch (e) {
    await reportError('SHT-009', e, { flow: 'edit' });
    return ctx.send('Edit failed while saving. Check the dashboard. [SHT-009]');
  }

  await store.setJSON(`lastlog:${userId}`, {
    ...lastlog, uuid: result.uuid, category: newCategory, amount: newAmount,
    loggedAt: new Date().toISOString(),
  });

  console.log(`bot-core: EDIT — ${lastlog.vendor} → ${newCategory} $${newAmount} by ${userId}`);
  return ctx.send(`✏️ Updated: ${lastlog.vendor} · $${newAmount} (${newCategory})`, kbLoggedActions());
}

/* ── R8: conversational agent fallback (Haiku, deterministic-first everywhere) ─ */

async function runBotAgent(ctx, text) {
  const { store, userId } = ctx;
  const monthName = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const tools = [
    { name: 'get_month_overview', description: "Get this month's salary, total spent, and per-category budget/spent/remaining.", input_schema: { type: 'object', properties: {} } },
    { name: 'get_recent_expenses', description: 'List the most recent logged expenses.', input_schema: { type: 'object', properties: { count: { type: 'integer', description: 'How many (max 20)' } } } },
    { name: 'log_expense', description: 'Propose logging a new expense; the user is shown a confirmation to approve.', input_schema: { type: 'object', properties: { vendor: { type: 'string' }, amount: { type: 'number' }, category: { type: 'string', enum: CATEGORIES }, card: { type: 'string' } }, required: ['vendor', 'amount', 'category'] } },
    { name: 'set_salary', description: "Set/update this month's salary (asks the user to confirm if one already exists).", input_schema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] } },
    { name: 'set_budget', description: 'Set/update a category budget for this month.', input_schema: { type: 'object', properties: { category: { type: 'string' }, amount: { type: 'number' } }, required: ['category', 'amount'] } },
    { name: 'add_category', description: 'Add a new budget category.', input_schema: { type: 'object', properties: { name: { type: 'string' }, amount: { type: 'number' }, type: { type: 'string', enum: ['need', 'want', 'saving'] } }, required: ['name', 'amount'] } },
    { name: 'delete_last', description: 'Start deleting the most recently logged expense (secure multi-step confirmation).', input_schema: { type: 'object', properties: {} } },
  ];

  const execute = async (name, input) => {
    if (name === 'get_month_overview') {
      const sheetId = await getCurrentMonthSheetId(monthName);
      const t = await getTotals(sheetId);
      const cats = (t.categories || []).map(c => `${c.name}: spent $${(c.spent || 0).toFixed(2)} / budget $${(c.budget || 0).toFixed(2)} (left $${(c.remaining || 0).toFixed(2)})`).join('\n');
      const totalSpent = (t.categories || []).reduce((s, c) => s + (c.spent || 0), 0);
      return `Month: ${monthName}\nSalary: ${t.salary != null ? `$${t.salary}` : 'not set'}\nTotal spent: $${totalSpent.toFixed(2)}\n${cats}`;
    }
    if (name === 'get_recent_expenses') {
      const sheetId = await getCurrentMonthSheetId(monthName);
      const n = Math.min(Math.max(parseInt(input.count) || 5, 1), 20);
      const recent = await getRecentExpenses(sheetId, n);
      if (!recent.length) return 'No recent expenses.';
      return recent.map(r => `${r.txDate || ''} ${r.vendor || 'Unknown'} $${(r.amount || 0).toFixed(2)} (${r.category})`).join('\n');
    }
    if (name === 'log_expense') {
      const category = CATEGORIES.find(c => c.toLowerCase() === String(input.category || '').toLowerCase()) || 'Misc';
      const amount = parseFloat(input.amount);
      if (isNaN(amount) || amount <= 0) return 'Invalid amount.';
      const now = new Date();
      let cardName = '';
      if (input.card) { try { const s = await getUserSettings(); cardName = resolveCardName(input.card, s.cards || []) || ''; } catch { /* none */ } }
      const receiptId = crypto.randomUUID();
      await store.setJSON(`confirm:${userId}:${receiptId}`, {
        id: receiptId, phone: userId,
        extraction: { store_name: String(input.vendor || 'Unknown'), purchase_date: now.toISOString().slice(0, 10), total_amount: amount, tax_amount: null, currency: 'USD', items: [], reward_category: category, payment_method: cardName },
        year: now.getFullYear(), month: now.toLocaleString('en-US', { month: 'long' }), status: 'awaiting_confirmation',
      });
      const lines = ['Got it:', `Store: ${input.vendor}`, `Category: ${category}`, `Total: $${amount}`];
      if (cardName) lines.push(`Card: ${cardName}`);
      lines.push('', 'Reply YES to log, or CANCEL');
      await ctx.send(lines.join('\n'), kbConfirmReceipt());
      return { result: 'Confirmation shown to user.', userNotified: true };
    }
    if (name === 'set_salary')  { await handleSetSalary(ctx, String(input.amount)); return { result: 'Prompted user.', userNotified: true }; }
    if (name === 'set_budget')  { await handleSetBudget(ctx, String(input.category), String(input.amount)); return { result: 'Prompted user.', userNotified: true }; }
    if (name === 'add_category'){ await handleAddCategory(ctx, String(input.name), String(input.amount), (input.type || 'want').toLowerCase()); return { result: 'Prompted user.', userNotified: true }; }
    if (name === 'delete_last') { await handleDelete(ctx, 'last'); return { result: 'Started secure delete.', userNotified: true }; }
    return 'Unknown tool.';
  };

  const system = [
    'You are Fundient, a friendly Telegram assistant for a personal/household budget tracker.',
    'Be concise and warm. Use tools to read data and to take actions — never invent numbers.',
    `Expense categories: ${CATEGORIES.join(', ')}.`,
    'For any money-changing action (log_expense, set_salary, set_budget, add_category, delete_last) the tool already shows the user a confirmation; after calling one, reply with at most a short one-line acknowledgement (or nothing).',
    'For questions, answer directly using get_month_overview / get_recent_expenses.',
  ].join('\n');

  const { text: finalText, acted } = await runToolLoop({ userText: text, system, tools, execute });

  if (finalText && finalText.trim()) {
    await ctx.send(finalText.trim());
    return true;
  }
  return acted;   // a tool already messaged the user → handled; else not handled
}

export { CATEGORIES, DAILY_LIMIT, getRateCount };
