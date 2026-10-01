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
  quicksilvercreditcard: 'Capital One Quicksilver', // title of the Capital One app notification
  // Bilt
  bilt: 'Bilt Blue Card',
  biltmastercard: 'Bilt Blue Card',
};

// Notification titles can end in a masked last four: "Quicksilver Credit
// Card…1234", "… ending in 1234", "•••• 1234", "(…1234)", "x1234", "- 1234".
// Strip only a SHORT (3-4 digit) tail behind an explicit mask/separator so
// digits that belong to a card name are never eaten.
const MASK = '(?:…|\\.{2,}|[*•·●]+|\\(\\s*(?:…|\\.{2,}|[*•·●]+|x)?|\\s(?:ending(?:\\s+in)?|x|[-–—]))';
const MASKED_LAST4 = new RegExp(`\\s*${MASK}\\s*\\d{3,4}\\s*\\)?\\s*$`, 'i');
// A title the iOS notification stack truncated: ends in an ellipsis, no digits.
const TRAILING_ELLIPSIS = /\s*(?:…|\.{2,})\s*$/;

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

  // A held name that already equals the raw text wins before any stripping, so
  // a card legitimately named "Visa - 1234" is never mangled.
  for (const c of cards) if (normCard(c) === r) return c;

  // Drop a masked last-four, then a trailing ellipsis (truncated title).
  const str = String(raw);
  const noDigits = str.replace(MASKED_LAST4, '');
  const truncated = TRAILING_ELLIPSIS.test(noDigits);
  r = normCard(noDigits);
  if (!r) return '';

  // Expand a known shorthand before matching, so "BCP" can reach the canonical
  // name it shares no usable substring with.
  if (CARD_ALIASES[r]) r = normCard(CARD_ALIASES[r]);
  else if (truncated && r.length >= 5) {
    // "Quicksilver Credit C…": expand only when exactly one canonical name's
    // alias starts with the text; otherwise fall through to normal matching.
    const targets = new Set(Object.entries(CARD_ALIASES)
      .filter(([k]) => k.startsWith(r)).map(([, v]) => v));
    if (targets.size === 1) r = normCard([...targets][0]);
  }

  for (const c of cards) if (normCard(c) === r) return c;
  // Substring either direction (Vision may return "Sapphire Reserve" for
  // "Chase Sapphire Reserve"). Guard with a min length so short names like
  // "Cash" don't match "...activecash".
  //
  // Never first-wins: two held cards that both fit ("Chase Debit" for
  // "Chase Debit Card - A" and "- B") must not be settled by list order.
  //   * text CONTAINS held card names: the longest unique one wins.
  //   * held names CONTAIN the text: only when exactly one does.
  // Anything ambiguous returns '' and the caller keeps the raw string.
  const contained = [];
  const containing = [];
  for (const c of cards) {
    const nc = normCard(c);
    if (nc.length < 5 || r.length < 5) continue;
    if (r.includes(nc)) contained.push({ c, n: nc.length });
    else if (nc.includes(r)) containing.push(c);
  }
  if (contained.length) {
    const max = Math.max(...contained.map(x => x.n));
    const top = contained.filter(x => x.n === max);
    return top.length === 1 ? top[0].c : '';
  }
  return containing.length === 1 ? containing[0] : '';
}
