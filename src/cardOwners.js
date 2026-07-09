/**
 * Card → owner mapping — splits household spending by person.
 *
 * Each card belongs to exactly one person, so "who spent this" is fully derived
 * from a transaction's payment method (card). No per-transaction tagging needed.
 *
 * Shared by the dashboard Split tab and the per-month "By Person" sheet tab.
 * Owner keys are 'me' | 'wife'; display names live in settings.people and
 * default to DEFAULT_PEOPLE below.
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
