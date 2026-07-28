/**
 * Card-name resolution, shared by the bot and the wallet webhook.
 *
 * Extracted from _bot-core.mjs so wallet-webhook.mjs can resolve card names
 * without importing that module — _bot-core pulls in the whole Telegram stack,
 * and the wallet path is latency-sensitive (bank push → sheet write).
 *
 * MIRROR: keep in sync with `src/receiptHelpers.js` (resolveCardName +
 * CARD_ALIASES). The frontend can't import from functions/, so the logic is
 * duplicated there deliberately.
 */

export const normCard = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Shorthand → canonical card name, keyed by normalized alias.
 *
 * Only needed for strings the substring matcher provably cannot reach:
 * abbreviations shorter than the 5-char guard ("bcp", "csr"), and issuer
 * variants that share no substring with the canonical name. Plain shortenings
 * like "blue cash preferred" already resolve by containment and are listed
 * only where a wallet notification is known to emit them verbatim.
 */
export const CARD_ALIASES = {
  // American Express Blue Cash Preferred
  bcp: 'American Express Blue Cash Preferred',
  amexbcp: 'American Express Blue Cash Preferred',
  amexbluecash: 'American Express Blue Cash Preferred',
  bluecash: 'American Express Blue Cash Preferred',
  // Chase Sapphire Reserve
  csr: 'Chase Sapphire Reserve',
  // Chase Freedom Unlimited / Rise
  cfu: 'Chase Freedom Unlimited',
  cfr: 'Chase Freedom Rise',
  // Capital One Quicksilver
  c1quicksilver: 'Capital One Quicksilver',
  capitalonequicksilver: 'Capital One Quicksilver',
  // Bilt
  bilt: 'Bilt Blue Card',
  biltmastercard: 'Bilt Blue Card',
};

/**
 * Fuzzy-match a raw card string (Vision output, or a wallet notification
 * title) against the user's known cards. Returns the user's own spelling of
 * the card, or '' when nothing matches confidently.
 *
 * An alias only ever *rewrites the input* — it never invents a card the user
 * doesn't hold. Returning an unheld canonical name would create a brand-new
 * card bucket, which is the same class of bug this function exists to prevent.
 */
export function resolveCardName(raw, cards = []) {
  if (!raw || !cards.length) return '';
  let r = normCard(raw);
  if (!r) return '';

  // Expand a known shorthand before matching, so "BCP" can reach the canonical
  // name it shares no usable substring with.
  if (CARD_ALIASES[r]) r = normCard(CARD_ALIASES[r]);

  for (const c of cards) if (normCard(c) === r) return c;
  // Substring either direction (Vision may return "Sapphire Reserve" for
  // "Chase Sapphire Reserve"). Guard with a min length so short names like
  // "Cash" don't match "...activecash".
  for (const c of cards) {
    const nc = normCard(c);
    if (nc.length >= 5 && r.length >= 5 && (nc.includes(r) || r.includes(nc))) return c;
  }
  return '';
}
