/**
 * Several expenses in one message: "walgreens 53.11 and shell 40, plus 25 at chipotle".
 *
 * Parsing and classification only — this module never touches the sheet. It sorts
 * the parsed items into the ones that can be written as-is and the ones that need
 * a question first, so the caller can honour the governing rule:
 *
 *   **Ambiguity blocks only the items it touches.** Clean items are written
 *   immediately; write-first is not suspended just because the message had three
 *   expenses in it.
 *
 * A question is raised only where guessing would write a wrong NUMBER. A shaky
 * category or a suspected repeat of an older row are fixable labels, so they ride
 * the normal post-write enrichment and Undo instead of stopping anything.
 *
 * Files starting with "_" are NOT deployed as standalone functions.
 */

/** Amount agreement tolerance, in dollars — matches the duplicate matcher's. */
const TOTAL_EPSILON = 0.05;

/** Upper bound on items per message: each write is a Sheets read + PUT + history
 *  append, inside a 120s webhook. */
export const MAX_ITEMS = 10;

/**
 * Split a message into candidate expense clauses.
 *
 * Only separators that people actually use to list purchases — a comma, "and",
 * "plus", "&", a semicolon. Deliberately NOT the word "at" or "for", which sit
 * *inside* one clause ("40 at shell").
 */
export function splitExpenseSegments(text) {
  return String(text || '')
    .split(/\s*(?:,|;|\+|&|\band\b|\bplus\b|\balso\b)\s*/i)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * A stated overall total, as in "spent 100 today: walgreens 53, shell 40".
 * Recognised only when it is introduced as a total — a bare leading number is
 * far more likely to be the first item's amount than a grand total.
 *
 * Returns { amount, span }; the span is stripped before segmenting, or the total
 * itself parses as an extra item and inflates the sum it is meant to check.
 */
export function extractStatedTotal(text, parseAmount) {
  const m = String(text || '').match(/\b(?:total|altogether|in all|spent|paid)\s*(?:of|was|:)?\s*(\$?\s*\d+(?:\.\d{1,2})?)\s*(?::|—|-|\bon\b|\bfor\b)/i);
  if (!m) return null;
  const parsed = parseAmount(m[1]);
  return parsed ? { amount: parsed.amount, span: m[0] } : null;
}

/**
 * Is this message worth treating as several expenses rather than one?
 *
 * Requires at least two clauses that each look like they carry an expense, so
 * "add shell 40" and "thanks, that helps" both stay out.
 */
export function looksLikeMultiExpense(text, parseOne) {
  const segments = splitExpenseSegments(text);
  if (segments.length < 2) return false;
  const informative = segments.filter(s => {
    const p = parseOne(s);
    return p.vendor || p.amount != null;
  });
  if (informative.length < 2) return false;
  // At least one real amount somewhere, or there is nothing to log.
  return segments.some(s => parseOne(s).amount != null);
}

/**
 * Parse a message into items. Each item keeps its own vendor/amount/date; a null
 * means "not stated", never a default.
 */
export function parseMultiExpense(text, parseOne, parseAmount) {
  const total = extractStatedTotal(text, parseAmount);
  const body  = total ? String(text).replace(total.span, ' ') : text;
  const segments = splitExpenseSegments(body).slice(0, MAX_ITEMS + 1);
  const items = segments.map((segment, i) => {
    const p = parseOne(segment);
    return {
      idx: i,
      segment,
      vendor: p.vendor,
      amount: p.amount,
      date: p.date,
      explicitDate: p.explicitDate,
    };
  }).filter(it => it.vendor || it.amount != null);

  return {
    items: items.slice(0, MAX_ITEMS),
    overflow: Math.max(items.length - MAX_ITEMS, 0),
    statedTotal: total ? total.amount : null,
  };
}

/**
 * Sort parsed items into what can be written now and what needs asking about.
 *
 * Question types, all of which would otherwise write a wrong number:
 *   D2  one amount, several vendors — "walgreens and shell 93"
 *   D1  an item missing its amount, or an amount with no vendor
 *   D4  the same vendor and amount twice in one message
 *   D3  a stated total that disagrees with the items
 *
 * D2 is checked before D1 because they describe the same symptom from different
 * angles: with exactly one amount across several vendors, asking "how much at
 * walgreens?" for each in turn misses that the user may have meant one charge.
 */
export function classifyMulti({ items, statedTotal }) {
  const ready = [];
  const questions = [];

  const withAmount = items.filter(i => i.amount != null);
  const named      = items.filter(i => i.vendor);

  // ── D2: one amount, several vendors ──
  // Only when the amount trails the list ("walgreens and shell 93"), which in
  // English can cover all of them. A leading amount belongs to its own item
  // ("walgreens 53.11 and shell" = Walgreens cost 53.11, Shell unknown), and that
  // is an ordinary D1 about Shell — not an ambiguity about who paid what.
  const amountIsTrailing = withAmount.length === 1 && withAmount[0] === items[items.length - 1];
  if (withAmount.length === 1 && amountIsTrailing && named.length >= 2 && items.every(i => i.vendor)) {
    return {
      ready: [],
      questions: [{
        type: 'D2',
        amount: withAmount[0].amount,
        vendors: named.map(i => i.vendor),
        items,
      }],
    };
  }

  for (const item of items) {
    // ── D1: one half of the mandatory minimum is missing ──
    if (item.amount == null) { questions.push({ type: 'D1', missing: 'amount', item }); continue; }
    if (!item.vendor)        { questions.push({ type: 'D1', missing: 'vendor', item }); continue; }
    ready.push(item);
  }

  // ── D4: the same purchase listed twice ──
  const seen = new Map();
  const deduped = [];
  for (const item of ready) {
    const key = `${item.vendor.toLowerCase()}|${item.amount.toFixed(2)}`;
    if (seen.has(key)) {
      questions.push({ type: 'D4', item, twin: seen.get(key) });
      continue;                       // held out of `ready` until the user rules
    }
    seen.set(key, item);
    deduped.push(item);
  }

  // ── D3: the stated total disagrees with the items ──
  if (statedTotal != null && deduped.length && !questions.some(q => q.type === 'D1')) {
    const sum = deduped.reduce((s, i) => s + i.amount, 0);
    const gap = Math.round((statedTotal - sum) * 100) / 100;
    if (Math.abs(gap) >= TOTAL_EPSILON) {
      return { ready: [], questions: [{ type: 'D3', statedTotal, sum: Math.round(sum * 100) / 100, gap, items: deduped }, ...questions] };
    }
  }

  return { ready: deduped, questions };
}

/** Spread a shortfall across items in proportion to their share of the sum. */
export function distributeGap(items, gap) {
  const sum = items.reduce((s, i) => s + i.amount, 0);
  if (!sum) return items;
  let allocated = 0;
  return items.map((item, i) => {
    // Last item absorbs the rounding remainder so the parts always re-sum exactly.
    const share = i === items.length - 1
      ? Math.round((gap - allocated) * 100) / 100
      : Math.round((gap * (item.amount / sum)) * 100) / 100;
    allocated += share;
    return { ...item, amount: Math.round((item.amount + share) * 100) / 100 };
  });
}
