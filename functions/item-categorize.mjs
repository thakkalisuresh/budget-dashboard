/**
 * Cloud Function — categorize receipt line items in one batched LLM call.
 *
 * The split-receipt screen resolves items in three layers: what the user did
 * with this item last time (itemMemory), then the keyword tables, then this.
 * Only the leftovers get here — the genuinely ambiguous ones, which at Costco
 * means abbreviated names no keyword table will ever cover ("KS ORG PNT BTR").
 *
 * ONE call for the whole receipt, not one per item: a 40-item receipt would
 * otherwise be 40 round-trips against a 20-req/min budget, and the model does
 * better seeing the basket together anyway (a "SPINDRIFT" next to twelve
 * groceries is a drink, not a hardware item).
 *
 * The user's own past filings are sent as few-shot examples, so the answer
 * reflects how THEY split things — paper towels under Misc rather than
 * Grocery — instead of a generic shopper's intuition.
 *
 * Answers are advisory. Above CONFIDENCE_THRESHOLD the review screen
 * pre-selects the category; below it the item stays blank and the user picks.
 * Nothing here writes to a sheet.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { ALLOWED_EMAILS, GROQ_API_KEY } from './lib/secrets.mjs';
import { corsOriginFor, hasValidSecFetchSite, sendJson, verifyBearer } from './lib/http-common.mjs';
import { CONFIDENCE_THRESHOLD } from './lib/_categorize.mjs';

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// A long Costco receipt is ~60 lines; the cap is a guard against a malformed
// or hostile body, not a limit the real UI is expected to reach.
const MAX_ITEMS    = 80;
const MAX_EXAMPLES = 20;
const MAX_NAME_LEN = 120;

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
    // LLM-003 — a category outside the list has no tab to write to.
    console.warn('LLM-003 — Category suggestion unusable (item split): off-list category discarded');
  }
  return out;
}

export const itemCategorize = onRequest(
  { region: 'us-central1', secrets: [ALLOWED_EMAILS, GROQ_API_KEY], cors: false },
  async (req, res) => {
    const corsOrigin = corsOriginFor(req);

    if (req.method === 'OPTIONS') {
      if (!corsOrigin) { res.status(403).end(); return; }
      res.set({
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.status(204).end();
      return;
    }

    if (!corsOrigin) { sendJson(res, 403, { error: 'Forbidden' }); return; }
    if (!hasValidSecFetchSite(req)) { sendJson(res, 403, { error: 'Forbidden' }, corsOrigin); return; }
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const v = await verifyBearer(req);
    if (!v.ok) { sendJson(res, 401, { error: 'Unauthorized' }, corsOrigin); return; }

    const body = req.body || {};
    const items = (Array.isArray(body.items) ? body.items : [])
      .map(n => String(n ?? '').trim().slice(0, MAX_NAME_LEN))
      .filter(Boolean)
      .slice(0, MAX_ITEMS);
    const categories = (Array.isArray(body.categories) ? body.categories : [])
      .map(c => String(c ?? '').trim())
      .filter(Boolean);
    const examples = (Array.isArray(body.examples) ? body.examples : [])
      .filter(e => e?.name && e?.category)
      .map(e => ({ name: String(e.name).slice(0, MAX_NAME_LEN), category: String(e.category) }))
      .slice(0, MAX_EXAMPLES);

    if (!items.length || !categories.length) {
      sendJson(res, 400, { error: 'items and categories are required' }, corsOrigin);
      return;
    }

    // No key is not an error — the screen simply falls back to asking the user.
    if (!process.env.GROQ_API_KEY) {
      sendJson(res, 200, { results: items.map(() => null), reason: 'unavailable' }, corsOrigin);
      return;
    }

    try {
      const groqRes = await fetch(GROQ_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          // ~25 tokens per {i, category, confidence} triple, plus slack.
          max_tokens: Math.min(4000, 200 + items.length * 30),
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You categorize retail line items for a personal budget. Reply with JSON only.' },
            { role: 'user', content: buildPrompt({ vendor: body.vendor, items, categories, examples }) },
          ],
        }),
      });

      if (!groqRes.ok) {
        const err = await groqRes.json().catch(() => ({}));
        console.warn('LLM-001 — Groq API error (item split):', err?.error?.message || groqRes.status);
        sendJson(res, 200, { results: items.map(() => null), reason: 'llm-error' }, corsOrigin);
        return;
      }

      const data = await groqRes.json();
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw) {
        sendJson(res, 200, { results: items.map(() => null), reason: 'empty' }, corsOrigin);
        return;
      }

      sendJson(res, 200, { results: parseResults(raw, items.length, categories) }, corsOrigin);
    } catch (e) {
      // LLM-004 — degraded, never fatal: the user just picks the categories.
      console.warn('LLM-004 — Item categorization unavailable:', e.message);
      sendJson(res, 200, { results: items.map(() => null), reason: 'error' }, corsOrigin);
    }
  }
);
