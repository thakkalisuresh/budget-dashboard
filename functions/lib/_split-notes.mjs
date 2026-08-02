// ════════════════════════════════════════════════════════════════════════════
// _split-notes.mjs — MIRROR of src/splitNotes.js. Keep the two byte-identical
// below this banner; splitNotes.test.js fails the moment they diverge.
//
// Cloud Functions can't import client modules, and both surfaces split receipts:
// the dashboard scanner (useReceiptScanner) and the Telegram bot (_bot-core).
// A note written by one under a key the other doesn't build is invisible rather
// than broken — which is exactly how the bot shipped without notes at all.
//
// record which line items went into each half of a split receipt.
//
// A Costco or Amazon receipt gets split across categories: some items are
// Grocery, some Misc, some Health. Once split, each resulting transaction is
// just a vendor and a total — "Costco $84.12" tells you nothing about why that
// category got that much. categorizeItems() already tracks the per-category item
// lists; the scanner used to throw them away and keep only the subtotal. These
// helpers turn them into a note attached to each written transaction.
//
// Size matters here. Notes are stored inside the settings JSON, which is written
// as a SINGLE spreadsheet cell (Sheets caps a cell at 50,000 characters), and
// nothing garbage-collects old notes. A 40-item Costco receipt every week would
// grow that cell without bound, and blowing the cap fails the entire settings
// save — including unrelated settings. Hence the caps below.
// ════════════════════════════════════════════════════════════════════════════

/** Items listed in full before collapsing to a "+N more" tail. */
export const MAX_LISTED_ITEMS = 10;

/** Hard ceiling on a single note, characters. */
export const MAX_NOTE_CHARS = 500;

/** Tag applied to every split-derived transaction, so they're filterable. */
export const SPLIT_TAG = 'split';

/**
 * Merge auto-categorized groups with the items the user assigned by hand into
 * one { category: [{name, amount}] } map.
 *
 * @param autoGrouped     [{ category, items: [{name, amount}], subtotal }]
 * @param assignedItems   [{ name, amount, category }] — category may be '' if unassigned
 */
export function buildCategoryItems(autoGrouped = [], assignedItems = []) {
  const byCategory = {};

  for (const g of autoGrouped) {
    if (!g?.category) continue;
    byCategory[g.category] = [...(g.items || []).map(i => ({ name: i.name, amount: i.amount }))];
  }

  for (const item of assignedItems) {
    if (!item?.category) continue;   // still unassigned — the save is blocked anyway
    (byCategory[item.category] ||= []).push({ name: item.name, amount: item.amount });
  }

  return byCategory;
}

function formatItem(item, currencySymbol) {
  const name = String(item?.name ?? '').trim() || 'Item';
  const amt  = Number(item?.amount);
  return Number.isFinite(amt) ? `${name} ${currencySymbol}${amt.toFixed(2)}` : name;
}

/**
 * Human-readable note for one category's share of a split receipt.
 *
 * `remainder` is the tax/fees/discount left over after the line items, which the
 * scanner folds into the largest category so the split sums to the receipt total.
 * It is labelled separately rather than silently inflating an item's amount —
 * otherwise the note would claim a price the receipt never showed.
 *
 * @returns { note, tags } ready to store, or null when there's nothing to say
 */
export function buildSplitNote(items = [], { remainder = 0, currencySymbol = '$' } = {}) {
  const usable = items.filter(i => i && (i.name || Number.isFinite(Number(i.amount))));
  const hasRemainder = Math.abs(Number(remainder) || 0) >= 0.01;

  if (usable.length === 0 && !hasRemainder) return null;

  const listed = usable.slice(0, MAX_LISTED_ITEMS).map(i => formatItem(i, currencySymbol));
  const hidden = usable.length - listed.length;

  const parts = [];
  if (usable.length > 0) {
    parts.push(`${usable.length} item${usable.length === 1 ? '' : 's'}: ${listed.join(', ')}`);
    if (hidden > 0) parts.push(`+${hidden} more`);
  }
  if (hasRemainder) {
    const r = Number(remainder);
    parts.push(`Tax/fees ${r < 0 ? '-' : '+'}${currencySymbol}${Math.abs(r).toFixed(2)}`);
  }

  let note = parts.join(' · ');
  if (note.length > MAX_NOTE_CHARS) note = `${note.slice(0, MAX_NOTE_CHARS - 1)}…`;

  return { note, tags: [SPLIT_TAG] };
}

/**
 * Rough size of the settings blob, so a caller can warn before it approaches the
 * 50,000-character cell ceiling rather than discovering it as a failed save.
 */
export const SETTINGS_SIZE_WARN_CHARS = 40000;

export function shouldWarnSettingsSize(serializedLength) {
  return Number(serializedLength) > SETTINGS_SIZE_WARN_CHARS;
}
