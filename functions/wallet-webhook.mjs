/**
 * Cloud Function — wallet webhook for iOS Shortcuts / Android Automate (LlamaLab).
 * Receives transaction data from mobile automations triggered by bank
 * push notifications after wallet payments (Apple/Google/Samsung Wallet).
 * Categorizes (smart rules → Groq → extractor), writes to Google Sheets, and confirms via push.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { currentMonthName, currentMonthYear, monthNameFromDateStr, monthYearFromDateStr, previousMonthName, localToday, dateFromChaseSms } from './lib/_time.mjs';
import webpush from 'web-push';
import crypto from 'node:crypto';
import { extractTransactionText, CATEGORIES } from './lib/_extraction.mjs';
import { resolveCategory } from './lib/_categorize.mjs';
import { findDuplicates } from './lib/_duplicate-match.mjs';
import { appendExpense, getCurrentMonthSheetId, getUserSettingsByEmail, getRecentExpenses } from './lib/_sheets.mjs';
import { getDb } from './lib/firestore.mjs';
import { createBotStore } from './lib/bot-store.mjs';
import { sendMessage, kbCategoryConfirm } from './lib/_telegram.mjs';
import { resolvePromptChatId } from './lib/_household.mjs';
import {
  msgWritten, msgWrittenDuplicate, msgNeedsCategory, msgSplitParked, msgUnreadable,
  msgNoSheet, msgWriteFailed, msgVendorDisabled, msgUnauthorized, tgCategoryPrompt,
  msgDuplicateSkipped, tgDuplicateNote, msgConvertFailed, tgConvertFailed, fxNote,
} from './lib/_wallet-messages.mjs';
import { matchesSplitVendor } from './lib/_item-categorizer.mjs';
import { resolveCardName, normCard } from './lib/_card-resolver.mjs';
import { sha256Hex } from './lib/http-common.mjs';
import { convertToUSD } from './lib/_currency.mjs';
import { reportError } from './lib/_error-log.mjs';
import { recordActivity } from './lib/_wallet-activity.mjs';
import { withErrorContext, setActor, trail } from './lib/_error-context.mjs';
import {
  WALLET_WEBHOOK_SECRET,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
  ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP,
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

const CURRENCY_SYMBOLS = { '€': 'EUR', '£': 'GBP', '₹': 'INR' };

/**
 * The currency a structured `amount` string is written in, or null when it says
 * nothing (a bare number, "$" and "USD" all mean dollars). "€16.00" → EUR,
 * "16.00 EUR" / "EUR 16.00" → EUR. Only an upper-case three-letter token counts
 * as a code, and only next to a digit, so words in a malformed amount are not
 * mistaken for one.
 */
