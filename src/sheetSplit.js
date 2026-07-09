import { apiFetch } from './sheetApi.js';
import { DEFAULT_CARD_OWNERS, DEFAULT_PEOPLE, cardsForOwner } from './cardOwners.js';

const SPLIT_SHEET = 'By Person';

// Session cache keyed by sheetId → owner signature. A changed owner map or
// renamed person re-writes the formulas; an unchanged one is a no-op.
const _splitReady = new Map();

// Escape regex metacharacters so card names are matched literally inside the
// Google Sheets QUERY `MATCHES` (RE2) alternation.
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build an anchored alternation of a person's cards. MATCHES is a full-string
// match, so 'A|B' matches exactly card A or card B. Empty → a token that never
// matches any real card name.
export function ownerRegex(cards) {
  if (!cards.length) return '__no_cards__';
  return cards.map(escapeRe).join('|');
}

// Excludes deleted / renamed / edited / undo audit rows — same filter the Cards
// Summary tab uses, so totals reflect live spend only.
const EXCLUDE_ACTIONS = "NOT B MATCHES '(?i).*(delet|renam|undo|edited).*'";

const totalFormula = (re) =>
  `=IFERROR(SUM(QUERY(History!A:K,"SELECT E WHERE K MATCHES '${re}' AND ${EXCLUDE_ACTIONS}",0)),0)`;

const categoryFormula = (re) =>
  `=IFERROR(QUERY(History!A:K,"SELECT C, SUM(E) WHERE K MATCHES '${re}' AND ${EXCLUDE_ACTIONS} GROUP BY C ORDER BY SUM(E) DESC LABEL C 'Category', SUM(E) 'Spend'"),{"No spending yet",""})`;

/**
 * Ensure the per-month "By Person" tab exists and reflects the current
 * card→owner map. Left column = you, right column = your wife, derived live
 * from each transaction's payment method (col K of History). No backfill needed.
 *
 * Idempotent and cheap to call on every Split-tab open; mirrors
 * ensureCardsSummarySheet().
 */
export async function ensurePersonSplitSheet(
  sheetId,
  accessToken,
  cardOwners = DEFAULT_CARD_OWNERS,
  people = DEFAULT_PEOPLE,
) {
  if (!sheetId || !accessToken) return;

  const meName   = (people && people.me)   || DEFAULT_PEOPLE.me;
  const wifeName = (people && people.wife) || DEFAULT_PEOPLE.wife;
  const meRe   = ownerRegex(cardsForOwner('me', cardOwners));
  const wifeRe = ownerRegex(cardsForOwner('wife', cardOwners));

  const signature = JSON.stringify([meName, wifeName, meRe, wifeRe]);
  if (_splitReady.get(sheetId) === signature) return;

  const auth = { Authorization: `Bearer ${accessToken}` };
  const authJson = { ...auth, 'Content-Type': 'application/json' };

  // Create the tab if missing
  const meta = await apiFetch(sheetId, '?fields=sheets.properties.title', { headers: auth });
  const exists = (meta.sheets || []).some(s => s.properties?.title === SPLIT_SHEET);
  if (!exists) {
    await apiFetch(sheetId, ':batchUpdate', {
      method: 'POST',
      headers: authJson,
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: SPLIT_SHEET } } }] }),
    });
  }

  // Write/refresh the layout: title, subtitle, totals comparison, and two
  // side-by-side category breakdowns (you on the left, wife on the right).
  const data = [
    { range: `'${SPLIT_SHEET}'!A1`, values: [['By Person — Spending Split']] },
    { range: `'${SPLIT_SHEET}'!A2`, values: [['Auto-updating from History · owner derived from card · excludes edits, deletions & undos']] },
    {
      range: `'${SPLIT_SHEET}'!A4:B6`,
      values: [
        [meName,   totalFormula(meRe)],
        [wifeName, totalFormula(wifeRe)],
        [`Difference (${meName} − ${wifeName})`, '=B4-B5'],
      ],
    },
    { range: `'${SPLIT_SHEET}'!A8`, values: [[`${meName} — by category`]] },
    { range: `'${SPLIT_SHEET}'!D8`, values: [[`${wifeName} — by category`]] },
    { range: `'${SPLIT_SHEET}'!A9`, values: [[categoryFormula(meRe)]] },
    { range: `'${SPLIT_SHEET}'!D9`, values: [[categoryFormula(wifeRe)]] },
  ];

  await apiFetch(sheetId, '/values:batchUpdate', {
    method: 'POST',
    headers: authJson,
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });

  _splitReady.set(sheetId, signature);
}
