/**
 * Plain-language one-liners for the wallet webhook's JSON `message` field and
 * the Telegram category prompt. Pure string builders — the phone automations
 * show `message` as a banner, so each is a single line that says what happened
 * to the charge (logged / waiting on Telegram / NOT logged).
 */

const usd = (n) => `$${Number(n).toFixed(2)}`;
const onCard = (card) => (card ? ` on ${card}` : '');

const SYMBOLS = { EUR: '€', GBP: '£', INR: '₹' };

/** A native-currency amount: "€16.00", or "16.00 CHF" when there is no symbol we print. */
export const money = (n, currency) =>
  SYMBOLS[currency] ? `${SYMBOLS[currency]}${Number(n).toFixed(2)}` : `${Number(n).toFixed(2)} ${currency}`;

/**
 * " (€16.00 converted at 0.873)" for a charge the webhook converted to USD, else "".
 * The rate is units of the original currency per USD. The result is an ESTIMATE:
 * the bank's own rate and fees differ by a few percent.
 */
export const fxNote = (fx) =>
  fx ? ` (${money(fx.original, fx.currency)} converted at ${Number(fx.rate).toFixed(3)})` : '';

/** "September 2026" → "Sep 2026" */
export const shortMonth = (monthName) => String(monthName || '').replace(/^([A-Za-z]{3})[A-Za-z]*/, '$1');

export const msgWritten = ({ amount, vendor, card, category, monthName, fx }) =>
  `✅ ${usd(amount)} at ${vendor}${fxNote(fx)}${onCard(card)} → ${category}. Added to your ${monthName} budget in Fundient.`;

export const msgWrittenDuplicate = ({ amount, vendor, category, monthName, notified, fx }) =>
  `✅ ${usd(amount)} at ${vendor}${fxNote(fx)} → ${category}, added to ${monthName}. ` +
  `⚠️ Possible duplicate — ${notified ? 'check Telegram' : 'check History → Duplicates'}.`;

export const msgNeedsCategory = ({ amount, vendor, monthName, fx }) =>
  `🤔 ${usd(amount)} at ${vendor}${fxNote(fx)} — I need a category. Pick one on Telegram and I'll add it to ${monthName}.`;

export const msgSplitParked = ({ amount, vendor, fx }) =>
  `🧾 ${usd(amount)} at ${vendor}${fxNote(fx)} — upload the receipt on Telegram to split it, or SKIP to log as one.`;

export const msgDuplicateSkipped = ({ amount, vendor, fx }) =>
  `⏭ ${usd(amount)} at ${vendor}${fxNote(fx)} looks like a duplicate of a charge just logged — skipped. ` +
  `Tap "Log it anyway" on Telegram if it was separate.`;

export const msgUnreadable = (field) => ({
  amount: "⚠️ Couldn't read the amount from that notification — nothing was logged.",
  merchant: "⚠️ Couldn't read the store name from that notification — nothing was logged.",
  email: '⚠️ No account email came with that charge — nothing was logged.',
}[field] || "⚠️ Couldn't read that notification — nothing was logged.");

export const msgNoSheet = (monthName) =>
  `⚠️ No sheet for ${monthName} yet — create the month in Fundient first.`;

export const msgWriteFailed = ({ amount, vendor }) =>
  `❌ Save FAILED — this charge was NOT logged. Re-enter ${usd(amount)} at ${vendor} by hand.`;

/** A foreign charge whose rate could not be looked up: nothing was written. */
export const msgConvertFailed = ({ original, currency }) =>
  `⚠️ Couldn't convert ${money(original, currency)} to dollars — nothing was logged. Add it by hand.`;

export const tgConvertFailed = ({ original, currency, vendor }) =>
  `⚠️ Couldn't convert ${money(original, currency)} at ${vendor} to dollars — not logged. Add it by hand.`;

export const msgVendorDisabled = (vendor) =>
  `ℹ️ ${vendor} is on your ignore list — nothing was logged.`;

export const msgUnauthorized = () =>
  '❌ Fundient rejected the automation key — nothing was logged.';

/** Telegram text for the category-confirm prompt. */
export const tgCategoryPrompt = ({ vendor, amount, card, monthName, suggested, fx }) =>
  `🤔 Categorize this charge\n` +
  `${vendor} · ${usd(amount)}${fxNote(fx)}${card ? ` · ${card}` : ''} · ${shortMonth(monthName)}\n` +
  `Best guess: ${suggested}. Tap the right one:`;

/** Telegram text for the "skipped a likely duplicate" note (button: Log it anyway). */
export const tgDuplicateNote = ({ vendor, amount, card, monthName, priorVendor, ageSec, fx }) =>
  `⏭ Skipped a likely duplicate\n` +
  `${vendor} · ${usd(amount)}${fxNote(fx)}${card ? ` · ${card}` : ''} · ${shortMonth(monthName)}\n` +
  `${priorVendor ? `Looks like ${priorVendor} from ${ageSec}s ago. ` : ''}` +
  `Same amount arrived from the same phone within 2 minutes. If it was a separate purchase, tap:`;

/** Daily nudge for a parked category charge (buttons: kbCategoryConfirm, same as the original prompt). */
export const tgCategoryNudge = ({ vendor, amount, card, monthName, txDate, suggested, parkedHours, fromEmail }) =>
  `⏰ Still waiting on a category\n` +
  `${vendor} · ${usd(amount)}${card ? ` · ${card}` : ''} · ${shortMonth(monthName)}${/^\d{4}-/.test(txDate || '') ? ` ${txDate.slice(0, 4)}` : ''} · parked ${parkedHours}h\n` +
  `Best guess: ${suggested}. Tap the right one:` +
  (fromEmail ? `\nFrom ${fromEmail}` : '');

/**
 * Daily nudge for parked split-receipt charges in one chat. `items` must be in
 * the order the SKIP handler picks from (first = the one SKIP acts on).
 */
export const tgSplitNudge = (items) => {
  if (items.length === 1) {
    const [i] = items;
    return `⏰ Still waiting on a receipt\n${i.vendor} · ${usd(i.amount)} · parked ${i.parkedHours}h\n` +
      `Upload the receipt to split it, or tap SKIP to log it as one ${i.category} expense.`;
  }
  return `⏰ Still waiting on ${items.length} receipts\n` +
    items.map(i => `• ${i.vendor} · ${usd(i.amount)} · parked ${i.parkedHours}h`).join('\n') +
    `\nUpload a receipt to split one, or tap SKIP to log as one expense. SKIP logs the first listed; tap again for the next.`;
};
