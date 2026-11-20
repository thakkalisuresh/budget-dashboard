/**
 * $0 wallet taps: pre-authorization holds whose real amount is never sent.
 *
 * At a gas pump (Costco Gas, most stations) or an EV charger, Wallet reports the
 * tap with a $0 or blank amount: the card is only authorized, and the final total
 * posts a day later. Chase sends no notification for it, so nothing ever brings
 * the real amount back to Fundient. The webhook therefore parks such a tap as
 * `amount_pending:<chat>:<id>` and asks on Telegram; the user's reply (a bare
 * number) completes it here.
 *
 * Completion runs the charge through the same category resolution the webhook
 * uses (smart rules → history → Groq). A confident answer is logged straight
 * away; otherwise the charge becomes an ordinary `category_pending:` blob with a
 * category keyboard, so CATFIX, the daily nudge and CANCEL all work unchanged.
 * It skips the receipt split and the duplicate guard: a person typed the amount.
 */
import { resolveCategory, isFuelVendor } from './_categorize.mjs';
import { CATEGORIES } from './_extraction.mjs';
import { appendExpense, getCurrentMonthSheetId, getRecentExpenses, getUserSettingsByEmail } from './_sheets.mjs';
import { previousMonthName } from './_time.mjs';
import { kbCategoryConfirm } from './_telegram.mjs';
import { tgCategoryPrompt } from './_wallet-messages.mjs';

export const AMOUNT_PENDING_PREFIX = 'amount_pending:';

/** Keyboard under the amount prompt and its daily nudge. */
export function kbAmountPending(id) {
  return [[{ text: "🚫 Don't log this", callback_data: `AMTSKIP:${id}` }]];
}

/**
 * The amount in a reply like "52.18", "$52.18" or "52". Null for anything else,
 * so ordinary messages that happen to contain a number are not swallowed.
 */
export function parseReplyAmount(text) {
  const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d{1,6})(\.\d{1,2})?\s*$/.exec(String(text || ''));
  if (!m) return null;
  const n = Math.round(parseFloat(m[1].replace(/,/g, '') + (m[2] || '')) * 100) / 100;
  return n > 0 ? n : null;
}

/**
 * True for an amount the webhook should treat as a hold: exactly $0, or (on a
 * structured Wallet tap) no amount at all. Negative and unreadable amounts on
 * the raw-text path stay WAL-001 rejections.
 */
export function isZeroHold({ amount, amountRaw, fromRawText }) {
  if (amount === 0) return true;
  const blank = amountRaw === undefined || amountRaw === null || String(amountRaw).trim() === '';
  return !fromRawText && blank;
}

/** The chat's parked holds, oldest first. */
export async function listAmountPending(store, chatId) {
  const { blobs } = await store.list({ prefix: `${AMOUNT_PENDING_PREFIX}${chatId}:` });
  const out = [];
  for (const { key } of blobs || []) {
    const blob = await store.get(key, { type: 'json' }).catch(() => null);
    if (blob) out.push({ key, blob });
  }
  return out.sort((a, b) => String(a.blob.createdAt).localeCompare(String(b.blob.createdAt)));
}

async function historyRows(sheetId, monthName) {
  const [current, previous] = await Promise.all([
    getRecentExpenses(sheetId, 100).catch(() => []),
    (async () => {
      try {
        const prev = previousMonthName(monthName);
        return prev ? await getRecentExpenses(await getCurrentMonthSheetId(prev), 100) : [];
      } catch { return []; }
    })(),
  ]);
  return [...(current || []), ...(previous || [])];
}

/**
 * Finish a parked hold now that the user has said what it cost.
 *
 * Returns { logged: true, category, uuid } when it was written, or
 * { logged: false, category } when it was handed to the category prompt. The
 * amount_pending blob is deleted only once one of those has happened, so a
 * failure leaves the charge waiting and the user can reply again.
 */
export async function completeAmountPending({ store, chatId, key, blob, amount, send }) {
  let settings = {};
  try { settings = (await getUserSettingsByEmail(blob.email)) || {}; }
  catch (e) { console.warn('amount-pending: settings lookup failed', e?.message); }
  const categories = [...CATEGORIES, ...(settings.customCategories || [])];
  const history = await historyRows(blob.sheetId, blob.monthName).catch(() => []);

  const decision = await resolveCategory({
    vendor: blob.vendor,
    amount,
    extractedCategory: blob.extractedCategory || null,
    categories,
    settings,
    history,
    enabled: settings.llmCategorize !== false,
  });

  if (decision.needsConfirm) {
    const id = blob.id;
    await store.setJSON(`category_pending:${chatId}:${id}`, {
      id, vendor: blob.vendor, amount, txDate: blob.txDate, monthName: blob.monthName, sheetId: blob.sheetId,
      paymentMethod: blob.paymentMethod || '',
      suggested: decision.category,
      email: blob.email, source: blob.source,
      createdAt: new Date().toISOString(),
    });
    await store.delete(key);
    await send(
      tgCategoryPrompt({ vendor: blob.vendor, amount, card: blob.paymentMethod, monthName: blob.monthName, suggested: decision.category }),
      kbCategoryConfirm(id, categories, decision.category),
    );
    return { logged: false, category: decision.category };
  }

  const { uuid } = await appendExpense({
    category: decision.category,
    vendor: blob.vendor,
    amount,
    txDate: blob.txDate,
    sheetId: blob.sheetId,
    monthName: blob.monthName,
    paymentMethod: blob.paymentMethod || '',
    channel: 'wallet',
  });
  await store.delete(key);
  return { logged: true, category: decision.category, uuid };
}

export { isFuelVendor };