function detectCurrency(amountRaw) {
  if (typeof amountRaw !== 'string' || !/\d/.test(amountRaw)) return null;
  for (const [sym, code] of Object.entries(CURRENCY_SYMBOLS)) if (amountRaw.includes(sym)) return code;
  return /(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/.exec(amountRaw)?.[1] ?? null;
}

// Same exact-cents charge from the same email inside this window is one purchase.
const DUP_WINDOW_MS = 2 * 60 * 1000;
// Household-level (card + cents) window, wider than the per-email one: her SMS
// can trail the other phone's Wallet tap by more than 2 minutes.
const DUP_CARD_WINDOW_MS = 3 * 60 * 1000;
// A claim that never settled is an abandoned attempt after the function timeout.
const DUP_TAKEOVER_MS = 30 * 1000;
const DUP_BLOB_TTL_MS = 24 * 60 * 60 * 1000;

/** Upper bound on reading sheet history for category lookups; the webhook has 30 s. */
const HISTORY_READ_MS = 6000;

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Last month's recent rows, or [] when there is no such sheet or the read fails. */
async function getPreviousMonthRows(monthName) {
  try {
    const prev = previousMonthName(monthName);
    if (!prev) return [];
    return (await getRecentExpenses(await getCurrentMonthSheetId(prev), 100)) || [];
  } catch {
    return [];
  }
}

/**
 * Park the skipped charge, then tell the household primary's chat with a
 * "Log it anyway" button. Park FIRST (opposite of the category prompt): there is
 * no fall-through-to-write here if the send fails, and an unsent blob just
 * expires, whereas a sent button with no blob would be dead. Never throws.
 */
async function notifyDuplicateSkipped({ store, email, source, vendor, amount, card, category, txDate, monthName, sheetId, priorVendor, ageSec, fx, by }) {
  try {
    const chatId = await resolvePromptChatId(email);
    if (!chatId) return;
    const id = crypto.randomUUID().slice(0, 8);
    const now = Date.now();
    await store.setJSON(`dup_skipped:${chatId}:${id}`, {
      id, vendor, amount, category, txDate, monthName, sheetId,
      paymentMethod: card ?? '',
      email, source,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DUP_BLOB_TTL_MS).toISOString(),
    }, { ttlMs: DUP_BLOB_TTL_MS + 60 * 60 * 1000 });
    await sendMessage(
      chatId,
      tgDuplicateNote({ vendor, amount, card, monthName, priorVendor, ageSec, fx, by }),
      [[{ text: '➕ Log it anyway', callback_data: `DUPLOG:${id}` }]]
    );
  } catch (e) {
    await reportError('TG-001', e, { flow: 'dup-skipped-note', vendor, amount });
  }
}

