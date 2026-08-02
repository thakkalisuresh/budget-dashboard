/**
 * Card → owner mapping, server side.
 *
 * A mirror of `src/cardOwners.js`. Cloud Functions bundle only the `functions`
 * directory, so a backend module cannot import from `src/` — the same
 * constraint that produced the `src/cardRewards.js` ↔ `_card-rewards.mjs` pair.
 * `cardOwnersSync.test.js` pins the two together and fails the moment they
 * disagree, which is the only thing that makes a duplicated table safe.
 *
 * ⚠️ Edit this and `src/cardOwners.js` together.
 *
 * Why the backend needs it at all: `card_owner` is a FROZEN derived field in
 * the warehouse. It is resolved once, at write time, from the card map as it
 * stood then, and stored alongside `card_owner_map_hash`. Re-deriving it at
 * query time would mean reassigning a card in Settings silently rewrote who
 * spent what, retroactively, across every month ever recorded.
 */

// Seed assignment. Editable per-card in Settings (settings.cardOwners).
// Cards not listed here (e.g. 'Cash') are unowned and excluded from the split.
export const DEFAULT_CARD_OWNERS = {
  // Me (Sabarish)
  'American Express Blue Cash Preferred': 'me',
  'Capital One Quicksilver':              'me',
  'Chase Freedom Rise':                   'me',
  'Chase Debit Card - Sabarish':          'me',
  'Chase Bank Account - Sabarish':        'me',
  // Wife (Anu)
  'Chase Sapphire Reserve':   'wife',
  'Bilt Blue Card':           'wife',
  'Chase Freedom Unlimited':  'wife',
  'Chase Debit Card - Anu':   'wife',
  'Chase Bank Account - Anu': 'wife',
};

export const DEFAULT_PEOPLE = { me: 'Sabarish', wife: 'Anu' };

/** Resolve the owner of a card → 'me' | 'wife' | null (unowned/unknown). */
export function ownerForCard(card, cardOwners = DEFAULT_CARD_OWNERS) {
  if (!card) return null;
  const map = cardOwners && typeof cardOwners === 'object' ? cardOwners : DEFAULT_CARD_OWNERS;
  return map[card] || null;
}

/** All card names assigned to a given owner ('me' | 'wife'). */
export function cardsForOwner(owner, cardOwners = DEFAULT_CARD_OWNERS) {
  const map = cardOwners && typeof cardOwners === 'object' ? cardOwners : DEFAULT_CARD_OWNERS;
  return Object.keys(map).filter(card => map[card] === owner);
}

/** Display name for an owner key, falling back to the defaults then the key itself. */
export function ownerLabel(owner, people = DEFAULT_PEOPLE) {
  if (!owner) return 'Unassigned';
  return (people && people[owner]) || DEFAULT_PEOPLE[owner] || owner;
}
