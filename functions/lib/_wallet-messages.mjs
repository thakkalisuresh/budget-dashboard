/**
 * Plain-language one-liners for the wallet webhook's JSON `message` field and
 * the Telegram category prompt. Pure string builders — the phone automations
 * show `message` as a banner, so each is a single line that says what happened
 * to the charge (logged / waiting on Telegram / NOT logged).
 */

const usd = (n) => `$${Number(n).toFixed(2)}`;
const onCard = (card) => (card ? ` on ${card}` : '');

/** "September 2026" → "Sep 2026" */
export const shortMonth = (monthName) => String(monthName || '').replace(/^([A-Za-z]{3})[A-Za-z]*/, '$1');

export const msgWritten = ({ amount, vendor, card, category, monthName }) =>
  `✅ ${usd(amount)} at ${vendor}${onCard(card)} → ${category}. Added to your ${monthName} budget in Fundient.`;

export const msgWrittenDuplicate = ({ amount, vendor, category, monthName, notified }) =>
  `✅ ${usd(amount)} at ${vendor} → ${category}, added to ${monthName}. ` +
  `⚠️ Possible duplicate — ${notified ? 'check Telegram' : 'check History → Duplicates'}.`;

export const msgNeedsCategory = ({ amount, vendor, monthName }) =>
  `🤔 ${usd(amount)} at ${vendor} — I need a category. Pick one on Telegram and I'll add it to ${monthName}.`;

export const msgSplitParked = ({ amount, vendor }) =>
  `🧾 ${usd(amount)} at ${vendor} — upload the receipt on Telegram to split it, or SKIP to log as one.`;

export const msgDuplicateSkipped = ({ amount, vendor }) =>
  `⏭ ${usd(amount)} at ${vendor} looks like a duplicate of a charge just logged — skipped. ` +
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

export const msgVendorDisabled = (vendor) =>
  `ℹ️ ${vendor} is on your ignore list — nothing was logged.`;

export const msgUnauthorized = () =>
  '❌ Fundient rejected the automation key — nothing was logged.';

/** Telegram text for the category-confirm prompt. */
export const tgCategoryPrompt = ({ vendor, amount, card, monthName, suggested }) =>
  `🤔 Categorize this charge\n` +
  `${vendor} · ${usd(amount)}${card ? ` · ${card}` : ''} · ${shortMonth(monthName)}\n` +
  `Best guess: ${suggested}. Tap the right one:`;

/** Telegram text for the "skipped a likely duplicate" note (button: Log it anyway). */
export const tgDuplicateNote = ({ vendor, amount, card, monthName, priorVendor, ageSec }) =>
  `⏭ Skipped a likely duplicate\n` +
  `${vendor} · ${usd(amount)}${card ? ` · ${card}` : ''} · ${shortMonth(monthName)}\n` +
  `${priorVendor ? `Looks like ${priorVendor} from ${ageSec}s ago. ` : ''}` +
  `Same amount arrived from the same phone within 2 minutes. If it was a separate purchase, tap:`;