export const walletWebhook = onRequest(
  {
    region: 'us-central1',
    secrets: [
      WALLET_WEBHOOK_SECRET,
      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL,
      ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY,
      TELEGRAM_BOT_TOKEN, TELEGRAM_EMAIL_MAP,
      ...SHEETS_DRIVE_SECRETS,
    ],
    timeoutSeconds: 30,
    cors: false,
  },
  async (req, res) => withErrorContext({ channel: 'wallet' }, async () => {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const key = extractKey(req);
    const secret = process.env.WALLET_WEBHOOK_SECRET;
    if (!key || !secret || !(await keyMatches(key, secret))) {
      res.status(401).json({ ok: false, code: 'AUTH-002', error: 'Unauthorized', message: msgUnauthorized() });
      return;
    }

    let { merchant, card, email } = req.body || {};
    if (email) setActor(email);
    // Heartbeat: the phone is alive whatever this request turns out to be
    // (non-purchase, unparseable, duplicate). Before any parsing so a failure
    // below still counts. Fails open — recordActivity never throws, and the
    // try/catch covers anything else.
    if (typeof email === 'string' && email.includes('@')) {
      try { await recordActivity(email, req.body?.source ?? null); }
      catch (e) { console.warn('wallet-webhook: heartbeat failed', e?.message); }
    }
    // Optional origin tag so we can tell where a charge came from — an iOS
    // Wallet shortcut, an iOS 27 notification automation, an Android SMS reader,
    // etc. Purely diagnostic; the sheet write channel stays 'wallet'.
    const source = typeof req.body?.source === 'string' ? req.body.source.trim().slice(0, 40) : null;
    trail(source ? `charge received (${source})` : 'charge received');
    let amountRaw = req.body?.amount;
    let txDate = req.body?.date || null;

    // Raw-text path (iOS 27 "notification received" trigger, Android notification
    // reader, or a bank email alert): the automation can forward the raw notification
    // text and let the backend's LLM parser pull out the fields, instead of doing
    // fragile per-bank regex on-device. We parse ONCE and reuse the result below for
    // categorization too, so this costs no extra LLM call.
    let parsed = null;
    let amountFromParsed = false;
    const rawText = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (rawText) {
      try {
        const r = await extractTransactionText(rawText, { detectNonPurchase: true });
        if (r.ok && r.data) {
          parsed = r.data;
          // The trigger fires on every bank notification, not just purchases.
          // Skip declines, statements, deposits, refunds quietly: no row, no
          // alert (this is not a failure), and it must come before the
          // merchant/amount checks, which the nulls would trip as WAL-001.
          if (parsed.is_purchase === false) {
            const kind = parsed.non_purchase_kind || 'other';
            console.log(`wallet-webhook: skipped non-purchase notification (${kind})`);
            res.status(200).json({
              ok: true,
              skipped: true,
              reason: 'not_a_purchase',
              kind,
              message: `ℹ️ Not a purchase (${kind}) — nothing was logged.`,
            });
            return;
          }
          if (!merchant && parsed.store_name) merchant = parsed.store_name;
          if ((amountRaw === undefined || amountRaw === null || amountRaw === '') &&
              typeof parsed.total_amount === 'number') {
            amountRaw = parsed.total_amount;
            amountFromParsed = true;
          }
          if (!card && parsed.payment_method) card = parsed.payment_method;
          // The text's own date is Eastern wall-clock; convert it to the
          // household's local date deterministically and prefer it over the
          // model's literal reading (which can land in the next month).
          if (!txDate) txDate = dateFromChaseSms(rawText) || parsed.purchase_date || null;
        }
      } catch (e) {
        await reportError('WAL-003', e, { textLength: rawText.length });
      }
    }

    if (!txDate) txDate = localToday();
    // Amount may arrive with a currency symbol/grouping (e.g. "$1,234.56" from the iOS
    // Transaction trigger). Strip everything except digits, dot and minus before parsing.
    // Rounded once, here, so the sheet write, message, Telegram text, dedup and
    // push all agree (the old Shortcut sends float noise like 17.579999999999998).
    let amount = Math.round(parseFloat(String(amountRaw ?? '').replace(/[^\d.-]/g, '')) * 100) / 100;

    // A rejected request is a charge that never got logged, so it belongs in the
    // digest exactly like WAL-002 below. These three sites returned a bare 400
    // and reported nothing, which was survivable while iOS Shortcuts was the
    // only client — it sends structured fields that rarely fail validation. The
    // Android automation posts raw notification text to an LLM parser, so a
    // rejection here is now a live failure mode, and an unreported one is
    // invisible: no alert, no digest entry, and the charge simply absent.
    const reject = async (field) => {
      const error = `Missing or invalid ${field}`;
      // fromRawText separates "the automation sent the wrong shape" from "the
      // parser could not read a real notification" — different fixes entirely.
      await reportError('WAL-001', new Error(error), {
        field,
        fromRawText: Boolean(rawText),
        textLength: rawText.length,
      });
      res.status(400).json({ ok: false, code: 'WAL-001', error, message: msgUnreadable(field) });
    };

    if (!merchant || typeof merchant !== 'string') {
      await reject('merchant');
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      await reject('amount');
      return;
    }
    if (!email || !email.includes('@')) {
      await reject('email');
      return;
    }

    // Foreign currency: Wallet shows the transaction's NATIVE amount ("€16.00"),
    // so convert to USD here, before rounding-dependent steps, categorization and
    // the duplicate guard, and everything downstream sees dollars. The currency
    // comes from an explicit body field, else from the text parser (only when the
    // amount came from it), else from a symbol/code in a structured amount string.
    const explicitCurrency = typeof req.body?.currency === 'string' ? req.body.currency.trim().toUpperCase() : '';
    const currency = explicitCurrency
      || (amountFromParsed ? String(parsed?.currency || '').toUpperCase() : detectCurrency(amountRaw))
      || 'USD';
    let fx = null;
    if (currency !== 'USD') {
      const original = amount;
      try {
        const r = await convertToUSD(original, currency);
        amount = Math.round(Number(r.amount) * 100) / 100;
        if (!(amount > 0)) throw new Error(`Converted amount is not usable: ${r.amount}`);
        fx = { original, currency, rate: r.rate };
        trail(`converted ${original} ${currency} → ${amount} USD`);
      } catch (e) {
        // Never write a guessed number. Nothing is claimed or logged, so a retry
        // (or the exact USD app notification) can still land later.
        const failedVendor = (parsed?.store_name || merchant).trim();
        await reportError('WAL-008', e, { currency, original, vendor: failedVendor, fromRawText: Boolean(rawText), source });
        try {
          const chatId = await resolvePromptChatId(email);
          if (chatId) await sendMessage(chatId, tgConvertFailed({ original, currency, vendor: failedVendor }));
        } catch (te) {
          console.warn('wallet-webhook: conversion-failure note failed to send', te.message);
        }
        res.status(502).json({
          ok: false, code: 'WAL-008', error: 'currency_conversion_failed',
          message: msgConvertFailed({ original, currency }),
        });
        return;
      }
    }
    const monthName = monthNameFromDateStr(txDate) || currentMonthName();

    // sheetId is optional: if the automation doesn't send one, resolve the
    // current month's sheet from the transaction date. This makes the Shortcut
    // future-proof across month rollovers (e.g. July gets a new sheet) without
    // any change on the phone.
    let sheetId = req.body?.sheetId;
    if (!sheetId || typeof sheetId !== 'string') {
      try {
        sheetId = await getCurrentMonthSheetId(monthName);
      } catch (e) {
        res.status(422).json({ ok: false, code: 'SHT-002', error: 'month_not_found', monthName, message: msgNoSheet(monthName) });
        return;
      }
    }

    let category = 'Misc';
    // Set only when extraction really produced a category. `category` above is a
    // default, and a default must not count as corroboration for Groq's answer.
    let extractedCategory = null;
    let vendor = merchant.trim();
    if (parsed) {
      // Already parsed from raw text above — reuse it (no second LLM call).
      extractedCategory = parsed.reward_category || null;
      category = extractedCategory ?? 'Misc';
      vendor = parsed.store_name || vendor;
    } else {
      try {
        const result = await extractTransactionText(merchant.trim());
        if (result.ok && result.data) {
          extractedCategory = result.data.reward_category || null;
          category = extractedCategory ?? 'Misc';
          vendor = result.data.store_name || vendor;
        }
      } catch (e) {
        await reportError('EXTR-002', e, { vendor });
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
        res.status(200).json({ ok: true, skipped: true, reason: 'vendor_disabled', vendor, message: msgVendorDisabled(vendor) });
        return;
      }
    } catch (e) {
      await reportError('SHT-001', e, { step: 'disabled-vendor check', email });
    }

    // Both sources of `card` are raw: the Android Wallet macro sends the bank
    // notification title verbatim, and the parsed-text path assigns
    // parsed.payment_method as-is. Neither had ever been resolved against the
    // user's card list, so "Blue Cash Preferred" landed in a separate bucket
    // from "American Express Blue Cash Preferred".
    //
    // Fall back to the raw string when nothing matches: an unrecognised card is
    // still better data than a blank, and getUserSettingsByEmail above may have
    // failed, leaving userSettings.cards empty — resolving to '' there would
    // wipe a card name that was perfectly good.
    if (card) {
      card = resolveCardName(card, userSettings.cards || []) || card;
    }

    // ── Category resolution: smart rules → Groq → whatever the extractor said.
    // A confident answer is written straight through, preserving the instant
    // logging this path exists for. An unconfident one is parked and asked
    // about over Telegram rather than guessed at.
    const allCategories = [...CATEGORIES, ...(userSettings.customCategories || [])];
    trail(`resolved card ${card || 'none'}`);

    // The user's own past filings of this vendor settle its category before any
    // LLM guess. This month's rows (also reused by the duplicate check below)
    // plus last month's, so history does not vanish on the 1st. Every failure
    // here fails OPEN to the LLM path, and a slow sheet cannot eat the 30 s budget.
    let recentRows = null;
    let history = [];
    try {
      const [current, previous] = await withTimeout(Promise.all([
        getRecentExpenses(sheetId, 100).catch(e => { console.warn('wallet-webhook: history read failed', e.message); return null; }),
        getPreviousMonthRows(monthName),
      ]), HISTORY_READ_MS);
      recentRows = current;
      history = [...(current || []), ...previous];
    } catch (e) {
      console.warn('wallet-webhook: vendor history unavailable (non-fatal)', e.message);
    }

    const decision = await resolveCategory({
      vendor,
      amount,
      extractedCategory,
      categories: allCategories,
      settings: userSettings,
      history,
      enabled: userSettings.llmCategorize !== false,
    });
    if (decision.category !== category) {
      console.log(`wallet-webhook: category ${category} → ${decision.category} (${decision.source}, conf ${decision.confidence})`);
    }
    category = decision.category;

    // ── Duplicate-source guard. One tap-to-pay can fire two sources (Wallet
    // notification + issuer app, Samsung Wallet + bank SMS). Key = same email +
    // exact cents (2 min), plus a household-level card + cents key (3 min) below
    // for the same charge seen by two phones; merchant strings differ across
    // sources so the vendor only rides along as a hint. The first request claims;
    // a second inside the window is skipped. Placed after category resolution so the skipped blob carries
    // the category, and before park/split/write so a PARKED charge counts too
    // (no second Telegram prompt). Any guard failure fails OPEN.
    const cents = Math.round(amount * 100);
    const claimKey = `wdup:${crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 16)}:${cents}`;
    // Second, household-level key: the same card + cents from ANOTHER phone (the
    // primary's Wallet tap and her Chase SMS for the one Sapphire charge). Vendor
    // is not part of it (the two sources spell it differently); the trailing
    // network word is dropped so "... Visa" equals the bare card name.
    const cardPart = normCard(card).replace(/(visa|mastercard|americanexpress|amex)$/, '');
    const cardKey = cardPart ? `wdup-card:${cardPart}:${cents}` : null;
    let claim = null;
    let cardClaim = null;
    let guardStore = null;
    try {
      guardStore = createBotStore(getDb());
      const r = await guardStore.claimWindow(claimKey, { windowMs: DUP_WINDOW_MS, takeoverMs: DUP_TAKEOVER_MS, vendor });
      let blocked = null;
      if (r.claimed) {
        claim = r;
        if (cardKey) {
          try {
            const c = await guardStore.claimWindow(cardKey, { windowMs: DUP_CARD_WINDOW_MS, takeoverMs: DUP_TAKEOVER_MS, vendor });
            if (c.claimed) {
              cardClaim = c;
            } else {
              // Another phone already has this charge: give our email claim back.
              try { await guardStore.releaseClaim(claimKey, claim.token); }
              catch (e) { await reportError('WAL-005', e, { step: 'release', vendor, amount }); }
              claim = null;
              blocked = { ...c, by: 'card' };
            }
          } catch (e) {
            await reportError('WAL-005', e, { step: 'card-claim', vendor, amount });
          }
        }
      } else {
        blocked = r;
      }
      if (blocked) {
        const ageSec = Math.round(blocked.ageMs / 1000);
        console.log(`wallet-webhook: duplicate_recent${blocked.by ? ` (${blocked.by})` : ''} ${vendor} $${amount} (${ageSec}s after "${blocked.vendor}", vendorMatch=${blocked.vendor.toLowerCase() === vendor.toLowerCase()})`);
        await notifyDuplicateSkipped({ store: guardStore, email, source, vendor, amount, card, category, txDate, monthName, sheetId, priorVendor: blocked.vendor, ageSec, fx, by: blocked.by });
        res.status(200).json({
          ok: true, skipped: true, reason: 'duplicate_recent', vendor, amount,
          message: msgDuplicateSkipped({ amount, vendor, fx }),
        });
        return;
      }
    } catch (e) {
      await reportError('WAL-005', e, { step: 'claim', vendor, amount });
    }
    // Best-effort: bookkeeping trouble must never change the response or drop a charge.
    const settle = async () => {
      for (const [k, c] of [[claimKey, claim], [cardKey, cardClaim]]) {
        if (!c) continue;
        try { await guardStore.settleClaim(k, c.token); }
        catch (e) { await reportError('WAL-005', e, { step: 'settle', vendor, amount }); }
      }
    };
    const release = async () => {
      for (const [k, c] of [[claimKey, claim], [cardKey, cardClaim]]) {
        if (!c) continue;
        try { await guardStore.releaseClaim(k, c.token); }
        catch (e) { await reportError('WAL-005', e, { step: 'release', vendor, amount }); }
      }
    };

    // Set when a prompt was sent but its blob could not be parked; the write
    // below then goes ahead and this follow-up tells the user to ignore the buttons.
    let parkFailNote = null;

    if (decision.needsConfirm) {
      const chatId = await resolvePromptChatId(email);
      if (chatId) {
        // Send FIRST, park after: a failed send then never leaves an orphaned
        // blob for a charge the fall-through below goes on to write.
        let sent = false;
        let store = null;
        let id = null;
        try {
          store = createBotStore(getDb());
          // Short id: callback_data must stay under Telegram's 64-byte limit
          // once the category name is appended.
          id = crypto.randomUUID().slice(0, 8);
          await sendMessage(
            chatId,
            tgCategoryPrompt({ vendor, amount, card, monthName, suggested: decision.category, fx }),
            kbCategoryConfirm(id, allCategories, decision.category)
          );
          sent = true;
        } catch (e) {
          // Falling through logs it with the best guess, which is strictly
          // better than dropping the transaction because Telegram was down.
          console.error('Category confirm prompt failed (logging with best guess):', e.message);
        }
        if (sent) {
          try {
            await store.setJSON(`category_pending:${chatId}:${id}`, {
              id, vendor, amount, txDate, monthName, sheetId,
              paymentMethod: card ?? '',
              suggested: decision.category,
              // Originating account + origin tag, so a later nudge / CATFIX can
              // attribute the charge even though the prompt went to the primary.
              email, source,
              createdAt: new Date().toISOString(),
            });
            await settle();
            res.status(200).json({
              ok: true, pendingCategory: true, vendor, amount,
              message: msgNeedsCategory({ amount, vendor, monthName, fx }),
            });
            return;
          } catch (e) {
            await reportError('TG-001', e, { flow: 'category-park', vendor, amount });
            parkFailNote = `⚠️ Couldn't save that prompt — I'm logging it as ${category} instead.`;
          }
        }
      } else {
        console.warn(`No Telegram mapping for ${email}; logging best-guess category ${category}.`);
      }
    }

    // ── Split-receipt vendor (Costco, Amazon…): don't log a lump sum. Stash the
    // charge and ask the user (via Telegram) to upload the receipt so it can be
    // split by category. Falls back to normal logging if we can't reach them.
    if (matchesSplitVendor(vendor, userSettings.splitReceiptVendors || [])) {
      const chatId = await resolvePromptChatId(email);
      if (chatId) {
        let sent = false;
        let store = null;
        let id = null;
        try {
          store = createBotStore(getDb());
          id = crypto.randomUUID();
          await sendMessage(
            chatId,
            `🧾 ${vendor} charge of $${amount.toFixed(2)}${fxNote(fx)} detected.\n\n` +
            `Upload the receipt photo to split it by category, or tap SKIP to log it as a single ${category} expense.`,
            [[{ text: '⏭ SKIP (log as one expense)', callback_data: 'SKIP' }]]
          );
          sent = true;
        } catch (e) {
          await reportError('TG-001', e, { flow: 'split-prompt', vendor });
        }
        if (sent) {
          try {
            const _my = monthYearFromDateStr(txDate) || currentMonthYear();
            await store.setJSON(`split_pending:${chatId}:${id}`, {
              id,
              vendor, amount, category,
              txDate,
              year: _my.year,
              month: _my.month,
              paymentMethod: card ?? '',
              email, source,
              createdAt: new Date().toISOString(),
            });
            await settle();
            res.status(200).json({
              ok: true, split: true, vendor, amount,
              message: msgSplitParked({ amount, vendor, fx }),
            });
            return;
          } catch (e) {
            await reportError('TG-001', e, { flow: 'split-park', vendor, amount });
            parkFailNote = `⚠️ Couldn't save that prompt — I'm logging it as a single ${category} expense instead.`;
          }
        }
      } else {
        console.warn(`No Telegram mapping for ${email}; logging split vendor normally.`);
      }
    }

    // Duplicate check — notify, don't gate.
    //
    // The bot side blocks duplicates at the confirm prompt because a human is
    // already in the loop there. Nobody is here: this fires off a bank push
    // notification, and holding the charge for a tap would cost exactly the
    // instant logging this path exists for, on top of the category hold added
    // above. So log it and say so; the Duplicates review surface is where it
    // gets resolved. Wrapped separately so a failed check can't stop the write.
    let dupNotice = null;
    try {
      const recent = recentRows ?? await getRecentExpenses(sheetId, 100);
      const dups = findDuplicates(
        recent.map(e => ({ vendor: e.vendor, amount: e.amount, date: e.txDate || e.timestamp, category: e.category })),
        { vendor, amount, date: txDate }
      );
      if (dups.length > 0) {
        const first = dups[0];
        dupNotice =
          `⚠️ Possible duplicate — logged anyway:\n` +
          `${vendor} · $${amount.toFixed(2)}${fxNote(fx)}\n` +
          `Already have ${first.vendor} · $${Number(first.amount).toFixed(2)}` +
          `${first.date ? ` on ${String(first.date).slice(0, 10)}` : ''} (${first.category || 'Misc'}).\n\n` +
          `Open History → Duplicates in the dashboard to remove one.`;
        console.log(`wallet-webhook: ${dups.length} possible duplicate(s) for ${vendor} $${amount}`);
      }
    } catch (e) {
      console.warn('wallet-webhook: duplicate check failed (non-fatal)', e.message);
    }

    trail(`category ${category}`);
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
      // Nothing was written: free the claim so a retry / second source can log.
      await release();
      if (e.message?.includes('No sheet found for month')) {
        res.status(422).json({ ok: false, code: 'SHT-002', error: 'month_not_found', monthName, message: msgNoSheet(monthName) });
        return;
      }
      // WAL-002 is the single most important error in the system: the charge
      // arrived and is now lost unless it's re-entered by hand.
      await reportError('WAL-002', e, { vendor, amount, category, monthName, source });
      res.status(500).json({ ok: false, code: 'WAL-002', error: 'Failed to write transaction', message: msgWriteFailed({ amount, vendor }) });
      return;
    }

    await settle();

    // Only after the write succeeded — warning about a charge that never
    // landed would be worse than not warning at all.
    let dupNotified = false;
    if (dupNotice || parkFailNote) {
      const noteChatId = await resolvePromptChatId(email);
      if (noteChatId) {
        for (const text of [parkFailNote, dupNotice]) {
          if (!text) continue;
          try {
            await sendMessage(noteChatId, text);
            if (text === dupNotice) dupNotified = true;
          } catch (e) {
            console.warn('wallet-webhook: note failed to send', e.message);
          }
        }
      }
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
              body: `Logged $${amount.toFixed(2)} at ${vendor} as ${category}`,
              url: '/',
            })
          );
        }
      } catch (e) {
        if (e.statusCode === 410) {
          await getDb().collection('push_subscriptions').doc(email).delete().catch(() => {});
        }
        await reportError('PUSH-002', e, { vendor });
      }
    }

    res.status(200).json({
      ok: true, category, vendor, amount,
      message: dupNotice
        ? msgWrittenDuplicate({ amount, vendor, category, monthName, notified: dupNotified, fx })
        : msgWritten({ amount, vendor, card, category, monthName, fx }),
    });
  })
);
