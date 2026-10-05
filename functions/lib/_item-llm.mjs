/**
 * Batched line-item categorization via Groq.
 *
 * Shared by both surfaces that split a receipt: the dashboard (through the
 * /api/item-categorize HTTP function) and the Telegram bot (directly). One
 * prompt, one parser, one confidence rule — a second copy would drift, and the
 * two surfaces would start disagreeing about the same receipt.
 *
 * ONE call for the whole receipt, not one per item: a 40-item receipt would
 * otherwise be 40 round-trips, and the model does better seeing the basket
 * together anyway (a "SPINDRIFT" among twelve groceries is a drink, not
 * hardware).
 *
 * The user's own past filings go in as few-shot examples, so answers follow how
 * THEY split things — paper towels under Misc rather than Grocery.
 *
 * Never throws. Every failure returns nulls, which both callers read as "ask
 * the user", exactly as before this existed.
 *
 * Files starting with "_" are NOT deployed as standalone functions.
 */
import { CONFIDENCE_THRESHOLD } from './_categorize.mjs';

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// A long Costco receipt is ~60 lines; the caps guard against a malformed or
// hostile payload, not a limit the real flows are expected to reach.
export const MAX_ITEMS    = 80;
export const MAX_EXAMPLES = 20;
export const MAX_NAME_LEN = 120;

function buildPrompt({ vendor, items, categories, examples }) {
  const lines = [
    `A shopper is splitting one ${vendor || 'store'} receipt across budget categories.`,
    `Assign each line item to exactly one of: ${categories.join(', ')}.`,
    '',
  ];

  if (examples.length) {
    lines.push(
      'This shopper has previously filed items from this store like this —',
      'follow their habits, not general convention:',
      ...examples.map(e => `  ${e.name} → ${e.category}`),
      ''
    );
  }

  lines.push(
    'Items (names may be abbreviated store shorthand):',
    ...items.map((it, i) => `  ${i}: ${it}`),
    '',
    'Reply with ONLY this JSON, no markdown and no explanation:',
    '{"results":[{"i":<item number>,"category":"<one of the listed categories>","confidence":<0 to 1>}]}',
    '',
    'Include every item number exactly once.',
    `Use a confidence below ${CONFIDENCE_THRESHOLD} when the abbreviation is unclear or the item`,
    'could plausibly belong to more than one category — a wrong silent answer',
    'costs the shopper a mis-budgeted month, an uncertain one costs them a tap.',
  );

  return lines.join('\n');
}

/** Coerce whatever the model said into answers we can trust, dropping the rest. */
function parseResults(raw, itemCount, categories) {
  const parsed = JSON.parse(raw);
  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const out = new Array(itemCount).fill(null);
  let unknownCategory = false;

  for (const r of results) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 0 || i >= itemCount) continue;
    if (!categories.includes(r?.category)) { unknownCategory = true; continue; }
    const confidence = typeof r.confidence === 'number'
      ? Math.max(0, Math.min(1, r.confidence))
      : 0;
    out[i] = { category: r.category, confidence };
  }

  if (unknownCategory) {
    // LLM-003 — a category outside the list has no sheet tab to write to.
    console.warn('LLM-003 — Category suggestion unusable (item split): off-list category discarded');
  }
  return out;
}

/** Trim and cap the caller's input into what the prompt can safely carry. */
export function sanitizeItemInput({ items, categories, examples }) {
  return {
    items: (Array.isArray(items) ? items : [])
      .map(n => String(n ?? '').trim().slice(0, MAX_NAME_LEN))
      .filter(Boolean)
      .slice(0, MAX_ITEMS),
    categories: (Array.isArray(categories) ? categories : [])
      .map(c => String(c ?? '').trim())
      .filter(Boolean),
    examples: (Array.isArray(examples) ? examples : [])
      .filter(e => e?.name && e?.category)
      .map(e => ({ name: String(e.name).slice(0, MAX_NAME_LEN), category: String(e.category) }))
      .slice(0, MAX_EXAMPLES),
  };
}

/**
 * @param items  array of item-name strings (already sanitized, or not — this
 *               sanitizes again defensively for direct callers like the bot)
 * @returns {{ results: Array<{category, confidence}|null>, reason?: string }}
 *          `results` is always the same length as the sanitized item list.
 */
export async function categorizeItemsBatch({ vendor, items, categories, examples = [], fetchImpl = fetch }) {
  const clean = sanitizeItemInput({ items, categories, examples });
  const none = (reason) => ({ results: clean.items.map(() => null), reason });

  if (!clean.items.length || !clean.categories.length) return none('empty-input');
  // No key is not an error — the caller simply falls back to asking the user.
  if (!process.env.GROQ_API_KEY) return none('unavailable');

  try {
    const res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        // ~25 tokens per {i, category, confidence} triple, plus slack.
        max_tokens: Math.min(4000, 200 + clean.items.length * 30),
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You categorize retail line items for a personal budget. Reply with JSON only.' },
          { role: 'user', content: buildPrompt({ vendor, ...clean }) },
        ],
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('LLM-001 — Groq API error (item split):', err?.error?.message || res.status);
      return none('llm-error');
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim();
    if (!raw) return none('empty');

    return { results: parseResults(raw, clean.items.length, clean.categories) };
  } catch (e) {
    // LLM-004 — degraded, never fatal: the user just picks the categories.
    console.warn('LLM-004 — Item categorization unavailable:', e.message);
    return none('error');
  }
}
